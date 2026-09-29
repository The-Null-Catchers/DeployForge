import { ExternalLink, GitBranch, GitCommit, Play, RefreshCw, Rocket, Square } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import type { ApplicationView, DeploymentView } from '@deployforge/contracts';
import { errorMessage, post } from '../../api/client';
import { keys, useAction, useApp } from '../../api/queries';
import { useWorkspace } from '../../auth/session';
import { Button, Card, ConfirmDialog, ErrorState, Mono, Notice, RelativeTime, Skeleton, StatusBadge, cn } from '../../components/ui';
import { RuntimeBadge } from '../WorkspaceOverview';

export interface AppContext {
  app: ApplicationView;
  ws: ReturnType<typeof useWorkspace>;
}
export const useAppContext = () => useOutletContext<AppContext>();

const TABS = [
  ['', 'Overview'],
  ['deployments', 'Deployments'],
  ['logs', 'Runtime logs'],
  ['variables', 'Variables'],
  ['domains', 'Domains'],
  ['metrics', 'Metrics'],
  ['settings', 'Settings'],
] as const;

export function DeployButton({ app, ws, label = 'Deploy' }: { app: ApplicationView; ws: string; label?: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const deploy = useAction(() => post<DeploymentView>(`/api/apps/${app.id}/deployments`, {}), [keys.app(app.id), keys.deployments(app.id)]);
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        variant="primary"
        icon={<Rocket className="size-4" />}
        loading={deploy.isPending}
        onClick={async () => {
          setError(null);
          try {
            const d = await deploy.mutateAsync(undefined);
            navigate(`/w/${ws}/apps/${app.id}/deployments/${d.id}`);
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        {label}
      </Button>
      {error && (
        <span role="alert" className="mt-1 max-w-xs text-right text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

function LifecycleActions({ app }: { app: ApplicationView }) {
  const act = useAction((a: 'start' | 'stop' | 'restart') => post(`/api/apps/${app.id}/${a}`), [keys.app(app.id)]);
  if (!app.activeDeployment) return null;
  return (
    <>
      {app.desiredState === 'stopped' ? (
        <Button icon={<Play className="size-4" />} loading={act.isPending} onClick={() => act.mutate('start')}>
          Start
        </Button>
      ) : (
        <ConfirmDialog
          trigger={<Button icon={<Square className="size-4" />}>Stop</Button>}
          title={`Stop ${app.name}?`}
          consequences={<p>The container is stopped and its address answers <Mono>503</Mono> until you start it again. Open connections are closed. Nothing is deleted.</p>}
          confirmLabel="Stop application"
          busy={act.isPending}
          onConfirm={() => act.mutateAsync('stop')}
        />
      )}
      <ConfirmDialog
        trigger={<Button icon={<RefreshCw className="size-4" />}>Restart</Button>}
        title={`Restart ${app.name}?`}
        consequences={<p>The running container restarts. Requests during the restart fail, and in-memory state is lost. Variables changed since the last deployment are <strong>not</strong> applied — deploy to apply them.</p>}
        confirmLabel="Restart"
        danger={false}
        busy={act.isPending}
        onConfirm={() => act.mutateAsync('restart')}
      />
      {act.error && <span className="text-xs text-danger">{errorMessage(act.error)}</span>}
    </>
  );
}

export function AppLayout() {
  const ws = useWorkspace();
  const { appId } = useParams();
  const app = useApp(appId);
  if (app.isLoading) return <Skeleton className="h-40" />;
  if (app.error || !app.data) return <ErrorState error={app.error} retry={() => void app.refetch()} />;
  const a = app.data;
  return (
    <>
      <div className="mb-4 text-sm text-muted">
        <Link to={`/w/${ws.id}`} className="hover:text-fg">
          {ws.name}
        </Link>{' '}
        / <span className="text-fg">{a.name}</span>
      </div>
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight">{a.name}</h1>
            <RuntimeBadge state={a.runtimeState} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="flex items-center gap-1">
              <GitBranch className="size-3.5" aria-hidden /> <Mono>{a.repoFullName}</Mono> · <Mono>{a.branch}</Mono>
            </span>
            {a.url && (
              <a href={a.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 hover:text-fg">
                <Mono>{a.url.replace(/^https?:\/\//, '')}</Mono> <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ws.can('app.lifecycle') && <LifecycleActions app={a} />}
          {ws.can('deployment.create') && <DeployButton app={a} ws={ws.id} />}
        </div>
      </div>
      <nav aria-label="Application sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map(([path, label]) => (
          <NavLink
            key={path}
            to={`/w/${ws.id}/apps/${a.id}${path ? `/${path}` : ''}`}
            end={path === ''}
            className={({ isActive }) => cn('-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap', isActive ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={{ app: a, ws } satisfies AppContext} />
    </>
  );
}

const SOURCE_STATUS: Record<string, string> = {
  branch_deleted: 'The configured branch was deleted on GitHub. Pick another branch in Settings.',
  access_removed: 'The GitHub App no longer has access to this repository.',
  installation_disconnected: 'The GitHub App installation was disconnected or suspended. Automatic deploys are paused.',
};

export function AppOverview() {
  const { app, ws } = useAppContext();
  const active = app.activeDeployment;
  const latest = app.latestDeployment;
  const latestFailed = latest && latest.id !== active?.id && (latest.status === 'failed' || latest.status === 'interrupted');
  return (
    <div className="space-y-5">
      {app.sourceStatus !== 'ok' && <Notice tone="warn" title="Repository problem">{SOURCE_STATUS[app.sourceStatus]}</Notice>}
      {(app.pendingChanges.env || app.pendingChanges.config) && (
        <Notice tone="info" title="Changes not deployed yet" action={ws.can('deployment.create') && <DeployButton app={app} ws={ws.id} label="Deploy now" />}>
          {app.pendingChanges.env && 'Variables '}
          {app.pendingChanges.env && app.pendingChanges.config && 'and '}
          {app.pendingChanges.config && 'settings '}
          changed since the active release was deployed. They take effect on the next deployment.
        </Notice>
      )}
      {latestFailed && (
        <Notice tone="danger" title={`Deployment #${latest.number} ${latest.status}`} action={<Link className="text-sm underline" to={`/w/${ws.id}/apps/${app.id}/deployments/${latest.id}`}>View details</Link>}>
          {active ? `The active release #${active.number} is still serving traffic.` : 'Nothing is serving traffic yet.'}
        </Notice>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Active release">
          {active ? (
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted">Deployment</dt>
              <dd>
                <Link className="underline" to={`/w/${ws.id}/apps/${app.id}/deployments/${active.id}`}>
                  #{active.number}
                </Link>{' '}
                <span className="text-muted">({active.trigger})</span>
              </dd>
              <dt className="text-muted">Commit</dt>
              <dd className="flex items-center gap-1.5">
                <GitCommit className="size-3.5 text-muted" aria-hidden />
                <Mono>{active.commitSha?.slice(0, 12)}</Mono> <span className="truncate text-muted">{active.commitMessage}</span>
              </dd>
              <dt className="text-muted">Deployed</dt>
              <dd>
                <RelativeTime iso={active.finishedAt} />
              </dd>
              <dt className="text-muted">Address</dt>
              <dd>
                {app.url ? (
                  <a className="underline" href={app.url} target="_blank" rel="noreferrer noopener">
                    <Mono>{app.url}</Mono>
                  </a>
                ) : (
                  '—'
                )}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">Nothing deployed yet. {ws.can('deployment.create') ? 'Use Deploy to build and start the branch head.' : ''}</p>
          )}
        </Card>
        <Card title="Latest deployment">
          {latest ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={latest.status} />
                <Link className="underline" to={`/w/${ws.id}/apps/${app.id}/deployments/${latest.id}`}>
                  #{latest.number}
                </Link>
                <span className="text-muted">
                  <RelativeTime iso={latest.createdAt} />
                </span>
              </div>
              <p className="text-muted">
                <Mono>{latest.commitSha?.slice(0, 12)}</Mono> {latest.commitMessage}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">No deployments yet.</p>
          )}
        </Card>
        <Card title="Configuration" className="lg:col-span-2" actions={<Link className="text-sm text-muted hover:text-fg" to={`/w/${ws.id}/apps/${app.id}/settings`}>Edit</Link>}>
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {(
              [
                ['Source', app.sourceType === 'github' ? 'GitHub App' : 'Public repository'],
                ['Build context', <Mono key="c">{app.contextDir}</Mono>],
                ['Dockerfile', <Mono key="d">{app.dockerfilePath}</Mono>],
                ['Port', <Mono key="p">{app.port}</Mono>],
                ['Health check', <span key="h"><Mono>{app.healthCheck.path}</Mono> every {app.healthCheck.intervalSeconds}s, {app.healthCheck.retries} attempts</span>],
                ['Resources', `${app.cpuLimit} CPU · ${app.memoryLimitMb} MB`],
                ['Auto-deploy', app.autoDeploy ? 'On' : 'Off'],
                ['Revisions', `config r${app.configRevision} · env r${app.envRevision}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-border/60 py-1.5 last:border-0">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
