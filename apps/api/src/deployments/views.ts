import type {
  ApplicationSummary,
  ApplicationView,
  AppRuntimeState,
  DeploymentStatus,
  DeploymentSummary,
  DeploymentView,
  FailureCategory,
  StageTiming,
} from '@deployforge/contracts';
import { isTerminal } from '@deployforge/contracts';
import type { Application, ConfigRevision, Deployment, DeploymentStage, EnvRevision } from '../generated/prisma/client';
import type { AppConfig } from '../config/config';

export function appUrl(config: AppConfig, slug: string): string {
  const port = config.APPS_PUBLIC_PORT;
  const defaultPort = config.APPS_URL_SCHEME === 'https' ? 443 : 80;
  const suffix = port && port !== defaultPort ? `:${port}` : '';
  return `${config.APPS_URL_SCHEME}://${slug}.${config.APPS_DOMAIN}${suffix}`;
}

export function platformHostname(config: AppConfig, slug: string): string {
  return `${slug}.${config.APPS_DOMAIN}`;
}

export function deploymentSummary(d: Deployment): DeploymentSummary {
  return {
    id: d.id,
    number: d.number,
    status: d.status as DeploymentStatus,
    releaseState: d.releaseState,
    trigger: d.trigger,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

export function deploymentView(
  d: Deployment & {
    stages: DeploymentStage[];
    configRevision: ConfigRevision;
    envRevision: EnvRevision;
    rollbackOf: Deployment | null;
  },
  extras: { actor: { id: string; name: string } | null; previousActive: Deployment | null; activeDeploymentId: string | null },
): DeploymentView {
  const started = d.startedAt?.getTime();
  const finished = d.finishedAt?.getTime();
  const stages: StageTiming[] = d.stages
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((s) => ({
      stage: s.stage,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
      outcome: s.outcome as StageTiming['outcome'],
    }));
  const imageAvailable = !!d.imageId && !d.imagePrunedAt;
  return {
    ...deploymentSummary(d),
    applicationId: d.applicationId,
    workspaceId: d.workspaceId,
    actor: extras.actor,
    branch: d.branch,
    configRevision: d.configRevision.number,
    envRevision: d.envRevision.number,
    imageId: d.imageId,
    containerName: d.containerName,
    failureCategory: (d.failureCategory as FailureCategory | null) ?? null,
    failureStage: d.failureStage,
    errorMessage: d.errorMessage,
    rollbackOf: d.rollbackOf ? { id: d.rollbackOf.id, number: d.rollbackOf.number } : null,
    previousActive: extras.previousActive ? { id: extras.previousActive.id, number: extras.previousActive.number } : null,
    cancelRequested: !!d.cancelRequestedAt,
    imageAvailable,
    pinned: d.pinned,
    canRollback: d.status === 'succeeded' && imageAvailable && extras.activeDeploymentId !== d.id,
    stages,
    startedAt: d.startedAt?.toISOString() ?? null,
    durationMs: started && finished ? finished - started : null,
  };
}

export function runtimeState(app: Application, active: Deployment | null, latest: Deployment | null): AppRuntimeState {
  if (latest && !isTerminal(latest.status as DeploymentStatus)) return 'deploying';
  if (!active) return 'not_deployed';
  if (app.desiredState === 'stopped') return 'stopped';
  if (!app.observedState) return 'running';
  if (app.observedState === 'running') return 'running';
  if (app.observedState === 'unknown') return 'unknown';
  return 'degraded';
}

export function appSummary(config: AppConfig, app: Application, active: Deployment | null, latest: Deployment | null): ApplicationSummary {
  return {
    id: app.id,
    projectId: app.projectId,
    name: app.name,
    slug: app.slug,
    runtimeState: runtimeState(app, active, latest),
    repoFullName: app.repoFullName,
    branch: app.branch,
    url: active ? appUrl(config, app.slug) : null,
    activeDeployment: active ? deploymentSummary(active) : null,
    latestDeployment: latest ? deploymentSummary(latest) : null,
  };
}

export function appView(
  config: AppConfig,
  app: Application,
  active: (Deployment & { configRevision: ConfigRevision; envRevision: EnvRevision }) | null,
  latest: Deployment | null,
  currentConfig: ConfigRevision | null,
  currentEnv: EnvRevision | null,
): ApplicationView {
  return {
    ...appSummary(config, app, active, latest),
    workspaceId: app.workspaceId,
    sourceType: app.sourceType,
    repoUrl: app.repoUrl,
    installationId: app.githubInstallationId,
    repositoryId: app.githubRepositoryId,
    contextDir: app.contextDir,
    dockerfilePath: app.dockerfilePath,
    port: app.port,
    healthCheck: {
      path: app.healthPath,
      timeoutSeconds: app.healthTimeoutSeconds,
      intervalSeconds: app.healthIntervalSeconds,
      startPeriodSeconds: app.healthStartPeriodSeconds,
      retries: app.healthRetries,
    },
    cpuLimit: app.cpuLimit,
    memoryLimitMb: app.memoryLimitMb,
    autoDeploy: app.autoDeploy,
    securityProfile: app.securityProfile as 'standard' | 'strict',
    desiredState: app.desiredState,
    configRevision: currentConfig?.number ?? 0,
    envRevision: currentEnv?.number ?? 0,
    pendingChanges: {
      env: !!active && active.envRevisionId !== app.currentEnvRevisionId,
      config: !!active && active.configRevisionId !== app.currentConfigRevisionId,
    },
    sourceStatus: app.sourceStatus as ApplicationView['sourceStatus'],
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

/** Snapshot stored in ConfigRevision.config. */
export interface ConfigSnapshot {
  sourceType: 'github' | 'public';
  repoUrl: string;
  repoFullName: string;
  githubInstallationId: string | null;
  githubRepositoryId: number | null;
  branch: string;
  contextDir: string;
  dockerfilePath: string;
  port: number;
  healthCheck: { path: string; timeoutSeconds: number; intervalSeconds: number; startPeriodSeconds: number; retries: number };
  cpuLimit: number;
  memoryLimitMb: number;
  securityProfile: 'standard' | 'strict';
}

export function snapshotOf(app: Application): ConfigSnapshot {
  return {
    sourceType: app.sourceType,
    repoUrl: app.repoUrl,
    repoFullName: app.repoFullName,
    githubInstallationId: app.githubInstallationId,
    githubRepositoryId: app.githubRepositoryId,
    branch: app.branch,
    contextDir: app.contextDir,
    dockerfilePath: app.dockerfilePath,
    port: app.port,
    healthCheck: {
      path: app.healthPath,
      timeoutSeconds: app.healthTimeoutSeconds,
      intervalSeconds: app.healthIntervalSeconds,
      startPeriodSeconds: app.healthStartPeriodSeconds,
      retries: app.healthRetries,
    },
    cpuLimit: app.cpuLimit,
    memoryLimitMb: app.memoryLimitMb,
    securityProfile: app.securityProfile as 'standard' | 'strict',
  };
}
