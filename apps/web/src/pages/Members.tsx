import { UserPlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ROLES, type InviteView, type Role } from '@deployforge/contracts';
import { del, errorMessage, patch, post } from '../api/client';
import { keys, useAction, useInvites, useMembers } from '../api/queries';
import { useSession, useWorkspace } from '../auth/session';
import { Badge, Button, Card, ConfirmDialog, CopyButton, ErrorState, Field, Input, Mono, Notice, PageHeader, RelativeTime, Select, Skeleton } from '../components/ui';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including members, GitHub connection and deleting applications.',
  developer: 'Create and configure applications, deploy, roll back, manage variables and domains.',
  viewer: 'Read-only: status, deployments and logs. Never sees secret values.',
};

export function MembersPage() {
  const ws = useWorkspace();
  const session = useSession();
  const canManage = ws.can('members.manage');
  const members = useMembers(ws.id);
  const invites = useInvites(ws.id, canManage);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [created, setCreated] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useAction((b: { email: string; role: Role }) => post<InviteView>(`/api/workspaces/${ws.id}/invites`, b), [keys.invites(ws.id)]);
  const changeRole = useAction((b: { userId: string; role: Role }) => patch(`/api/workspaces/${ws.id}/members/${b.userId}`, { role: b.role }), [keys.members(ws.id)]);
  const remove = useAction((userId: string) => del(`/api/workspaces/${ws.id}/members/${userId}`), [keys.members(ws.id)]);
  const revoke = useAction((id: string) => del(`/api/workspaces/${ws.id}/invites/${id}`), [keys.invites(ws.id)]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await invite.mutateAsync({ email, role }));
      setEmail('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader title="Members" description="Who can access this workspace, and with which role." />
      <div className="space-y-5">
        <Card title="Roles">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            {ROLES.map((r) => (
              <div key={r}>
                <dt className="font-medium capitalize">{r}</dt>
                <dd className="text-muted">{ROLE_HELP[r]}</dd>
              </div>
            ))}
          </dl>
        </Card>
        {members.isLoading ? (
          <Skeleton className="h-40" />
        ) : members.error ? (
          <ErrorState error={members.error} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Workspace members</caption>
              <thead className="border-b border-border text-left text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 pl-4 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Joined</th>
                  <th className="py-2 pr-4">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data?.map((m) => (
                  <tr key={m.userId} className="border-b border-border last:border-0">
                    <td className="py-2.5 pr-3 pl-4">
                      <div className="font-medium">
                        {m.name} {m.userId === session.user.id && <span className="text-muted">(you)</span>}
                      </div>
                      <div className="text-xs text-muted">{m.email}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {canManage ? (
                        <Select aria-label={`Role for ${m.name}`} className="w-36" value={m.role} onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as Role })}>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge>{m.role}</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-muted">
                      <RelativeTime iso={m.joinedAt} />
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      {canManage && (
                        <ConfirmDialog
                          trigger={<Button size="sm" variant="ghost" aria-label={`Remove ${m.name}`} icon={<X className="size-4" />} />}
                          title={`Remove ${m.name}?`}
                          consequences={<p>They immediately lose access to this workspace, including live log streams. Their account and other workspaces are not affected.</p>}
                          confirmLabel="Remove member"
                          busy={remove.isPending}
                          onConfirm={() => remove.mutateAsync(m.userId)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(changeRole.error || remove.error) && <p className="px-4 pb-3 text-sm text-danger">{errorMessage(changeRole.error ?? remove.error)}</p>}
          </div>
        )}
        {canManage && (
          <Card title="Invite someone" description="There is no public sign-up. Invitations are single-use links valid for 7 days.">
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
              <Field label="Email" error={error}>{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
              <Field label="Role">
                {(p) => (
                  <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button type="submit" className="sm:mt-7" icon={<UserPlus className="size-4" />} loading={invite.isPending}>
                Create invitation
              </Button>
            </form>
            {created?.inviteUrl && (
              <div className="mt-4">
                <Notice tone="ok" title={`Invitation for ${created.email}`}>
                  <p>Send this link to them over a trusted channel. It is shown only once.</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Mono className="min-w-0 break-all text-fg">{created.inviteUrl}</Mono>
                    <CopyButton value={created.inviteUrl} />
                  </div>
                </Notice>
              </div>
            )}
            {invites.data && invites.data.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-medium">Pending invitations</h3>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {invites.data.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span>
                        {i.email} <Badge>{i.role}</Badge>
                      </span>
                      <span className="flex items-center gap-3 text-muted">
                        expires <RelativeTime iso={i.expiresAt} />
                        <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                          Revoke
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}
        {!canManage && <Notice tone="info">Only workspace owners can invite or remove members.</Notice>}
      </div>
    </>
  );
}
