import type { DeploymentStatus, DeploymentTrigger, FailureCategory, ReleaseState } from './deployments';
import type { Permission, Role } from './permissions';
import type { EnvScope, HealthCheckConfig } from './api';

/** Response shapes returned by the public API. Timestamps are ISO-8601 strings. */

export interface UserView {
  id: string;
  email: string;
  name: string;
  isInstanceAdmin: boolean;
  createdAt: string;
}

export interface SessionInfo {
  user: UserView;
  csrfToken?: string;
  sessionId: string;
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  permissions: Permission[];
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  /** Only returned once, at creation time. */
  inviteUrl?: string;
}

export interface ProjectView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: string;
  applications: ApplicationSummary[];
}

export type AppRuntimeState = 'not_deployed' | 'running' | 'stopped' | 'degraded' | 'deploying' | 'unknown';

export interface ApplicationSummary {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  runtimeState: AppRuntimeState;
  repoFullName: string;
  branch: string;
  url: string | null;
  activeDeployment: DeploymentSummary | null;
  latestDeployment: DeploymentSummary | null;
}

export interface ApplicationView extends ApplicationSummary {
  workspaceId: string;
  sourceType: 'github' | 'public';
  repoUrl: string;
  installationId: string | null;
  repositoryId: number | null;
  contextDir: string;
  dockerfilePath: string;
  port: number;
  healthCheck: HealthCheckConfig;
  cpuLimit: number;
  memoryLimitMb: number;
  autoDeploy: boolean;
  securityProfile: 'standard' | 'strict';
  desiredState: 'running' | 'stopped';
  configRevision: number;
  envRevision: number;
  /** True when env or config changed since the active release was deployed. */
  pendingChanges: { env: boolean; config: boolean };
  sourceStatus: 'ok' | 'branch_deleted' | 'access_removed' | 'installation_disconnected';
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentSummary {
  id: string;
  number: number;
  status: DeploymentStatus;
  releaseState: ReleaseState;
  trigger: DeploymentTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StageTiming {
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled';
}

export interface DeploymentView extends DeploymentSummary {
  applicationId: string;
  workspaceId: string;
  actor: { id: string; name: string } | null;
  branch: string | null;
  configRevision: number;
  envRevision: number;
  imageId: string | null;
  containerName: string | null;
  failureCategory: FailureCategory | null;
  failureStage: string | null;
  errorMessage: string | null;
  rollbackOf: { id: string; number: number } | null;
  previousActive: { id: string; number: number } | null;
  cancelRequested: boolean;
  imageAvailable: boolean;
  pinned: boolean;
  canRollback: boolean;
  stages: StageTiming[];
  startedAt: string | null;
  durationMs: number | null;
}

export interface EnvVarView {
  key: string;
  scope: EnvScope;
  secret: boolean;
  /** Present only for non-secret variables. Secret values are never returned. */
  value?: string;
  updatedAt: string;
}

export interface EnvView {
  revision: number;
  activeRevision: number | null;
  vars: EnvVarView[];
}

export type DomainStatus = 'pending_verification' | 'verified' | 'active' | 'error';

export interface DomainView {
  id: string;
  hostname: string;
  kind: 'platform' | 'custom';
  status: DomainStatus;
  verification: { recordName: string; recordType: 'TXT'; recordValue: string } | null;
  dns: { expectedTarget: string; observed: string[]; ok: boolean | null; checkedAt: string | null };
  routing: 'active' | 'inactive';
  tls: 'disabled' | 'internal' | 'automatic';
  lastError: string | null;
  createdAt: string;
}

export interface LogEvent {
  id: string;
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface DeploymentEventView {
  id: string;
  ts: string;
  type: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface MetricsView {
  sampledAt: string;
  sampleIntervalNote: string;
  cpuPercent: number;
  cpuLimitCores: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
  running: boolean;
  uptimeSeconds: number | null;
  restartCount: number;
  health: 'healthy' | 'unhealthy' | 'unknown' | 'stopped';
  latestDeploymentDurationMs: number | null;
}

export interface AuditEventView {
  id: string;
  ts: string;
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

export interface DiagnosticsView {
  checkedAt: string;
  database: { ok: boolean; latencyMs?: number; error?: string };
  redis: { ok: boolean; latencyMs?: number; error?: string };
  queue: { ok: boolean; waiting: number; active: number; delayed: number; failed: number; outboxPending: number };
  runner: { ok: boolean; version?: string; docker?: string; buildx?: string; activeBuilds?: number; maxConcurrentBuilds?: number; error?: string };
  proxy: { ok: boolean; lastSyncAt: string | null; lastError: string | null; routeCount: number };
  reconciler: { lastRunAt: string | null; lastResult: string | null };
  disk: { imageCount: number; imageBytes: number } | null;
}

export interface SessionView {
  id: string;
  kind: 'browser' | 'mobile';
  deviceName: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
}

export interface GithubInstallationView {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
}

export interface GithubRepoView {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  issues?: { path: string; message: string }[];
}
