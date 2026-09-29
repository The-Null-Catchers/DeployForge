import { FolderGit2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { del, errorMessage, patch, post } from '../api/client';
import { keys, useAction, useInstallations, useStatus } from '../api/queries';
import { useWorkspace } from '../auth/session';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Notice, PageHeader, RelativeTime } from '../components/ui';

export function WorkspaceSettingsPage() {
  const ws = useWorkspace();
  const status = useStatus();
  const [params] = useSearchParams();
  const installations = useInstallations(ws.id, !!status.data?.githubEnabled && ws.can('github.read'));
  const [name, setName] = useState(ws.name);
  const [msg, setMsg] = useState<string | null>(null);
  const rename = useAction((n: string) => patch(`/api/workspaces/${ws.id}`, { name: n }), [keys.me]);
  const connect = useAction(() => post<{ url: string }>(`/api/workspaces/${ws.id}/github/connect`, { returnTo: 'web' }));
  const disconnect = useAction((id: string) => del(`/api/github/installations/${id}`), [keys.installations(ws.id)]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await rename.mutateAsync(name);
      setMsg('Saved');
    } catch (err) {
      setMsg(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title="Workspace settings" />
      <div className="space-y-5">
        {params.get('github') === 'connected' && <Notice tone="ok">GitHub installation connected.</Notice>}
        <Card title="General">
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex-1">
              <Field label="Workspace name" hint={msg ?? undefined}>
                {(p) => <Input {...p} value={name} disabled={!ws.can('workspace.update')} onChange={(e) => setName(e.target.value)} />}
              </Field>
            </div>
            {ws.can('workspace.update') && (
              <Button type="submit" className="sm:mt-7" loading={rename.isPending}>
                Save
              </Button>
            )}
          </form>
        </Card>
        <Card
          title="GitHub"
          description="Connect the DeployForge GitHub App to deploy private repositories and deploy on push."
          actions={
            status.data?.githubEnabled &&
            ws.can('github.connect') && (
              <Button
                icon={<FolderGit2 className="size-4" />}
                loading={connect.isPending}
                onClick={async () => {
                  const r = await connect.mutateAsync(undefined);
                  window.location.assign(r.url);
                }}
              >
                Connect GitHub
              </Button>
            )
          }
        >
          {!status.data?.githubEnabled ? (
            <Notice tone="info">The GitHub App is not configured on this server (GITHUB_MODE=disabled). Public repositories can still be deployed. See docs/github-app.md.</Notice>
          ) : !ws.can('github.read') ? (
            <p className="text-sm text-muted">Visible to owners and developers.</p>
          ) : installations.data?.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {installations.data.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2">
                    <FolderGit2 className="size-4" aria-hidden /> {i.accountLogin} <Badge tone={i.status === 'active' ? 'ok' : 'warn'}>{i.status}</Badge>
                  </span>
                  <span className="flex items-center gap-3 text-muted">
                    <RelativeTime iso={i.createdAt} />
                    {ws.can('github.connect') && (
                      <ConfirmDialog
                        trigger={<Button size="sm">Disconnect</Button>}
                        title={`Disconnect ${i.accountLogin}?`}
                        consequences={<p>Applications using this installation stop deploying on push and cannot clone until it is reconnected. Running releases keep running. To revoke access completely, also uninstall the app on GitHub.</p>}
                        confirmLabel="Disconnect"
                        busy={disconnect.isPending}
                        onConfirm={() => disconnect.mutateAsync(i.id)}
                      />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No installations connected.</p>
          )}
          {connect.error && <p className="mt-2 text-sm text-danger">{errorMessage(connect.error)}</p>}
        </Card>
      </div>
    </>
  );
}
