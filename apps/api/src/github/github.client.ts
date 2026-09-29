import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { GithubRepoView } from '@deployforge/contracts';
import type { AppConfig } from '../config/config';

export interface GithubInstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface GithubRepoDetail extends GithubRepoView {
  cloneUrl: string;
}

/**
 * GitHub App operations used by DeployForge. `RealGithubClient` talks to
 * api.github.com; `FixtureGithubClient` is an in-memory stand-in used only by
 * automated tests (GITHUB_MODE=fixture, refused in production).
 */
export interface GithubClient {
  readonly mode: 'real' | 'fixture';
  installUrl(state: string): string;
  /** Exchange an OAuth code from the installation callback for the installation IDs the user can access. */
  userInstallationIds(code: string): Promise<number[]>;
  getInstallation(installationId: number): Promise<GithubInstallationInfo | null>;
  listRepos(installationId: number, page: number, perPage: number): Promise<{ repos: GithubRepoView[]; total: number }>;
  getRepo(installationId: number, repositoryId: number): Promise<GithubRepoDetail | null>;
  listBranches(installationId: number, fullName: string, page: number): Promise<{ names: string[]; hasMore: boolean }>;
  /** Short-lived installation token scoped to one repository, contents:read. Never persisted. */
  repoToken(installationId: number, repositoryId: number): Promise<string>;
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com']);

export class RealGithubClient implements GithubClient {
  readonly mode = 'real' as const;

  constructor(private readonly config: AppConfig) {}

  installUrl(state: string): string {
    return `https://github.com/apps/${encodeURIComponent(this.config.GITHUB_APP_SLUG!)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.GITHUB_APP_ID })).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(this.config.githubPrivateKey!).toString('base64url')}`;
  }

