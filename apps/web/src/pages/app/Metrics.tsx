import type { MetricsView } from '@deployforge/contracts';
import { useMetrics } from '../../api/queries';
import { Badge, Card, EmptyState, ErrorState, Notice, RelativeTime, Skeleton, formatBytes, formatDuration } from '../../components/ui';
import { useAppContext } from './AppLayout';

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
      <div className={pct > 90 ? 'h-full bg-danger' : pct > 70 ? 'h-full bg-warn' : 'h-full bg-ok'} style={{ width: `${pct}%` }} />
    </div>
  );
}

function uptime(s: number | null): string {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function MetricsPage() {
  const { app } = useAppContext();
  const q = useMetrics(app.id, !!app.activeDeployment);
  if (!app.activeDeployment) return <EmptyState title="No running release">Metrics are available once a deployment succeeds.</EmptyState>;
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!q.data || 'unavailable' in q.data) {
    return <Notice tone="warn" title="Metrics unavailable">{q.data && 'unavailable' in q.data && q.data.unavailable === 'runner_unreachable' ? 'The runner could not be reached. See platform diagnostics.' : 'The container is not available.'}</Notice>;
  }
  const m: MetricsView = q.data;
  const cpuMax = m.cpuLimitCores * 100;
  const healthTone = m.health === 'healthy' ? 'ok' : m.health === 'unhealthy' ? 'danger' : 'neutral';
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="CPU">
          <p className="text-2xl font-semibold tabular-nums">{m.cpuPercent.toFixed(1)}%</p>
          <p className="text-xs text-muted">of one core · limit {m.cpuLimitCores} core{m.cpuLimitCores === 1 ? '' : 's'} ({cpuMax}%)</p>
          <Meter value={m.cpuPercent} max={cpuMax} label="CPU usage relative to limit" />
        </Card>
        <Card title="Memory">
          <p className="text-2xl font-semibold tabular-nums">{formatBytes(m.memoryBytes)}</p>
          <p className="text-xs text-muted">limit {formatBytes(m.memoryLimitBytes)} (excludes reclaimable page cache)</p>
          <Meter value={m.memoryBytes} max={m.memoryLimitBytes} label="Memory usage relative to limit" />
        </Card>
        <Card title="Health">
          <Badge tone={healthTone} dot>
            {m.health}
          </Badge>
          <p className="mt-2 text-xs text-muted">Live probe of <code className="font-mono">{app.healthCheck.path}</code> when this sample was taken.</p>
        </Card>
        <Card title="Uptime">
          <p className="text-2xl font-semibold tabular-nums">{uptime(m.uptimeSeconds)}</p>
          <p className="text-xs text-muted">{m.running ? 'since the container last started' : 'container not running'}</p>
        </Card>
        <Card title="Restarts">
          <p className="text-2xl font-semibold tabular-nums">{m.restartCount}</p>
          <p className="text-xs text-muted">automatic restarts by Docker (crashes) · {m.pids} processes</p>
        </Card>
        <Card title="Latest deployment">
          <p className="text-2xl font-semibold tabular-nums">{formatDuration(m.latestDeploymentDurationMs)}</p>
          <p className="text-xs text-muted">from start to promotion</p>
        </Card>
      </div>
      <p className="text-xs text-muted">
        Sampled <RelativeTime iso={m.sampledAt} />, refreshed every 10 seconds. {m.sampleIntervalNote} DeployForge does not store metric history, so no historical charts are shown.
      </p>
    </div>
  );
}
