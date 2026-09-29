import { CheckCircle2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDiagnostics } from '../api/queries';
import { Card, ErrorState, Mono, PageHeader, RelativeTime, Skeleton, formatBytes } from '../components/ui';

function Row({ ok, label, children }: { ok: boolean; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-0">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-ok" aria-label="Healthy" /> : <XCircle className="mt-0.5 size-4 text-danger" aria-label="Unhealthy" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="text-sm break-words text-muted">{children}</div>
      </div>
    </div>
  );
}

export function DiagnosticsPage() {
  const q = useDiagnostics();
  if (q.isLoading) return <Skeleton className="h-80" />;
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="Platform diagnostics" description={<>Checked <RelativeTime iso={d.checkedAt} />; refreshes every 15 seconds.</>} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Components">
          <Row ok={d.database.ok} label="PostgreSQL">{d.database.ok ? `${d.database.latencyMs} ms` : d.database.error}</Row>
          <Row ok={d.redis.ok} label="Redis">{d.redis.ok ? `${d.redis.latencyMs} ms` : d.redis.error}</Row>
          <Row ok={d.runner.ok} label="Deployment runner">
            {d.runner.ok ? (
              <>
                runner {d.runner.version} · Docker {d.runner.docker} · buildx {d.runner.buildx} · builds {d.runner.activeBuilds}/{d.runner.maxConcurrentBuilds}
              </>
            ) : (
              d.runner.error ?? `Docker: ${d.runner.docker ?? 'unknown'}; buildx: ${d.runner.buildx ?? 'unknown'}`
            )}
          </Row>
          <Row ok={d.proxy.ok} label="Reverse proxy (Caddy)">
            {d.proxy.lastError ? <span className="text-danger">{d.proxy.lastError}</span> : `${d.proxy.routeCount} application route sets`} · last sync <RelativeTime iso={d.proxy.lastSyncAt} />
          </Row>
        </Card>
        <Card title="Queue">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {(
              [
                ['Waiting', d.queue.waiting],
                ['Active', d.queue.active],
                ['Delayed', d.queue.delayed],
                ['Failed', d.queue.failed],
                ['Outbox pending', d.queue.outboxPending],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-md bg-surface-2 p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">Delayed jobs are deployments waiting for another deployment of the same application to finish.</p>
        </Card>
        <Card title="Reconciler">
          <p className="text-sm">
            Last run <RelativeTime iso={d.reconciler.lastRunAt} />
          </p>
          {d.reconciler.lastResult && <Mono className="mt-2 block break-all text-xs text-muted">{d.reconciler.lastResult}</Mono>}
        </Card>
        <Card title="Images">
          {d.disk ? (
            <p className="text-sm">
              {d.disk.imageCount} DeployForge images using {formatBytes(d.disk.imageBytes)} (shared layers counted once per image).
            </p>
          ) : (
            <p className="text-sm text-muted">Unavailable while the runner is unreachable.</p>
          )}
        </Card>
      </div>
    </>
  );
}
