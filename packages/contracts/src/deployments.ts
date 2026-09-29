/**
 * Deployment execution state machine.
 *
 * Execution status (this file) is deliberately separate from release state
 * (whether a successful deployment is the application's active release).
 * See docs/deployment-engine.md for the full sequence diagram.
 */
export const DEPLOYMENT_STATUSES = [
  'queued',
  'preparing',
  'cloning',
  'building',
  'starting',
  'checking_health',
  'promoting',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly DeploymentStatus[] = [
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
];

export const ACTIVE_STATUSES: readonly DeploymentStatus[] = DEPLOYMENT_STATUSES.filter(
  (s) => !TERMINAL_STATUSES.includes(s),
);

/** Stages that a running worker can be in (used for timing records). */
export const STAGES = [
  'preparing',
  'cloning',
  'building',
  'starting',
  'checking_health',
  'promoting',
] as const;
export type DeploymentStage = (typeof STAGES)[number];

const T: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  queued: ['preparing', 'canceled', 'failed', 'interrupted'],
  // Rollbacks skip cloning/building and go straight to starting.
  preparing: ['cloning', 'starting', 'failed', 'canceled', 'interrupted'],
  cloning: ['building', 'failed', 'canceled', 'interrupted'],
  building: ['starting', 'failed', 'canceled', 'interrupted'],
  starting: ['checking_health', 'failed', 'canceled', 'interrupted'],
  checking_health: ['promoting', 'failed', 'canceled', 'interrupted'],
  // Once promotion starts the deployment can no longer be canceled: routing
  // may already point at the candidate. It either completes or fails and the
  // previous route is restored.
  promoting: ['succeeded', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
  canceled: [],
  interrupted: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return T[from].includes(to);
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Whether a user cancellation request is still honored in this status. */
export function isCancelable(status: DeploymentStatus): boolean {
  return canTransition(status, 'canceled');
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: DeploymentStatus,
    public readonly to: DeploymentStatus,
  ) {
    super(`Invalid deployment transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const RELEASE_STATES = ['none', 'active', 'superseded'] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export const DEPLOYMENT_TRIGGERS = ['manual', 'push', 'rollback', 'redeploy'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/**
 * Failure categories. The dashboard uses these to explain what went wrong in
 * user terms (clone vs build vs crash vs health vs routing).
 */
export const FAILURE_CATEGORIES = [
  'config_invalid',
  'clone_failed',
  'build_failed',
  'build_timeout',
  'startup_crash',
  'health_check_failed',
  'proxy_promotion_failed',
  'runner_unavailable',
  'release_unavailable',
  'superseded',
  'internal_error',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_EXPLANATIONS: Record<FailureCategory, { title: string; hint: string }> = {
  config_invalid: {
    title: 'Invalid configuration',
    hint: 'Check the build context directory and Dockerfile path. They must exist inside the repository and must not escape it through ".." or symlinks.',
  },
  clone_failed: {
    title: 'Repository could not be cloned',
    hint: 'Verify the repository URL, that the commit still exists, and that the GitHub App still has access to the repository.',
  },
  build_failed: {
    title: 'Docker build failed',
    hint: 'Read the build log from the bottom up. The first failing Dockerfile step is usually the cause.',
  },
  build_timeout: {
    title: 'Build exceeded the time limit',
    hint: 'Reduce build work, use a smaller base image, or raise the platform build timeout.',
  },
  startup_crash: {
    title: 'Container exited during startup',
    hint: 'Open the runtime log for this deployment. The process exited before becoming healthy. Check required environment variables.',
  },
  health_check_failed: {
    title: 'Health check did not pass',
    hint: 'The container must listen on the configured port on 0.0.0.0 (not 127.0.0.1) and answer the health path with a 2xx or 3xx status.',
  },
  proxy_promotion_failed: {
    title: 'Routing could not be switched',
    hint: 'The previous release is still serving traffic. See platform diagnostics for proxy status.',
  },
  runner_unavailable: {
    title: 'Deployment runner unavailable',
    hint: 'The platform could not reach the runner service. Check platform diagnostics.',
  },
  release_unavailable: {
    title: 'Release image no longer available',
    hint: 'The image for this release was removed by retention. Deploy the commit again instead of rolling back.',
  },
  superseded: {
    title: 'Superseded by a newer deployment',
    hint: 'A newer deployment was requested before this one started.',
  },
  internal_error: {
    title: 'Internal platform error',
    hint: 'Check platform diagnostics and the API logs.',
  },
};
