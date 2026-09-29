import { useCallback, useEffect, useState } from 'react';
import type { LogEvent } from '@deployforge/contracts';
import { useEventStream } from '../../api/sse';
import { appendBounded, LogViewer } from '../../components/LogViewer';
import { EmptyState, Mono, Notice } from '../../components/ui';
import { useAppContext } from './AppLayout';

export function RuntimeLogsPage() {
  const { app } = useAppContext();
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [dropped, setDropped] = useState(0);
  const [meta, setMeta] = useState<{ deploymentId: string; containerName: string | null } | null>(null);
  const active = app.activeDeployment;
  useEffect(() => {
    setLines([]);
    setDropped(0);
  }, [active?.id]);
  const onLog = useCallback((data: unknown) => {
    setLines((prev) => {
      const r = appendBounded(prev, [data as LogEvent]);
      if (r.dropped) setDropped((n) => n + r.dropped);
      return r.lines;
    });
  }, []);
  const stream = useEventStream(active ? `/api/apps/${app.id}/runtime-logs/stream?tail=300` : null, {
    log: onLog,
    meta: (d) => setMeta(d as { deploymentId: string; containerName: string | null }),
  });
  if (!active) return <EmptyState title="No running release">Runtime logs appear once a deployment succeeds.</EmptyState>;
  const status =
    stream.state === 'open'
      ? `Following ${meta?.containerName ?? 'container'} (release #${active.number})`
      : stream.state === 'reconnecting'
        ? 'Connection lost — reconnecting and resuming after the last line…'
        : stream.state === 'ended'
          ? 'The container stopped; the stream ended.'
          : stream.state === 'error'
            ? stream.errorCode === 'container_removed'
              ? 'The container no longer exists.'
              : stream.errorCode === 'session_expired'
                ? 'Your session ended.'
                : 'Could not reach the runner.'
            : 'Connecting…';
  return (
    <div className="space-y-4">
      <Notice tone="info">
        stdout and stderr of the active container, read from Docker (<Mono>json-file</Mono>, 3 × 10 MB per container). Known secret values are masked before display; transformed or encoded secrets cannot be detected.
      </Notice>
      <LogViewer
        lines={lines}
        droppedCount={dropped}
        downloadName={`${app.slug}-runtime.log`}
        emptyText="No output yet."
        status={
          <span className="flex justify-between gap-2">
            <span>{status}</span>
            {(stream.state === 'error' || stream.state === 'ended') && (
              <button className="underline" onClick={stream.reconnect}>
                Reconnect
              </button>
            )}
          </span>
        }
      />
    </div>
  );
}