  /** Outbound requests are restricted to GitHub hosts and never follow redirects (SSRF). */
  private async call<T>(url: string, init: RequestInit & { auth: string }): Promise<{ status: number; data: T; headers: Headers }> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`Refusing request to ${u.hostname}`);
    const res = await fetch(u, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'DeployForge',
        authorization: init.auth,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : null) as T;
    if (!res.ok && res.status !== 404) {
      throw new GithubApiError(res.status, (data as { message?: string } | null)?.message ?? `GitHub returned ${res.status}`);
    }
    return { status: res.status, data, headers: res.headers };
  }

  async userInstallationIds(code: string): Promise<number[]> {
    const res = await this.call<{ access_token?: string; error?: string }>('https://github.com/login/oauth/access_token', {
      method: 'POST',
      auth: '',
      body: JSON.stringify({ client_id: this.config.GITHUB_CLIENT_ID, client_secret: this.config.GITHUB_CLIENT_SECRET, code }),
    });
    if (!res.data?.access_token) throw new GithubApiError(400, res.data?.error ?? 'OAuth code exchange failed');
    const ids: number[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.call<{ installations: { id: number }[] }>(`${API}/user/installations?per_page=100&page=${page}`, { auth: `Bearer ${res.data.access_token}` });
      ids.push(...(r.data?.installations ?? []).map((i) => i.id));
      if ((r.data?.installations ?? []).length < 100) break;
    }
    return ids;
  }

  async getInstallation(installationId: number): Promise<GithubInstallationInfo | null> {
    const r = await this.call<{ id: number; account: { login: string; type: string }; suspended_at: string | null }>(`${API}/app/installations/${installationId}`, {
      auth: `Bearer ${this.appJwt()}`,
    });
    if (r.status === 404) return null;
    return { id: r.data.id, accountLogin: r.data.account.login, accountType: r.data.account.type, suspended: !!r.data.suspended_at };
  }

  private async installationToken(installationId: number, body?: unknown): Promise<string> {
    const r = await this.call<{ token: string }>(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${this.appJwt()}`,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404 || !r.data?.token) throw new GithubApiError(404, 'Installation not found or access revoked');
    return r.data.token;
  }

  async listRepos(installationId: number, page: number, perPage: number) {
    const token = await this.installationToken(installationId, { permissions: { metadata: 'read' } });
    const r = await this.call<{ total_count: number; repositories: RawRepo[] }>(`${API}/installation/repositories?per_page=${perPage}&page=${page}`, { auth: `token ${token}` });
    return { repos: (r.data?.repositories ?? []).map(toRepoView), total: r.data?.total_count ?? 0 };
  }

  async getRepo(installationId: number, repositoryId: number): Promise<GithubRepoDetail | null> {
    let token: string;
    try {
      token = await this.installationToken(installationId, { repository_ids: [repositoryId], permissions: { metadata: 'read' } });
    } catch (e) {
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 422)) return null;
      throw e;
    }
    const r = await this.call<RawRepo>(`${API}/repositories/${repositoryId}`, { auth: `token ${token}` });
    if (r.status === 404) return null;
    return { ...toRepoView(r.data), cloneUrl: r.data.clone_url };
  }

  async listBranches(installationId: number, fullName: string, page: number) {
    const token = await this.installationToken(installationId, { permissions: { contents: 'read' } });
    const r = await this.call<{ name: string }[]>(`${API}/repos/${fullName}/branches?per_page=100&page=${page}`, { auth: `token ${token}` });
    const names = (r.data ?? []).map((b) => b.name);
    return { names, hasMore: (r.headers.get('link') ?? '').includes('rel="next"') };
  }

  repoToken(installationId: number, repositoryId: number): Promise<string> {
    return this.installationToken(installationId, { repository_ids: [repositoryId], permissions: { contents: 'read' } });
  }
}

interface RawRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
}

function toRepoView(r: RawRepo): GithubRepoView {
  return { id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url };
}

/**
 * TEST FIXTURE ONLY. Serves installations/repositories from a JSON file
 * (GITHUB_FIXTURE_FILE) so tests can exercise the integration end to end
 * against the local git fixture server without contacting GitHub.
 */
export interface FixtureData {
  installations: {
    id: number;
    accountLogin: string;
    oauthCode: string;
    token: string;
    repos: (GithubRepoView & { cloneUrl: string; branches: string[] })[];
  }[];
}

export class FixtureGithubClient implements GithubClient {
  readonly mode = 'fixture' as const;
  private data: FixtureData;

  constructor(fileOrData: string | FixtureData) {
    this.data = typeof fileOrData === 'string' ? (JSON.parse(readFileSync(fileOrData, 'utf8')) as FixtureData) : fileOrData;
  }

  setData(data: FixtureData): void {
    this.data = data;
  }

  installUrl(state: string): string {
    return `/api/__fixture/github/install?state=${encodeURIComponent(state)}`;
  }

  async userInstallationIds(code: string): Promise<number[]> {
    return this.data.installations.filter((i) => i.oauthCode === code).map((i) => i.id);
  }

  async getInstallation(id: number): Promise<GithubInstallationInfo | null> {
    const i = this.data.installations.find((x) => x.id === id);
    return i ? { id: i.id, accountLogin: i.accountLogin, accountType: 'Organization', suspended: false } : null;
  }

  async listRepos(id: number, page: number, perPage: number) {
    const repos = this.data.installations.find((x) => x.id === id)?.repos ?? [];
    return { repos: repos.slice((page - 1) * perPage, page * perPage).map(({ cloneUrl: _c, branches: _b, ...r }) => r), total: repos.length };
  }

  async getRepo(id: number, repositoryId: number) {
    const r = this.data.installations.find((x) => x.id === id)?.repos.find((x) => x.id === repositoryId);
    if (!r) return null;
    const { branches: _b, ...rest } = r;
    return rest;
  }

  async listBranches(id: number, fullName: string, page: number) {
    const r = this.data.installations.find((x) => x.id === id)?.repos.find((x) => x.fullName === fullName);
    const names = r?.branches ?? [];
    return { names: names.slice((page - 1) * 100, page * 100), hasMore: names.length > page * 100 };
  }

  async repoToken(id: number, repositoryId: number): Promise<string> {
    const i = this.data.installations.find((x) => x.id === id);
    if (!i || !i.repos.some((r) => r.id === repositoryId)) throw new GithubApiError(404, 'Installation not found or access revoked');
    return i.token;
  }
}
