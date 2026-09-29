import { Monitor, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, errorMessage, post } from '../api/client';
import { keys, useAction, useSessions } from '../api/queries';
import { useSession } from '../auth/session';
import { Badge, Button, Card, ErrorState, Field, Input, Notice, PageHeader, RelativeTime, Skeleton } from '../components/ui';

export function AccountPage() {
  const me = useSession();
  const sessions = useSessions();
  const revoke = useAction((id: string) => del(`/api/auth/sessions/${id}`), [keys.sessions]);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const change = useAction((b: typeof pw) => post('/api/auth/password', b), [keys.sessions]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await change.mutateAsync(pw);
      setPw({ currentPassword: '', newPassword: '' });
      setMsg({ tone: 'ok', text: 'Password changed. All other sessions were signed out.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  };
  return (
    <>
      <PageHeader title="Account" description={`${me.user.name} · ${me.user.email}`} />
      <div className="space-y-5">
        <Card title="Active sessions" description="Browsers and mobile devices signed in to your account.">
          {sessions.isLoading ? (
            <Skeleton className="h-24" />
          ) : sessions.error ? (
            <ErrorState error={sessions.error} />
          ) : (
            <ul className="divide-y divide-border">
              {sessions.data?.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex min-w-0 items-center gap-3">
                    {s.kind === 'mobile' ? <Smartphone className="size-4 shrink-0 text-muted" aria-hidden /> : <Monitor className="size-4 shrink-0 text-muted" aria-hidden />}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {s.deviceName ?? (s.userAgent?.slice(0, 60) || 'Browser')} {s.current && <Badge tone="ok">This session</Badge>}
                      </span>
                      <span className="block text-xs text-muted">
                        {s.ip ?? 'unknown IP'} · last active <RelativeTime iso={s.lastSeenAt} />
                      </span>
                    </span>
                  </span>
                  {!s.current && (
                    <Button size="sm" loading={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="grid max-w-md gap-4">
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />}</Field>
            <Field label="New password" hint="At least 12 characters.">
              {(p) => <Input {...p} type="password" autoComplete="new-password" minLength={12} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />}
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={change.isPending}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
