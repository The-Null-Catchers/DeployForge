import { Globe, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { hostnameSchema, type DomainView } from '@deployforge/contracts';
import { del, errorMessage, post } from '../../api/client';
import { keys, useAction, useDomains } from '../../api/queries';
import { Badge, Button, Card, ConfirmDialog, CopyButton, ErrorState, Field, Input, Mono, Notice, RelativeTime, Skeleton, type Tone } from '../../components/ui';
import { useAppContext } from './AppLayout';

const STATUS: Record<DomainView['status'], [Tone, string]> = {
  pending_verification: ['warn', 'Pending verification'],
  verified: ['info', 'Verified'],
  active: ['ok', 'Active'],
  error: ['danger', 'Error'],
};

function DomainCard({ d, appId, canWrite }: { d: DomainView; appId: string; canWrite: boolean }) {
  const verify = useAction(() => post<DomainView>(`/api/domains/${d.id}/verify`), [keys.domains(appId)]);
  const remove = useAction(() => del(`/api/domains/${d.id}`), [keys.domains(appId)]);
  const [tone, label] = STATUS[d.status];
  return (
    <li className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Globe className="size-4 text-muted" aria-hidden />
          <Mono className="truncate text-sm">{d.hostname}</Mono>
          <Badge tone={d.kind === 'platform' ? 'neutral' : 'info'}>{d.kind}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={tone} dot>
            {label}
          </Badge>
          {canWrite && d.kind === 'custom' && (
            <>
              <Button size="sm" icon={<RefreshCw className="size-4" />} loading={verify.isPending} onClick={() => verify.mutate(undefined)}>
                {d.status === 'pending_verification' ? 'Verify' : 'Check DNS'}
              </Button>
              <ConfirmDialog
                trigger={<Button size="sm" variant="ghost" aria-label={`Remove ${d.hostname}`} icon={<Trash2 className="size-4" />} />}
                title={`Remove ${d.hostname}?`}
                consequences={<p>The route is removed first, then the domain record. Requests to this hostname will get a 404 from DeployForge until DNS is pointed elsewhere.</p>}
                confirmLabel="Remove domain"
                busy={remove.isPending}
                onConfirm={() => remove.mutateAsync(undefined)}
              />
            </>
          )}
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Routing</dt>
          <dd>{d.routing === 'active' ? 'Serving the active release' : d.status === 'pending_verification' ? 'Waiting for verification' : 'No active release'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">HTTPS</dt>
          <dd>{d.tls === 'automatic' ? 'Certificate issued automatically once DNS points here' : d.tls === 'internal' ? 'Internal CA (not publicly trusted)' : 'Disabled (HTTP only)'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">DNS</dt>
          <dd>
            {d.dns.ok === true ? 'Points to this server' : d.dns.ok === false ? 'Not pointing here yet' : d.kind === 'platform' ? 'Covered by the wildcard record' : 'Not checked'}
            {d.dns.checkedAt && (
              <span className="text-muted">
                {' '}
                · <RelativeTime iso={d.dns.checkedAt} />
              </span>
            )}
          </dd>
        </div>
      </dl>
      {d.verification && d.status === 'pending_verification' && (
        <div className="mt-4 space-y-2 rounded-md bg-surface-2 p-3 text-sm">
          <p className="font-medium">1. Prove ownership with a TXT record</p>
          <div className="grid gap-2 sm:grid-cols-[5rem_1fr_auto] sm:items-center">
            <span className="text-muted">Name</span>
            <Mono className="break-all">{d.verification.recordName}</Mono>
            <CopyButton value={d.verification.recordName} />
            <span className="text-muted">Value</span>
            <Mono className="break-all">{d.verification.recordValue}</Mono>
            <CopyButton value={d.verification.recordValue} />
          </div>
          <p className="font-medium">2. Point the domain at DeployForge</p>
          <p className="text-muted">
            Add a <Mono>CNAME</Mono> (or an <Mono>A</Mono> record for apex domains) to <Mono>{d.dns.expectedTarget}</Mono>. DNS changes can take minutes to hours to propagate.
          </p>
        </div>
      )}
      {d.dns.observed.length > 0 && <p className="mt-2 text-xs text-muted">Resolved: {d.dns.observed.join(', ')}</p>}
      {d.lastError && <p className="mt-2 text-sm text-warn">{d.lastError}</p>}
      {verify.error && <p className="mt-2 text-sm text-danger">{errorMessage(verify.error)}</p>}
    </li>
  );
}

export function DomainsPage() {
  const { app, ws } = useAppContext();
  const domains = useDomains(app.id);
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAction((hostname: string) => post(`/api/apps/${app.id}/domains`, { hostname }), [keys.domains(app.id)]);
  const canWrite = ws.can('domain.write');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = hostnameSchema.safeParse(host);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid hostname');
      return;
    }
    setError(null);
    try {
      await add.mutateAsync(parsed.data);
      setHost('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (domains.isLoading) return <Skeleton className="h-48" />;
  if (domains.error) return <ErrorState error={domains.error} retry={() => void domains.refetch()} />;
  return (
    <div className="space-y-5">
      <ul className="space-y-3">
        {domains.data?.map((d) => (
          <DomainCard key={d.id} d={d} appId={app.id} canWrite={canWrite} />
        ))}
      </ul>
      {canWrite && (
        <Card title="Add a custom domain" description="Routing and certificates are enabled only after the domain is verified.">
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex-1">
              <Field label="Hostname" error={error}>
                {(p) => <Input {...p} mono placeholder="www.example.com" value={host} onChange={(e) => setHost(e.target.value)} />}
              </Field>
            </div>
            <Button type="submit" className="sm:mt-7" loading={add.isPending}>
              Add domain
            </Button>
          </form>
        </Card>
      )}
      <Notice tone="info">WebSocket upgrades and <Mono>X-Forwarded-For</Mono>/<Mono>-Proto</Mono>/<Mono>-Host</Mono> headers are forwarded to your application automatically.</Notice>
    </div>
  );
}
