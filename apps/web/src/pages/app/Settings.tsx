import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { checkRelativePath, LIMITS, type ApplicationView } from '@deployforge/contracts';
import { del, errorMessage, patch } from '../../api/client';
import { keys, useAction } from '../../api/queries';
import { Button, Card, ConfirmDialog, Field, Input, Mono, Notice, Select, Switch } from '../../components/ui';
import { useAppContext } from './AppLayout';

export function AppSettingsPage() {
  const { app, ws } = useAppContext();
  const navigate = useNavigate();
  const [f, setF] = useState(() => ({
    name: app.name,
    branch: app.branch,
    contextDir: app.contextDir,
    dockerfilePath: app.dockerfilePath,
    port: app.port,
    healthCheck: { ...app.healthCheck },
    cpuLimit: app.cpuLimit,
    memoryLimitMb: app.memoryLimitMb,
    autoDeploy: app.autoDeploy,
    securityProfile: app.securityProfile,
  }));
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const save = useAction((body: typeof f) => patch<ApplicationView>(`/api/apps/${app.id}`, body), [keys.app(app.id)]);
  const remove = useAction(() => del(`/api/apps/${app.id}`, { confirmSlug: app.slug }), [keys.projects(ws.id)]);
  const canEdit = ws.can('app.update');
  const ctxErr = checkRelativePath(f.contextDir);
  const dfErr = checkRelativePath(f.dockerfilePath);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await save.mutateAsync(f);
      setMsg({ tone: 'ok', text: 'Saved. Settings take effect on the next deployment.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit}>
        <fieldset disabled={!canEdit} className="space-y-6">
          {!canEdit && <Notice tone="info">You have read-only access to these settings.</Notice>}
          <Card title="General">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Name">{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
              <Field label="Slug" hint="Slugs cannot be changed; they define the platform hostname.">{(p) => <Input {...p} mono value={app.slug} readOnly />}</Field>
            </div>
          </Card>
          <Card title="Source and build">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Repository">{(p) => <Input {...p} mono value={app.repoUrl} readOnly />}</Field>
              <Field label="Branch">{(p) => <Input {...p} mono value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} />}</Field>
              <Field label="Build context" error={ctxErr}>{(p) => <Input {...p} mono value={f.contextDir} onChange={(e) => setF({ ...f, contextDir: e.target.value })} />}</Field>
              <Field label="Dockerfile path" error={dfErr}>{(p) => <Input {...p} mono value={f.dockerfilePath} onChange={(e) => setF({ ...f, dockerfilePath: e.target.value })} />}</Field>
              {app.sourceType === 'github' && (
                <label className="flex items-center gap-3 text-sm sm:col-span-2">
                  <Switch checked={f.autoDeploy} onCheckedChange={(v) => setF({ ...f, autoDeploy: v })} label="Auto-deploy on push" disabled={!canEdit} />
                  Deploy automatically on push to <Mono>{f.branch}</Mono>
                </label>
              )}
            </div>
          </Card>
          <Card title="Runtime and health" description="The application must listen on the port below on 0.0.0.0.">
            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="Container port">{(p) => <Input {...p} type="number" min={1} max={65535} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />}</Field>
              <Field label="Health path">{(p) => <Input {...p} mono value={f.healthCheck.path} onChange={(e) => setF({ ...f, healthCheck: { ...f.healthCheck, path: e.target.value } })} />}</Field>
              <Field label="Start period (s)">{(p) => <Input {...p} type="number" min={0} value={f.healthCheck.startPeriodSeconds} onChange={(e) => setF({ ...f, healthCheck: { ...f.healthCheck, startPeriodSeconds: Number(e.target.value) } })} />}</Field>
              <Field label="Timeout (s)">{(p) => <Input {...p} type="number" min={1} value={f.healthCheck.timeoutSeconds} onChange={(e) => setF({ ...f, healthCheck: { ...f.healthCheck, timeoutSeconds: Number(e.target.value) } })} />}</Field>
              <Field label="Interval (s)">{(p) => <Input {...p} type="number" min={1} value={f.healthCheck.intervalSeconds} onChange={(e) => setF({ ...f, healthCheck: { ...f.healthCheck, intervalSeconds: Number(e.target.value) } })} />}</Field>
              <Field label="Attempts">{(p) => <Input {...p} type="number" min={1} value={f.healthCheck.retries} onChange={(e) => setF({ ...f, healthCheck: { ...f.healthCheck, retries: Number(e.target.value) } })} />}</Field>
              <Field label="CPU (cores)">{(p) => <Input {...p} type="number" step={0.1} min={LIMITS.cpu.min} max={LIMITS.cpu.max} value={f.cpuLimit} onChange={(e) => setF({ ...f, cpuLimit: Number(e.target.value) })} />}</Field>
              <Field label="Memory (MB)">{(p) => <Input {...p} type="number" min={LIMITS.memoryMb.min} max={LIMITS.memoryMb.max} value={f.memoryLimitMb} onChange={(e) => setF({ ...f, memoryLimitMb: Number(e.target.value) })} />}</Field>
              <Field label="Security profile">
                {(p) => (
                  <Select {...p} value={f.securityProfile} onChange={(e) => setF({ ...f, securityProfile: e.target.value as 'standard' | 'strict' })}>
                    <option value="standard">Standard</option>
                    <option value="strict">Strict (drop all capabilities)</option>
                  </Select>
                )}
              </Field>
            </div>
          </Card>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          {canEdit && (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!!ctxErr || !!dfErr}>
                Save settings
              </Button>
            </div>
          )}
        </fieldset>
      </form>

      {ws.can('app.delete') && (
        <Card title="Danger zone" className="border-danger/40">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">Delete this application, its routes, containers, images, domains and history.</p>
            <ConfirmDialog
              trigger={<Button variant="danger">Delete application</Button>}
              title={`Delete ${app.name}?`}
              consequences={
                <>
                  <p>This removes the application&apos;s routes first, then its containers, retained images, network, domains, variables and deployment history.</p>
                  <p>It cannot be undone. Data your application stored outside its container (databases, object storage) is not touched.</p>
                </>
              }
              confirmText={app.slug}
              confirmLabel="Delete application"
              busy={remove.isPending}
              onConfirm={async () => {
                await remove.mutateAsync(undefined);
                navigate(`/w/${ws.id}`);
              }}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
