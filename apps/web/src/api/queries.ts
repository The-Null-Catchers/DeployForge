import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  ApplicationView,
  AuditEventView,
  DeploymentEventView,
  DeploymentSummary,
  DeploymentView,
  DiagnosticsView,
  DomainView,
  EnvView,
  GithubInstallationView,
  GithubRepoView,
  InviteView,
  LogEvent,
  MemberView,
  MetricsView,
  Paginated,
  ProjectView,
  SessionInfo,
  SessionView,
  WorkspaceSummary,
} from '@deployforge/contracts';
import { del, get, patch, post, put } from './client';

export const keys = {
  me: ['me'] as const,
  status: ['status'] as const,
  projects: (ws: string) => ['projects', ws] as const,
  app: (id: string) => ['app', id] as const,
  deployments: (app: string) => ['deployments', app] as const,
  deployment: (id: string) => ['deployment', id] as const,
  events: (id: string) => ['deployment-events', id] as const,
  env: (app: string) => ['env', app] as const,
  domains: (app: string) => ['domains', app] as const,
  metrics: (app: string) => ['metrics', app] as const,
  members: (ws: string) => ['members', ws] as const,
  invites: (ws: string) => ['invites', ws] as const,
  audit: (ws: string, action: string) => ['audit', ws, action] as const,
  installations: (ws: string) => ['installations', ws] as const,
  repos: (inst: string, page: number) => ['repos', inst, page] as const,
  branches: (inst: string, repo: number) => ['branches', inst, repo] as const,
  diagnostics: ['diagnostics'] as const,
  sessions: ['sessions'] as const,
};

export interface InstanceStatus {
  setupRequired: boolean;
  setupTokenRequired: boolean;
  githubEnabled: boolean;
  appsDomain: string;
  tlsMode: string;
  gitExtraAllowedHosts: string[];
  version: string;
}

export const useStatus = () => useQuery({ queryKey: keys.status, queryFn: () => get<InstanceStatus>('/api/auth/status'), staleTime: 60_000 });
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => get<SessionInfo>('/api/auth/me'), retry: false, staleTime: 30_000 });

export const useProjects = (ws: string | undefined) =>
  useQuery({ queryKey: keys.projects(ws ?? ''), queryFn: () => get<ProjectView[]>(`/api/workspaces/${ws}/projects`), enabled: !!ws, refetchInterval: 10_000 });

export const useApp = (id: string | undefined) =>
  useQuery({ queryKey: keys.app(id ?? ''), queryFn: () => get<ApplicationView>(`/api/apps/${id}`), enabled: !!id, refetchInterval: 8_000 });

export type DeploymentRow = DeploymentSummary & { canRollback: boolean; imageAvailable: boolean; pinned: boolean };
export const useDeployments = (app: string | undefined) =>
  useQuery({ queryKey: keys.deployments(app ?? ''), queryFn: () => get<Paginated<DeploymentRow>>(`/api/apps/${app}/deployments`), enabled: !!app, refetchInterval: 5_000 });

export const useDeployment = (id: string | undefined) =>
  useQuery({ queryKey: keys.deployment(id ?? ''), queryFn: () => get<DeploymentView>(`/api/deployments/${id}`), enabled: !!id });

export const useDeploymentEvents = (id: string | undefined) =>
  useQuery({ queryKey: keys.events(id ?? ''), queryFn: () => get<DeploymentEventView[]>(`/api/deployments/${id}/events`), enabled: !!id });

export const useEnv = (app: string | undefined) => useQuery({ queryKey: keys.env(app ?? ''), queryFn: () => get<EnvView>(`/api/apps/${app}/env`), enabled: !!app });
export const useDomains = (app: string | undefined) =>
  useQuery({ queryKey: keys.domains(app ?? ''), queryFn: () => get<DomainView[]>(`/api/apps/${app}/domains`), enabled: !!app });

export const useMetrics = (app: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: keys.metrics(app ?? ''),
    queryFn: () => get<MetricsView | { unavailable: string }>(`/api/apps/${app}/metrics`),
    enabled: !!app && enabled,
    refetchInterval: 10_000,
  });

export const useMembers = (ws: string | undefined) => useQuery({ queryKey: keys.members(ws ?? ''), queryFn: () => get<MemberView[]>(`/api/workspaces/${ws}/members`), enabled: !!ws });
export const useInvites = (ws: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: keys.invites(ws ?? ''), queryFn: () => get<InviteView[]>(`/api/workspaces/${ws}/invites`), enabled: !!ws && enabled });

export const useInstallations = (ws: string | undefined, enabled = true) =>
  useQuery({ queryKey: keys.installations(ws ?? ''), queryFn: () => get<GithubInstallationView[]>(`/api/workspaces/${ws}/github/installations`), enabled: !!ws && enabled });
export const useRepos = (inst: string | undefined, page: number) =>
  useQuery({ queryKey: keys.repos(inst ?? '', page), queryFn: () => get<Paginated<GithubRepoView> & { total: number }>(`/api/github/installations/${inst}/repos?page=${page}`), enabled: !!inst });
export const useBranches = (inst: string | undefined, repo: number | undefined) =>
  useQuery({ queryKey: keys.branches(inst ?? '', repo ?? 0), queryFn: () => get<Paginated<string>>(`/api/github/installations/${inst}/branches?repositoryId=${repo}`), enabled: !!inst && !!repo });

export const useDiagnostics = () => useQuery({ queryKey: keys.diagnostics, queryFn: () => get<DiagnosticsView>('/api/diagnostics'), refetchInterval: 15_000 });
export const useSessions = () => useQuery({ queryKey: keys.sessions, queryFn: () => get<SessionView[]>('/api/auth/sessions') });

export async function fetchAudit(ws: string, action: string, cursor?: string) {
  const q = new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(action ? { action } : {}) });
  return get<Paginated<AuditEventView>>(`/api/workspaces/${ws}/audit?${q}`);
}

export async function fetchLogs(deploymentId: string, after?: string, q?: string) {
  const p = new URLSearchParams({ limit: '5000', ...(after ? { after } : {}), ...(q ? { q } : {}) });
  return get<{ items: LogEvent[]; nextCursor: string | null; truncated: boolean; expired: boolean }>(`/api/deployments/${deploymentId}/logs?${p}`);
}

/** Mutation helper that invalidates the given query keys on success. */
export function useAction<TVars, TResult>(fn: (v: TVars) => Promise<TResult>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
  });
}

export const actions = { del, get, patch, post, put };
export type { WorkspaceSummary };
