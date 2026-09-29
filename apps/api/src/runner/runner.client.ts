import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  RUNNER_HEADERS,
  canonicalRequest,
  type BuildRequest,
  type BuildStatus,
  type ContainerCreateRequest,
  type ContainerStats,
  type ContainerSummary,
  type ImageSummary,
  type ProbeRequest,
  type ProbeResult,
  type RunnerHealth,
} from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface RuntimeLogLine {
  ts: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client for the private runner API (protocol v1). All operations are
 * idempotent on the runner side, so transient failures (network errors,
 * 502/503/504, or errors the runner marks retryable) are retried with
 * exponential backoff. Terminal errors (validation, not found, conflicts)
 * surface immediately.
 */
@Injectable()
export class RunnerClient {
  private readonly logger = new Logger('RunnerClient');
  private readonly base: string;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.base = config.RUNNER_URL.replace(/\/$/, '');
  }

  private sign(method: string, pathAndQuery: string, body: string): Record<string, string> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const sig = createHmac('sha256', this.config.RUNNER_SHARED_SECRET).update(canonicalRequest(method, pathAndQuery, ts, nonce, bodyHash)).digest('hex');
    return {
      [RUNNER_HEADERS.protocol]: '1',
      [RUNNER_HEADERS.timestamp]: ts,
      [RUNNER_HEADERS.nonce]: nonce,
      [RUNNER_HEADERS.signature]: `v1=${sig}`,
    };
  }

  async raw(method: string, pathAndQuery: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<Response> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = this.sign(method, pathAndQuery, payload);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(this.base + pathAndQuery, {
      method,
      headers,
      body: body === undefined ? undefined : payload,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { retries?: number; timeoutMs?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 4;
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.raw(method, path, body, opts.timeoutMs);
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : undefined;
        if (res.ok) return json as T;
        const err = (json ?? {}) as { code?: string; message?: string; retryable?: boolean };
        const retryable = res.status >= 502 || (err.retryable === true && res.status !== 404);
        throw new RunnerError(res.status, err.code ?? 'runner_error', err.message ?? `runner returned ${res.status}`, retryable);
      } catch (e) {
        const error =
          e instanceof RunnerError
            ? e
            : new RunnerError(0, 'runner_unreachable', `Runner request failed: ${(e as Error).message}`, true);
        if (!error.retryable || attempt >= retries) throw error;
        attempt++;
        const delay = Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 200);
        this.logger.warn(`runner ${method} ${path} failed (${error.code}); retry ${attempt}/${retries} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  health(): Promise<RunnerHealth> {
    return this.request('GET', '/v1/health', undefined, { retries: 0, timeoutMs: 8000 });
  }

  gitResolve(cloneUrl: string, branch: string, auth?: { username: string; token: string }): Promise<{ commitSha: string; found: boolean }> {
    return this.request('POST', '/v1/git/resolve', { cloneUrl, branch, ...(auth ? { auth } : {}) }, { timeoutMs: 45_000, retries: 2 });
  }

  submitBuild(req: BuildRequest): Promise<BuildStatus> {
    return this.request('POST', '/v1/builds', req);
  }

  buildStatus(operationId: string, after: number): Promise<BuildStatus> {
    return this.request('GET', `/v1/builds/${encodeURIComponent(operationId)}?after=${after}&limit=1000`, undefined, { retries: 3 });
  }

  cancelBuild(operationId: string): Promise<void> {
    return this.request('POST', `/v1/builds/${encodeURIComponent(operationId)}/cancel`, undefined, { retries: 1 });
  }

  ensureNetwork(workspaceId: string, applicationId: string): Promise<{ name: string; id: string }> {
    return this.request('POST', '/v1/networks', { workspaceId, applicationId });
  }

  removeNetwork(applicationId: string): Promise<void> {
    return this.request('DELETE', `/v1/networks/${encodeURIComponent(applicationId)}`);
  }

  listContainers(applicationId?: string): Promise<ContainerSummary[]> {
    return this.request('GET', `/v1/containers${applicationId ? `?applicationId=${encodeURIComponent(applicationId)}` : ''}`);
  }

  createContainer(req: ContainerCreateRequest): Promise<{ created: boolean; container: ContainerSummary }> {
    return this.request('POST', '/v1/containers', req, { timeoutMs: 60_000 });
  }

  inspect(id: string): Promise<ContainerSummary> {
    return this.request('GET', `/v1/containers/${encodeURIComponent(id)}`);
  }

  probe(id: string, req: ProbeRequest): Promise<ProbeResult> {
    return this.request('POST', `/v1/containers/${encodeURIComponent(id)}/probe`, req, { timeoutMs: req.timeoutMs + 10_000, retries: 2 });
  }

  promote(id: string): Promise<ContainerSummary> {
    return this.request('POST', `/v1/containers/${encodeURIComponent(id)}/promote`);
  }

  lifecycle(id: string, action: 'start' | 'stop' | 'restart', timeoutSeconds = 20): Promise<ContainerSummary> {
    return this.request('POST', `/v1/containers/${encodeURIComponent(id)}/${action}`, { timeoutSeconds }, { timeoutMs: (timeoutSeconds + 40) * 1000 });
  }

  async removeContainer(id: string, timeoutSeconds = 20): Promise<void> {
    try {
      await this.request('DELETE', `/v1/containers/${encodeURIComponent(id)}`, { timeoutSeconds }, { timeoutMs: (timeoutSeconds + 40) * 1000 });
    } catch (e) {
      if (e instanceof RunnerError && e.status === 404) return;
      throw e;
    }
  }

  stats(id: string): Promise<ContainerStats> {
    return this.request('GET', `/v1/containers/${encodeURIComponent(id)}/stats`, undefined, { retries: 1, timeoutMs: 15_000 });
  }

  listImages(applicationId?: string): Promise<ImageSummary[]> {
    return this.request('GET', `/v1/images${applicationId ? `?applicationId=${encodeURIComponent(applicationId)}` : ''}`);
  }

  async removeImage(id: string): Promise<void> {
    await this.request('DELETE', `/v1/images/${encodeURIComponent(id)}`, undefined, { retries: 1 });
  }

  /** Stream runtime logs as parsed NDJSON lines. Aborting `signal` ends the stream. */
  async *logs(id: string, opts: { follow: boolean; tail: number; since?: number }, signal?: AbortSignal): AsyncGenerator<RuntimeLogLine> {
    const q = new URLSearchParams({ tail: String(opts.tail), ...(opts.follow ? { follow: '1' } : {}), ...(opts.since ? { since: String(opts.since) } : {}) });
    const res = await this.raw('GET', `/v1/containers/${encodeURIComponent(id)}/logs?${q}`, undefined, opts.follow ? 24 * 3600_000 : 30_000, signal);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new RunnerError(res.status, 'logs_failed', text.slice(0, 200) || `runner returned ${res.status}`, false);
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) yield JSON.parse(line) as RuntimeLogLine;
      }
    }
  }
}
