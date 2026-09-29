import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, CircleX, Loader2, Pin, PinOff, SkipForward, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { FAILURE_EXPLANATIONS, isCancelable, isTerminal, type DeploymentEventView, type DeploymentView, type LogEvent } from '@deployforge/contracts';
import { post } from '../../api/client';
import { fetchLogs, keys, useAction, useDeployment } from '../../api/queries';
import { useEventStream } from '../../api/sse';
import { appendBounded, LogViewer } from '../../components/LogViewer';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Mono, Notice, RelativeTime, Skeleton, StatusBadge, cn, formatDuration } from '../../components/ui';
import { useAppContext } from './AppLayout';
import { RollbackButton } from './Deployments';

const PIPELINE = ['preparing', 'cloning', 'building', 'starting', 'checking_health', 'promoting'] as const;
const LABEL: Record<string, string> = { preparing: 'Prepare', cloning: 'Clone', building: 'Build', starting: 'Start', checking_health: 'Health check', promoting: 'Promote' };

function Timeline({ d }: { d: DeploymentView }) {
  const byStage = new Map(d.stages.map((s) => [s.stage, s]));
  const rollback = !!d.rollbackOf;
  return (
    <ol className="grid gap-2 sm:grid-cols-6" aria-label="Deployment stages">
      {PIPELINE.map((stage) => {
        const s = byStage.get(stage);
        const skipped = rollback && (stage === 'cloning' || stage === 'building');
        const outcome = skipped ? 'skipped' : s?.outcome ?? (d.status === 'queued' ? 'pending' : isTerminal(d.status) ? 'not reached' : 'pending');
        const Icon = outcome === 'succeeded' ? CheckCircle2 : outcome === 'failed' ? XCircle : outcome === 'running' ? Loader2 : outcome === 'canceled' ? CircleX : outcome === 'skipped' ? SkipForward : Circle;
        return (
          <li key={stage} className={cn('rounded-md border p-3', outcome === 'failed' ? 'border-danger/50 bg-danger/5' : outcome === 'running' ? 'border-warn/50 bg-warn/5' : 'border-border')}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Icon className={cn('size-4', outcome === 'succeeded' && 'text-ok', outcome === 'failed' && 'text-danger', outcome === 'running' && 'animate-spin text-warn', (outcome === 'pending' || outcome === 'not reached' || outcome === 'skipped') && 'text-muted')} aria-hidden />
              {LABEL[stage]}
            </div>
            <p className="mt-1 text-xs text-muted">
              {skipped ? 'Reused image' : s?.durationMs != null ? formatDuration(s.durationMs) : outcome === 'running' ? 'In progress' : outcome}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export function DeploymentDetail() {
  const { app, ws } = useAppContext();
  const { deploymentId = '' } = useParams();
  const qc = useQueryClient();
  const q = useDeployment(deploymentId);
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [dropped, setDropped] = useState(0);
  const [events, setEvents] = useState<DeploymentEventView[]>([]);
  const [meta, setMeta] = useState<{ truncated: boolean; expired: boolean }>({ truncated: false, expired: false });

  useEffect(() => {
    setLines([]);
    setEvents([]);
    setDropped(0);
    void fetchLogs(deploymentId).then((r) => setMeta({ truncated: r.truncated, expired: r.expired })).catch(() => undefined);
  }, [deploymentId]);

  const onLog = useCallback((data: unknown) => {
    setLines((prev) => {
      const r = appendBounded(prev, [data as LogEvent]);
      if (r.dropped) setDropped((n) => n + r.dropped);
      return r.lines;
    });
  }, []);
  const stream = useEventStream(deploymentId ? `/api/deployments/${deploymentId}/stream` : null, {
    log: onLog,
    event: (data) => setEvents((prev) => (prev.some((e) => e.id === (data as DeploymentEventView).id) ? prev : [...prev, data as DeploymentEventView])),
    status: (data) => {
      qc.setQueryData(keys.deployment(deploymentId), data as DeploymentView);
      void qc.invalidateQueries({ queryKey: keys.app(app.id) });
    },
  });

  const cancel = useAction(() => post(`/api/deployments/${deploymentId}/cancel`), [keys.deployment(deploymentId)]);
  const pin = useAction((pinned: boolean) => post(`/api/deployments/${deploymentId}/pin`, { pinned }), [keys.deployment(deploymentId), keys.deployments(app.id)]);

  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const failure = d.failureCategory ? FAILURE_EXPLANATIONS[d.failureCategory] : null;
  const streamStatus =
    stream.state === 'reconnecting'
      ? 'Connection lost — reconnecting and resuming from the last line received…'
      : stream.state === 'error'
        ? stream.errorCode === 'session_expired'
          ? 'Your session ended. Sign in again to keep following.'
          : 'Live updates disconnected.'
        : stream.state === 'ended'
          ? `Finished · ${lines.length.toLocaleString()} lines`
          : stream.state === 'open'
            ? 'Live'
            : 'Connecting…';

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Deployment #{d.number}</h2>
            <StatusBadge status={d.status} />
            {d.releaseState === 'active' && <Badge tone="info">Active release</Badge>}
            {d.releaseState === 'superseded' && <Badge>Superseded</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Mono>{d.commitSha?.slice(0, 12)}</Mono> {d.commitMessage} · {d.trigger}
            {d.actor ? ` by ${d.actor.name}` : d.trigger === 'push' ? ' (GitHub push)' : ''} · <RelativeTime iso={d.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ws.can('deployment.cancel') && isCancelable(d.status) && !d.cancelRequested && (
            <ConfirmDialog
              trigger={<Button>Cancel deployment</Button>}
              title="Cancel this deployment?"
              consequences={<p>The build or candidate container is stopped and removed. The active release is not affected. Cancellation is no longer possible once promotion has started.</p>}
              confirmLabel="Cancel deployment"
              busy={cancel.isPending}
              onConfirm={() => cancel.mutateAsync(undefined)}
            />
          )}
          {d.cancelRequested && !isTerminal(d.status) && <Badge tone="warn">Cancellation requested</Badge>}
          {ws.can('deployment.rollback') && d.status === 'succeeded' && (
            <Button size="md" icon={d.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />} loading={pin.isPending} onClick={() => pin.mutate(!d.pinned)}>
              {d.pinned ? 'Unpin release' : 'Pin release'}
            </Button>
          )}
          {ws.can('deployment.rollback') && d.canRollback && <RollbackButton appId={app.id} ws={ws.id} row={d} size="md" />}
        </div>
      </div>

      {failure && (
        <Notice tone="danger" title={failure.title}>
          <p className="break-words">{d.errorMessage}</p>
          <p className="mt-2">{failure.hint}</p>
          {d.failureCategory === 'startup_crash' && (
            <p className="mt-2">
              The container&apos;s last output is included at the end of the log below. See also{' '}
              <Link className="underline" to={`/w/${ws.id}/apps/${app.id}/logs`}>
                runtime logs
              </Link>
              .
            </p>
          )}
          <p className="mt-2">{d.previousActive ? `Release #${d.previousActive.number} kept serving traffic.` : ''}</p>
        </Notice>
      )}
      {d.status === 'interrupted' && <Notice tone="warn" title="Interrupted">{d.errorMessage}</Notice>}
      {d.rollbackOf && (
        <Notice tone="info">
          Rollback to{' '}
          <Link className="underline" to={`/w/${ws.id}/apps/${app.id}/deployments/${d.rollbackOf.id}`}>
            deployment #{d.rollbackOf.number}
          </Link>{' '}
          using its retained image, configuration revision r{d.configRevision} and environment revision r{d.envRevision}. No rebuild. Older variables may contain expired credentials; rollback does not undo migrations or external side effects.
        </Notice>
      )}

      <Card title="Stages" description={d.durationMs ? `Total ${formatDuration(d.durationMs)}` : undefined}>
        <Timeline d={d} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <section aria-label="Build log">
          <h3 className="mb-2 text-sm font-semibold">{d.rollbackOf ? 'Deployment log' : 'Build log'}</h3>
          {meta.expired && <Notice tone="info">Build output for this deployment expired under the log retention policy. Events and status are still available.</Notice>}
          <LogViewer
            lines={lines}
            droppedCount={dropped}
            downloadName={`${app.slug}-deployment-${d.number}.log`}
            downloadHref={`/api/deployments/${d.id}/logs/download`}
            emptyText={d.status === 'queued' ? 'Waiting for a worker to pick up this deployment…' : 'No output.'}
            status={
              <span className="flex items-center justify-between gap-2">
                <span>{streamStatus}</span>
                {meta.truncated && <span>Stored output reached the per-deployment limit; later lines were not kept.</span>}
                {stream.state === 'error' && stream.errorCode !== 'session_expired' && (
                  <button className="underline" onClick={stream.reconnect}>
                    Reconnect
                  </button>
                )}
              </span>
            }
          />
        </section>
        <aside className="space-y-5">
          <Card title="Events">
            <ol className="max-h-[28rem] space-y-2.5 overflow-auto text-sm">
              {events.length === 0 && <li className="text-muted">No events yet.</li>}
              {events.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', e.level === 'error' ? 'bg-danger' : e.level === 'warn' ? 'bg-warn' : 'bg-muted')} aria-hidden />
                  <span className="min-w-0">
                    <span className="block break-words">{e.message}</span>
                    <span className="text-xs text-muted">{new Date(e.ts).toLocaleTimeString()}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="Release">
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Image</dt>
                <dd>
                  <Mono>{d.imageId ? d.imageId.slice(7, 19) : '—'}</Mono> {d.imageId && !d.imageAvailable && <Badge>pruned</Badge>}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Container</dt>
                <dd className="truncate">
                  <Mono>{d.containerName ?? '—'}</Mono>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Config / env</dt>
                <dd>
                  r{d.configRevision} / r{d.envRevision}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Branch</dt>
                <dd>
                  <Mono>{d.branch ?? '—'}</Mono>
                </dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
