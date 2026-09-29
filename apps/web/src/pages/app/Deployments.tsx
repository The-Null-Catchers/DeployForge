import { History, Pin, RotateCcw } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { DeploymentView } from '@deployforge/contracts';
import { post } from '../../api/client';
import { keys, useAction, useDeployments, type DeploymentRow } from '../../api/queries';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Mono, RelativeTime, Skeleton, StatusBadge } from '../../components/ui';
import { useAppContext } from './AppLayout';

export function RollbackDisclosure({ number }: { number: number }) {
  return (
    <>
      <p>
        A new deployment starts from the retained image of release <strong>#{number}</strong>, with that release&apos;s configuration and environment variables. Nothing is rebuilt.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Variables from that release are used as they were then — credentials may since have expired or been revoked.</li>
        <li>Rollback does not undo database migrations, external side effects or data written by newer releases.</li>
        <li>If the rollback fails its health check, the current release keeps serving traffic.</li>
      </ul>
    </>
  );
}

export function RollbackButton({ appId, ws, row, size = 'sm' }: { appId: string; ws: string; row: { id: string; number: number }; size?: 'sm' | 'md' }) {
  const navigate = useNavigate();
  const rollback = useAction(() => post<DeploymentView>(`/api/deployments/${row.id}/rollback`, { confirm: true }), [keys.deployments(appId), keys.app(appId)]);
  return (
    <ConfirmDialog
      trigger={
        <Button size={size} icon={<RotateCcw className="size-4" />}>
          Roll back
        </Button>
      }
      title={`Roll back to #${row.number}?`}
      consequences={<RollbackDisclosure number={row.number} />}
      confirmLabel={`Roll back to #${row.number}`}
      danger={false}
      busy={rollback.isPending}
      onConfirm={async () => {
        const d = await rollback.mutateAsync(undefined);
        navigate(`/w/${ws}/apps/${appId}/deployments/${d.id}`);
      }}
    />
  );
}

function Row({ d, appId, ws, canRollback }: { d: DeploymentRow; appId: string; ws: string; canRollback: boolean }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2.5 pr-3 pl-4">
        <Link className="font-medium underline-offset-2 hover:underline" to={`/w/${ws}/apps/${appId}/deployments/${d.id}`}>
          #{d.number}
        </Link>
      </td>
      <td className="py-2.5 pr-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={d.status} />
          {d.releaseState === 'active' && <Badge tone="info">Active</Badge>}
          {d.pinned && (
            <Badge>
              <Pin className="size-3" aria-hidden /> Pinned
            </Badge>
          )}
        </div>
      </td>
      <td className="max-w-72 py-2.5 pr-3">
        <Mono>{d.commitSha?.slice(0, 7) ?? '—'}</Mono> <span className="text-muted">{d.commitMessage}</span>
      </td>
      <td className="py-2.5 pr-3 text-muted capitalize">{d.trigger}</td>
      <td className="py-2.5 pr-3 text-muted">
        <RelativeTime iso={d.createdAt} />
      </td>
      <td className="py-2.5 pr-4 text-right">{canRollback && d.canRollback && <RollbackButton appId={appId} ws={ws} row={d} />}</td>
    </tr>
  );
}

export function DeploymentsPage() {
  const { app, ws } = useAppContext();
  const q = useDeployments(app.id);
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const items = q.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState icon={<History className="size-8" />} title="No deployments yet">
        Each deployment builds an exact commit into an immutable image and is kept as a release you can roll back to.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm">
        <caption className="sr-only">Deployment history</caption>
        <thead className="border-b border-border text-left text-xs text-muted">
          <tr>
            <th className="py-2 pr-3 pl-4 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Commit</th>
            <th className="py-2 pr-3 font-medium">Trigger</th>
            <th className="py-2 pr-3 font-medium">Created</th>
            <th className="py-2 pr-4">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <Row key={d.id} d={d} appId={app.id} ws={ws.id} canRollback={ws.can('deployment.rollback')} />
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-4 py-2 text-xs text-muted">Images of the newest successful releases, the active release and pinned releases are retained for rollback; older images are pruned automatically.</p>
    </div>
  );
}
