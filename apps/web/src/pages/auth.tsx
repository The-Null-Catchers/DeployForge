import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import type { SessionInfo } from '@deployforge/contracts';
import { ApiError, errorMessage, get, post, setCsrfToken } from '../api/client';
import { keys, useStatus } from '../api/queries';
import { Button, Field, Input, Notice, Spinner } from '../components/ui';

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">DeployForge</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function useFinishLogin() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (s: SessionInfo) => {
    setCsrfToken(s.csrfToken);
    qc.setQueryData(keys.me, s);
    void qc.invalidateQueries({ queryKey: keys.status });
    const next = params.get('next');
    // Only allow same-site relative redirects (no open redirect).
    const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : `/w/${s.workspaces[0]?.id ?? ''}`;
    navigate(safe, { replace: true });
  };
}

export function LoginPage() {
  const status = useStatus();
  const finish = useFinishLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await post<SessionInfo>('/api/auth/login', { email, password }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Sign in" subtitle="Use the account your workspace owner created for you.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
        <p className="text-sm text-muted">There is no public sign-up. Ask a workspace owner for an invitation link.</p>
      </form>
    </AuthShell>
  );
}

export function SetupPage() {
  const status = useStatus();
  const finish = useFinishLogin();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '', setupToken: '' });
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (status.isLoading) return <Spinner />;
  if (status.data && !status.data.setupRequired) return <Navigate to="/login" replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      finish(await post<SessionInfo>('/api/setup', form));
    } catch (err) {
      if (err instanceof ApiError && err.body.issues) setIssues(Object.fromEntries(err.body.issues.map((i) => [i.path, i.message])));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Set up DeployForge" subtitle="Create the owner account and first workspace. This page works only once.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="danger">{error}</Notice>}
        {status.data?.setupTokenRequired && (
          <Field label="Setup token" hint="Printed by scripts/setup.mjs and stored as SETUP_TOKEN in the server's .env." error={issues.setupToken}>
            {(p) => <Input {...p} mono autoComplete="off" required value={form.setupToken} onChange={set('setupToken')} />}
          </Field>
        )}
        <Field label="Your name" error={issues.name}>{(p) => <Input {...p} autoComplete="name" required value={form.name} onChange={set('name')} />}</Field>
        <Field label="Email" error={issues.email}>{(p) => <Input {...p} type="email" autoComplete="username" required value={form.email} onChange={set('email')} />}</Field>
        <Field label="Password" hint="At least 12 characters." error={issues.password}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={set('password')} />}
        </Field>
        <Field label="Workspace name" error={issues.workspaceName}>{(p) => <Input {...p} required value={form.workspaceName} onChange={set('workspaceName')} />}</Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create owner account
        </Button>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const finish = useFinishLogin();
  const [info, setInfo] = useState<{ workspaceName: string; email: string; role: string; existingUser: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<typeof info>(`/api/invites/${encodeURIComponent(token)}`).then(setInfo, (e) => setLoadError(errorMessage(e)));
  }, [token]);
  if (loadError) {
    return (
      <AuthShell title="Invitation unavailable">
        <Notice tone="danger">This invitation link is invalid, expired or has already been used. Ask the workspace owner for a new one.</Notice>
        <p className="mt-4 text-sm">
          <Link className="text-accent underline" to="/login">
            Go to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }
  if (!info) return <Spinner />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await post<SessionInfo>('/api/invites/accept', { token, name: name || info.email.split('@')[0], password }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title={`Join ${info.workspaceName}`} subtitle={`You were invited as ${info.role} with ${info.email}.`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {!info.existingUser && <Field label="Your name">{(p) => <Input {...p} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
        <Field label={info.existingUser ? 'Your existing password' : 'Choose a password'} hint={info.existingUser ? 'An account with this email already exists.' : 'At least 12 characters.'}>
          {(p) => <Input {...p} type="password" autoComplete={info.existingUser ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Accept invitation
        </Button>
      </form>
    </AuthShell>
  );
}

const REASONS: Record<string, string> = {
  invalid_state: 'The connection link expired or was already used. Start again from DeployForge.',
  installation_not_accessible: 'Your GitHub account cannot access that installation.',
  bound_to_another_workspace: 'That GitHub installation is already connected to another workspace.',
  not_authorized: 'Only workspace owners can connect GitHub.',
  oauth_failed: 'GitHub did not confirm your authorization. Try again.',
  user_mismatch: 'You are signed in as a different user than the one who started the connection.',
};

/** Landing page after the GitHub App installation flow (also the mobile hand-off). */
export function GithubResultPage() {
  const [params] = useSearchParams();
  const ok = params.get('status') === 'connected';
  const mobile = params.get('return') === 'mobile';
  const ws = params.get('workspace');
  const reason = params.get('reason') ?? '';
  // Fixed scheme and path: never a caller-supplied return URL.
  const appLink = `deployforge://github/connected${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`;
  return (
    <AuthShell title={ok ? 'GitHub connected' : 'GitHub connection failed'}>
      {ok ? <Notice tone="ok">Repositories from this installation can now be deployed.</Notice> : <Notice tone="danger">{REASONS[reason] ?? 'The connection could not be completed.'}</Notice>}
      <div className="mt-6 flex flex-wrap gap-2">
        {mobile && ok && (
          <a href={appLink} className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg">
            Return to the DeployForge app
          </a>
        )}
        <Link to={ws ? `/w/${ws}/settings` : '/'} className="inline-flex h-9 items-center rounded-md border border-border px-3.5 text-sm">
          Open the dashboard
        </Link>
      </div>
    </AuthShell>
  );
}
