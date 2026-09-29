import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { envNameSchema, type EnvScope, type EnvVarView } from '@deployforge/contracts';
import { del, errorMessage, post, put } from '../../api/client';
import { keys, useAction, useEnv } from '../../api/queries';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, Input, Mono, Notice, Select, Skeleton, Switch } from '../../components/ui';
import { DeployButton, useAppContext } from './AppLayout';

function VariableDialog({ appId, existing, trigger, revision }: { appId: string; existing?: EnvVarView; trigger: React.ReactNode; revision: number }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(existing?.key ?? '');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState<EnvScope>(existing?.scope ?? 'runtime');
  const [secret, setSecret] = useState(existing?.secret ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    () =>
      existing
        ? put(`/api/apps/${appId}/env/${encodeURIComponent(existing.key)}`, { value, scope, secret, expectedRevision: revision })
        : post(`/api/apps/${appId}/env`, { key, value, scope, secret }),
    [keys.env(appId), keys.app(appId)],
  );
  const nameErr = !existing && key ? (envNameSchema.safeParse(key).success ? null : envNameSchema.safeParse(key).error?.issues[0]?.message ?? null) : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await save.mutateAsync(undefined);
      setOpen(false);
      setValue('');
      if (!existing) setKey('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6">
          <Dialog.Title className="font-semibold">{existing ? `Replace ${existing.key}` : 'Add variable'}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            {existing?.secret ? 'The current value is never shown. Enter a new value to replace it.' : 'Changes take effect on the next deployment.'}
          </Dialog.Description>
          <form onSubmit={submit} className="mt-4 space-y-4">
            {error && <Notice tone="danger">{error}</Notice>}
            {!existing && <Field label="Name" error={nameErr}>{(p) => <Input {...p} mono autoFocus required value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} />}</Field>}
            <Field label="Value">{(p) => <Input {...p} mono type={secret ? 'password' : 'text'} autoComplete="off" required value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Scope" hint={scope === 'build' ? (secret ? 'BuildKit secret mount' : 'Build argument') : 'Container environment'}>
                {(p) => (
                  <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as EnvScope)}>
                    <option value="runtime">Runtime</option>
                    <option value="build">Build</option>
                  </Select>
                )}
              </Field>
              <div className="space-y-1.5">
                <span className="block text-sm font-medium">Secret</span>
                <div className="flex h-9 items-center gap-2 text-sm text-muted">
                  <Switch checked={secret} onCheckedChange={setSecret} label="Secret" /> {secret ? 'Masked, write-only' : 'Visible to members'}
                </div>
              </div>
            </div>
            {scope === 'build' && secret && (
              <Notice tone="warn">
                Your Dockerfile must consume it with <Mono>RUN --mount=type=secret,id={key || 'NAME'}</Mono>. A build step can still print or copy it; only use build secrets with Dockerfiles you trust.
              </Notice>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!!nameErr}>
                {existing ? 'Replace value' : 'Add variable'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function VariablesPage() {
  const { app, ws } = useAppContext();
  const env = useEnv(app.id);
  const remove = useAction((key: string) => del(`/api/apps/${app.id}/env/${encodeURIComponent(key)}`), [keys.env(app.id), keys.app(app.id)]);
  const canWrite = ws.can('env.write');
  if (env.isLoading) return <Skeleton className="h-64" />;
  if (env.error || !env.data) return <ErrorState error={env.error} retry={() => void env.refetch()} />;
  const e = env.data;
  const pending = e.activeRevision !== null && e.activeRevision !== e.revision;
  return (
    <div className="space-y-4">
      {pending && (
        <Notice tone="info" title="Variable changes are not live yet" action={ws.can('deployment.create') && <DeployButton app={app} ws={ws.id} label="Deploy to apply" />}>
          The active release uses revision r{e.activeRevision}; the latest is r{e.revision}. Deploy to apply the changes.
        </Notice>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Revision r{e.revision} · values are encrypted at rest (AES-256-GCM). Secret values are never returned by the API.
        </p>
        {canWrite && (
          <VariableDialog
            appId={app.id}
            revision={e.revision}
            trigger={
              <Button variant="primary" icon={<Plus className="size-4" />}>
                Add variable
              </Button>
            }
          />
        )}
      </div>
      {e.vars.length === 0 ? (
        <EmptyState icon={<KeyRound className="size-8" />} title="No variables">Add runtime configuration or build-time secrets.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Environment variables</caption>
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 pl-4 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Value</th>
                <th className="py-2 pr-3 font-medium">Scope</th>
                <th className="py-2 pr-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {e.vars.map((v) => (
                <tr key={v.key} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-3 pl-4">
                    <Mono>{v.key}</Mono>
                  </td>
                  <td className="py-2.5 pr-3">
                    {v.secret ? (
                      <span className="flex items-center gap-1.5 text-muted">
                        <Lock className="size-3.5" aria-hidden />
                        <span aria-label="Secret value hidden">••••••••</span>
                      </span>
                    ) : (
                      <Mono className="break-all">{v.value}</Mono>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={v.scope === 'build' ? 'info' : 'neutral'}>{v.scope}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-right whitespace-nowrap">
                    {canWrite && (
                      <>
                        <VariableDialog appId={app.id} existing={v} revision={e.revision} trigger={<Button size="sm" variant="ghost" aria-label={`Replace ${v.key}`} icon={<Pencil className="size-4" />} />} />
                        <ConfirmDialog
                          trigger={<Button size="sm" variant="ghost" aria-label={`Delete ${v.key}`} icon={<Trash2 className="size-4" />} />}
                          title={`Delete ${v.key}?`}
                          consequences={<p>The variable is removed from the next deployment. The running release keeps its current value until then.</p>}
                          confirmLabel="Delete variable"
                          busy={remove.isPending}
                          onConfirm={() => remove.mutateAsync(v.key)}
                        />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
