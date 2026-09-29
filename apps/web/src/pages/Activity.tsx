import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { fetchAudit } from '../api/queries';
import { useWorkspace } from '../auth/session';
import { Button, EmptyState, ErrorState, Mono, Notice, PageHeader, RelativeTime, Select, Skeleton } from '../components/ui';

const FILTERS = [
  ['', 'All activity'],
  ['deployment.', 'Deployments'],
  ['application.', 'Applications'],
  ['env.', 'Variables'],
  ['domain.', 'Domains'],
  ['member.', 'Members'],
  ['github.', 'GitHub'],
  ['auth.', 'Sign-ins'],
] as const;

export function ActivityPage() {
  const ws = useWorkspace();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', ws.id, action],
    queryFn: ({ pageParam }) => fetchAudit(ws.id, action, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: ws.can('audit.read'),
  });
  if (!ws.can('audit.read')) return <Notice tone="info">Activity is visible to owners and developers.</Notice>;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <PageHeader
        title="Activity"
        description="Audit trail of changes in this workspace. Secret values are never recorded."
        actions={
          <Select aria-label="Filter activity" className="w-44" value={action} onChange={(e) => setAction(e.target.value)}>
            {FILTERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-8" />} title="No activity yet" />
      ) : (
        <div className="rounded-lg border border-border bg-surface">
          <ol className="divide-y divide-border">
            {items.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <span className="font-medium">{e.actor?.name ?? 'System'}</span> <Mono className="text-muted">{e.action}</Mono>{' '}
                  <span className="text-muted">
                    {Object.entries(e.metadata)
                      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
                      .slice(0, 4)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(' ')}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted">
                  <RelativeTime iso={e.ts} /> {e.ip && <>· {e.ip}</>}
                </span>
              </li>
            ))}
          </ol>
          {q.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
