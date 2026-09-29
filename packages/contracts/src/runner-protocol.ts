import { z } from 'zod';

/**
 * DeployForge runner protocol, version 1.
 *
 * Transport: HTTP/1.1 JSON on the private control network. Every request is
 * authenticated with an HMAC-SHA256 signature (see signing.ts). The Go
 * implementation lives in services/runner/internal/protocol and is checked
 * against the JSON fixtures in packages/contracts/fixtures/runner-v1 by tests
 * on both sides, so drift between the two definitions fails CI.
 */
export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_HEADERS = {
  protocol: 'x-deployforge-protocol',
  timestamp: 'x-deployforge-timestamp',
  nonce: 'x-deployforge-nonce',
  signature: 'x-deployforge-signature',
} as const;

export const OWNERSHIP_LABEL_PREFIX = 'io.deployforge.';
export const LABELS = {
  managed: 'io.deployforge.managed',
  workspace: 'io.deployforge.workspace',
  application: 'io.deployforge.application',
  deployment: 'io.deployforge.deployment',
  role: 'io.deployforge.role',
} as const;

const id = z.string().regex(/^[a-z0-9]{8,40}$/, 'invalid id');
const opId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export const runnerErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Whether the control plane may retry the same operation. */
  retryable: z.boolean(),
});
export type RunnerError = z.infer<typeof runnerErrorSchema>;

export const runnerHealthSchema = z.object({
  ok: z.boolean(),
  protocolVersion: z.number().int(),
  runnerVersion: z.string(),
  docker: z.object({ ok: z.boolean(), version: z.string().optional(), error: z.string().optional() }),
  buildx: z.object({ ok: z.boolean(), version: z.string().optional(), error: z.string().optional() }),
  activeBuilds: z.number().int(),
  maxConcurrentBuilds: z.number().int(),
});
export type RunnerHealth = z.infer<typeof runnerHealthSchema>;

export const buildRequestSchema = z.object({
  operationId: opId,
  workspaceId: id,
  applicationId: id,
  deploymentId: id,
  repository: z.object({
    cloneUrl: z.string().url(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** Short-lived credential (GitHub installation token). Never logged or persisted by the runner. */
    auth: z.object({ username: z.string(), token: z.string() }).optional(),
  }),
  contextDir: z.string(),
  dockerfilePath: z.string(),
  /** Non-sensitive build-time variables only. */
  buildArgs: z.record(z.string(), z.string()),
  /** Mounted with BuildKit secret mounts (RUN --mount=type=secret,id=NAME). */
  buildSecrets: z.array(z.object({ id: z.string(), value: z.string() })),
  imageTag: z.string(),
  timeoutSeconds: z.number().int().min(30).max(7200),
  /** Additional strings the runner must redact from logs. */
  redact: z.array(z.string()),
});
export type BuildRequest = z.infer<typeof buildRequestSchema>;

export const OPERATION_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export const logLineSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  stream: z.enum(['stdout', 'stderr', 'system']),
  text: z.string(),
});
export type RunnerLogLine = z.infer<typeof logLineSchema>;

export const buildStatusSchema = z.object({
  operationId: z.string(),
  state: z.enum(OPERATION_STATES),
  phase: z.enum(['queued', 'cloning', 'validating', 'building', 'done']),
  commitSha: z.string().optional(),
  commitMessage: z.string().optional(),
  imageId: z.string().optional(),
  error: runnerErrorSchema.optional(),
  failureKind: z.enum(['clone', 'config', 'build', 'timeout', 'canceled', 'internal']).optional(),
  logs: z.array(logLineSchema),
  nextSeq: z.number().int(),
  logsTruncated: z.boolean(),
});
export type BuildStatus = z.infer<typeof buildStatusSchema>;

export const containerCreateRequestSchema = z.object({
  operationId: opId,
  workspaceId: id,
  applicationId: id,
  deploymentId: id,
  name: z.string().regex(/^df-[a-z0-9-]{3,100}$/),
  image: z.string(),
  env: z.record(z.string(), z.string()),
  port: z.number().int().min(1).max(65535),
  cpuLimit: z.number().min(0.1).max(64),
  memoryLimitMb: z.number().int().min(16),
  pidsLimit: z.number().int().min(16).max(65536),
  securityProfile: z.enum(['standard', 'strict']),
  network: z.string(),
});
export type ContainerCreateRequest = z.infer<typeof containerCreateRequestSchema>;

export const containerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  running: z.boolean(),
  exitCode: z.number().int(),
  oomKilled: z.boolean(),
  restartCount: z.number().int(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  ipAddress: z.string().optional(),
  labels: z.record(z.string(), z.string()),
});
export type ContainerSummary = z.infer<typeof containerSummarySchema>;

export const containerCreateResponseSchema = z.object({
  created: z.boolean(),
  container: containerSummarySchema,
});

export const probeRequestSchema = z.object({
  port: z.number().int().min(1).max(65535),
  path: z.string(),
  timeoutMs: z.number().int().min(100).max(60000),
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const probeResultSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
  durationMs: z.number().int(),
  container: containerSummarySchema,
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const containerStatsSchema = z.object({
  sampledAt: z.string(),
  /** Percent of ONE CPU core (100 = one full core), like `docker stats`. */
  cpuPercent: z.number(),
  onlineCpus: z.number().int(),
  memoryBytes: z.number(),
  memoryLimitBytes: z.number(),
  pids: z.number().int(),
  running: z.boolean(),
  restartCount: z.number().int(),
  startedAt: z.string().optional(),
});
export type ContainerStats = z.infer<typeof containerStatsSchema>;

export const networkEnsureRequestSchema = z.object({
  workspaceId: id,
  applicationId: id,
});
export const networkEnsureResponseSchema = z.object({ name: z.string(), id: z.string() });

export const gitResolveRequestSchema = z.object({
  cloneUrl: z.string().url(),
  branch: z.string(),
  auth: z.object({ username: z.string(), token: z.string() }).optional(),
});
export const gitResolveResponseSchema = z.object({
  commitSha: z.string(),
  found: z.boolean(),
});

export const imageSummarySchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  sizeBytes: z.number(),
  createdAt: z.string(),
  labels: z.record(z.string(), z.string()),
});
export type ImageSummary = z.infer<typeof imageSummarySchema>;
