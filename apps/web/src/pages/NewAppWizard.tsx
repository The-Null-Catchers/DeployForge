import { Check, FolderGit2, Globe, Lock, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  checkRelativePath,
  createApplicationRequestSchema,
  envNameSchema,
  LIMITS,
  parseRepoUrl,
  RESERVED_SLUGS,
  slugSchema,
  type ApplicationView,
  type EnvScope,
} from '@deployforge/contracts';
import { ApiError, errorMessage, post } from '../api/client';
import { useBranches, useInstallations, useProjects, useRepos, useStatus } from '../api/queries';
import { useWorkspace } from '../auth/session';
import { Button, Card, Field, Input, Mono, Notice, PageHeader, Select, Spinner, Switch, cn } from '../components/ui';

const STEPS = ['Repository', 'Branch', 'Build', 'Runtime', 'Variables', 'Review'] as const;

interface EnvRow {
  key: string;
  value: string;
  scope: EnvScope;
  secret: boolean;
}

const toSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function NewAppWizard() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const status = useStatus();
  const projects = useProjects(ws.id);
  const installations = useInstallations(ws.id, !!status.data?.githubEnabled && ws.can('github.read'));
  const [step, setStep] = useState(0);
  const [sourceType, setSourceType] = useState<'github' | 'public'>('public');
  const [installationId, setInstallationId] = useState('');
  const [repoPage, setRepoPage] = useState(1);
  const [repoFilter, setRepoFilter] = useState('');
  const [repo, setRepo] = useState<{ id: number; fullName: string; defaultBranch: string } | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [contextDir, setContextDir] = useState('.');
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [port, setPort] = useState(3000);
  const [health, setHealth] = useState({ path: '/', timeoutSeconds: 5, intervalSeconds: 3, startPeriodSeconds: 5, retries: 20 });
  const [cpuLimit, setCpu] = useState(0.5);
  const [memoryLimitMb, setMemory] = useState(512);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [securityProfile, setSecurity] = useState<'standard' | 'strict'>('standard');
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [deployNow, setDeployNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repos = useRepos(sourceType === 'github' ? installationId || undefined : undefined, repoPage);
  const branches = useBranches(sourceType === 'github' ? installationId || undefined : undefined, repo?.id);
  const activeInstallations = installations.data?.filter((i) => i.status === 'active') ?? [];
  const project = projectId || projects.data?.[0]?.id || '';

  // ---- per-step validation (the server validates everything again) ----
  const repoError = sourceType === 'public' ? (repoUrl && !parseRepoUrl(repoUrl, status.data?.gitExtraAllowedHosts ?? []) ? 'Enter a public https://github.com/<owner>/<repo> URL' : null) : null;
  const slugResult = slugSchema.safeParse(slug);
  const slugError = !slug ? null : !slugResult.success ? slugResult.error.issues[0]?.message ?? 'Invalid slug' : RESERVED_SLUGS.has(slug) ? 'This slug is reserved' : null;
  const ctxError = checkRelativePath(contextDir);
  const dfError = checkRelativePath(dockerfilePath);
  const envErrors = useMemo(() => {
    const seen = new Map<string, number>();
    return env.map((row) => {
      if (!row.key) return 'Name is required';
      const r = envNameSchema.safeParse(row.key);
      if (!r.success) return r.error.issues[0]?.message ?? 'Invalid name';
      const n = (seen.get(row.key) ?? 0) + 1;
      seen.set(row.key, n);
      return n > 1 ? 'Duplicate name' : null;
    });
  }, [env]);

  const stepValid = [
    sourceType === 'public' ? !!repoUrl && !repoError : !!repo,
    !!branch.trim(),
    !!name.trim() && !!slug && !slugError && !ctxError && !dfError && !!project,
    port >= 1 && port <= 65535 && health.path.startsWith('/'),
    envErrors.every((e) => !e),
    true,
  ];

  const body = () => ({
    projectId: project,
    name: name.trim(),
    slug,
    source: sourceType === 'public' ? { type: 'public' as const, repoUrl: repoUrl.trim() } : { type: 'github' as const, installationId, repositoryId: repo!.id },
    branch: branch.trim(),
    contextDir,
    dockerfilePath,
    port,
    healthCheck: health,
    cpuLimit,
    memoryLimitMb,
    autoDeploy: sourceType === 'github' ? autoDeploy : false,
    securityProfile,
    env,
    deployNow,
  });

  const submit = async () => {
    setError(null);
    const parsed = createApplicationRequestSchema.safeParse(body());
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    setBusy(true);
    try {
      const app = await post<ApplicationView & { deploymentId?: string }>(`/api/workspaces/${ws.id}/apps`, parsed.data);
      navigate(app.deploymentId ? `/w/${ws.id}/apps/${app.id}/deployments/${app.deploymentId}` : `/w/${ws.id}/apps/${app.id}`);
    } catch (e) {
      setError(e instanceof ApiError && e.body.issues ? e.body.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ws.can('app.create')) return <Notice tone="warn" title="You cannot create applications">Your role in this workspace is {ws.role}. Ask an owner or developer.</Notice>;

  const setName2 = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(toSlug(v));
  };

  return (
    <>
      <PageHeader title="New application" breadcrumb={<Link to={`/w/${ws.id}`}>{ws.name}</Link>} description="Repository → branch → build → runtime → variables → review." />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={i > step && !stepValid.slice(0, i).every(Boolean)}
              onClick={() => setStep(i)}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm disabled:opacity-40',
                i === step ? 'border-accent bg-accent/10 text-fg' : i < step ? 'border-border text-fg' : 'border-border text-muted',
              )}
            >
              <span className={cn('grid size-5 place-items-center rounded-full text-xs', i < step ? 'bg-ok text-white dark:text-black' : 'bg-surface-2')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <Card>
        {step === 0 && (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Source</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ['public', Globe, 'Public repository', 'Any public GitHub repository. Good for trying the platform. No push-to-deploy.'],
                    ['github', FolderGit2, 'GitHub App', 'Private repositories and automatic deploys on push through a connected installation.'],
                  ] as const
                ).map(([value, Icon, title, desc]) => (
                  <label key={value} className={cn('flex cursor-pointer gap-3 rounded-lg border p-4', sourceType === value ? 'border-accent bg-accent/5' : 'border-border')}>
                    <input type="radio" name="source" className="mt-1" checked={sourceType === value} onChange={() => setSourceType(value)} />
                    <span>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <Icon className="size-4" aria-hidden /> {title}
                      </span>
                      <span className="mt-1 block text-sm text-muted">{desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {sourceType === 'public' ? (
              <Field label="Repository URL" error={repoError} hint="Only https://github.com repositories are supported.">
                {(p) => <Input {...p} mono placeholder="https://github.com/owner/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />}
              </Field>
            ) : !status.data?.githubEnabled ? (
              <Notice tone="warn" title="GitHub App not configured">The server administrator has not configured a GitHub App. See docs/github-app.md, or use a public repository.</Notice>
            ) : installations.isLoading ? (
              <Spinner />
            ) : activeInstallations.length === 0 ? (
              <Notice tone="info" title="No GitHub installation connected" action={ws.can('github.connect') ? <Link className="text-sm underline" to={`/w/${ws.id}/settings`}>Connect GitHub</Link> : undefined}>
                {ws.can('github.connect') ? 'Connect the DeployForge GitHub App to this workspace first.' : 'Ask a workspace owner to connect GitHub.'}
              </Notice>
            ) : (
              <div className="space-y-4">
                <Field label="Installation">
                  {(p) => (
                    <Select {...p} value={installationId} onChange={(e) => { setInstallationId(e.target.value); setRepo(null); setRepoPage(1); }}>
                      <option value="">Select an installation</option>
                      {activeInstallations.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.accountLogin} ({i.accountType})
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {installationId && (
                  <div>
                    <Input aria-label="Filter repositories" placeholder="Filter this page" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} className="mb-2" />
                    {repos.isLoading ? (
                      <Spinner label="Loading repositories" />
                    ) : repos.error ? (
                      <Notice tone="danger">{errorMessage(repos.error)}</Notice>
                    ) : (
                      <>
                        <ul className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border" aria-label="Repositories">
                          {repos.data?.items
                            .filter((r) => r.fullName.toLowerCase().includes(repoFilter.toLowerCase()))
                            .map((r) => (
                              <li key={r.id}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRepo(r);
                                    setBranch(r.defaultBranch);
                                    if (!name) setName2(r.fullName.split('/')[1] ?? '');
                                  }}
                                  className={cn('flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2', repo?.id === r.id && 'bg-accent/10')}
                                  aria-pressed={repo?.id === r.id}
                                >
                                  <Mono>{r.fullName}</Mono>
                                  {r.private && <Lock className="size-3.5 text-muted" aria-label="Private" />}
                                </button>
                              </li>
                            ))}
                        </ul>
                        <div className="mt-2 flex items-center justify-between text-sm text-muted">
                          <span>{repos.data?.total ?? 0} repositories</span>
                          <span className="flex gap-2">
                            <Button size="sm" disabled={repoPage === 1} onClick={() => setRepoPage(repoPage - 1)}>
                              Previous
                            </Button>
                            <Button size="sm" disabled={!repos.data?.nextCursor} onClick={() => setRepoPage(repoPage + 1)}>
                              Next
                            </Button>
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            {sourceType === 'github' && repo ? (
              <Field label="Branch" hint="Pushes to this branch deploy automatically when auto-deploy is on.">
                {(p) =>
                  branches.isLoading ? (
                    <Spinner label="Loading branches" />
                  ) : (
                    <Select {...p} value={branch} onChange={(e) => setBranch(e.target.value)}>
                      {(branches.data?.items ?? [branch]).map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </Select>
                  )
                }
              </Field>
            ) : (
              <Field label="Branch" hint="Each deployment records the exact commit SHA at the branch head when you deploy.">
                {(p) => <Input {...p} mono value={branch} onChange={(e) => setBranch(e.target.value)} />}
              </Field>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Application name">{(p) => <Input {...p} value={name} onChange={(e) => setName2(e.target.value)} />}</Field>
            <Field label="Slug" error={slugError} hint={status.data ? <>Served at <Mono>{slug || 'slug'}.{status.data.appsDomain}</Mono></> : undefined}>
              {(p) => <Input {...p} mono value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />}
            </Field>
            <Field label="Project">
              {(p) => (
                <Select {...p} value={project} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.data?.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div />
            <Field label="Build context directory" error={ctxError} hint="Relative to the repository root. Use . for the root.">
              {(p) => <Input {...p} mono value={contextDir} onChange={(e) => setContextDir(e.target.value)} />}
            </Field>
            <Field label="Dockerfile path" error={dfError} hint="Relative to the repository root.">
              {(p) => <Input {...p} mono value={dockerfilePath} onChange={(e) => setDockerfilePath(e.target.value)} />}
            </Field>
            <div className="sm:col-span-2">
              <Notice tone="info">Paths are checked again after cloning: they must exist inside the repository and must not leave it through <Mono>..</Mono> or symbolic links. The Dockerfile runs on this server during the build, so only deploy repositories you trust.</Notice>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <Notice tone="warn" title="Listen on the configured port">
              Your application must listen on port <Mono>{port}</Mono> on <Mono>0.0.0.0</Mono> (not <Mono>127.0.0.1</Mono>), otherwise health checks fail. DeployForge also sets the <Mono>PORT</Mono> variable.
            </Notice>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="Container port">{(p) => <Input {...p} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />}</Field>
              <Field label="Health check path" hint="Must return 2xx or 3xx.">{(p) => <Input {...p} mono value={health.path} onChange={(e) => setHealth({ ...health, path: e.target.value })} />}</Field>
              <Field label="Start period (s)" hint="Grace time before the first check.">
                {(p) => <Input {...p} type="number" min={0} max={600} value={health.startPeriodSeconds} onChange={(e) => setHealth({ ...health, startPeriodSeconds: Number(e.target.value) })} />}
              </Field>
              <Field label="Check timeout (s)">{(p) => <Input {...p} type="number" min={1} max={60} value={health.timeoutSeconds} onChange={(e) => setHealth({ ...health, timeoutSeconds: Number(e.target.value) })} />}</Field>
              <Field label="Check interval (s)">{(p) => <Input {...p} type="number" min={1} max={60} value={health.intervalSeconds} onChange={(e) => setHealth({ ...health, intervalSeconds: Number(e.target.value) })} />}</Field>
              <Field label="Attempts">{(p) => <Input {...p} type="number" min={1} max={100} value={health.retries} onChange={(e) => setHealth({ ...health, retries: Number(e.target.value) })} />}</Field>
              <Field label="CPU limit (cores)" hint={`${LIMITS.cpu.min}–${LIMITS.cpu.max}`}>
                {(p) => <Input {...p} type="number" step={0.1} min={LIMITS.cpu.min} max={LIMITS.cpu.max} value={cpuLimit} onChange={(e) => setCpu(Number(e.target.value))} />}
              </Field>
              <Field label="Memory limit (MB)" hint={`${LIMITS.memoryMb.min}–${LIMITS.memoryMb.max}`}>
                {(p) => <Input {...p} type="number" min={LIMITS.memoryMb.min} max={LIMITS.memoryMb.max} value={memoryLimitMb} onChange={(e) => setMemory(Number(e.target.value))} />}
              </Field>
              <Field label="Security profile" hint="Strict drops all Linux capabilities; some images need standard.">
                {(p) => (
                  <Select {...p} value={securityProfile} onChange={(e) => setSecurity(e.target.value as 'standard' | 'strict')}>
                    <option value="standard">Standard</option>
                    <option value="strict">Strict</option>
                  </Select>
                )}
              </Field>
            </div>
            {sourceType === 'github' && (
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} label="Deploy automatically on push" />
                Deploy automatically when commits are pushed to <Mono>{branch}</Mono>
              </label>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Runtime variables are passed to the container. Build variables are available during <Mono>docker build</Mono>: non-secret ones as build arguments, secret ones only through{' '}
              <Mono>RUN --mount=type=secret,id=NAME</Mono>. Secret values are encrypted and never shown again.
            </p>
            {env.length === 0 && <p className="text-sm text-muted">No variables yet.</p>}
            {env.map((row, i) => (
              <div key={i} className="grid items-start gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_1.4fr_auto_auto_auto]">
                <Field label="Name" error={envErrors[i]}>
                  {(p) => <Input {...p} mono value={row.key} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, key: e.target.value.toUpperCase() } : r)))} />}
                </Field>
                <Field label="Value">
                  {(p) => <Input {...p} mono type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />}
                </Field>
                <Field label="Scope">
                  {(p) => (
                    <Select {...p} value={row.scope} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, scope: e.target.value as EnvScope } : r)))}>
                      <option value="runtime">Runtime</option>
                      <option value="build">Build</option>
                    </Select>
                  )}
                </Field>
                <div className="space-y-1.5">
                  <span className="block text-sm font-medium">Secret</span>
                  <div className="flex h-9 items-center">
                    <Switch checked={row.secret} onCheckedChange={(v) => setEnv(env.map((r, j) => (j === i ? { ...r, secret: v } : r)))} label={`Secret ${row.key}`} />
                  </div>
                </div>
                <div className="flex h-full items-end">
                  <Button variant="ghost" aria-label={`Remove ${row.key || 'variable'}`} onClick={() => setEnv(env.filter((_, j) => j !== i))} icon={<Trash2 className="size-4" />} />
                </div>
              </div>
            ))}
            <Button icon={<Plus className="size-4" />} onClick={() => setEnv([...env, { key: '', value: '', scope: 'runtime', secret: true }])}>
              Add variable
            </Button>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4 text-sm">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
              <dt className="text-muted">Repository</dt>
              <dd><Mono>{sourceType === 'public' ? repoUrl : repo?.fullName}</Mono></dd>
              <dt className="text-muted">Branch</dt>
              <dd><Mono>{branch}</Mono></dd>
              <dt className="text-muted">Name / slug</dt>
              <dd>{name} · <Mono>{slug}</Mono></dd>
              <dt className="text-muted">Build</dt>
              <dd>context <Mono>{contextDir}</Mono>, Dockerfile <Mono>{dockerfilePath}</Mono></dd>
              <dt className="text-muted">Runtime</dt>
              <dd>port <Mono>{port}</Mono>, health <Mono>{health.path}</Mono>, {cpuLimit} CPU, {memoryLimitMb} MB, {securityProfile}</dd>
              <dt className="text-muted">Variables</dt>
              <dd>{env.length ? env.map((e) => e.key).join(', ') : 'none'}</dd>
              {sourceType === 'github' && (
                <>
                  <dt className="text-muted">Auto-deploy</dt>
                  <dd>{autoDeploy ? 'On' : 'Off'}</dd>
                </>
              )}
            </dl>
            <label className="flex items-center gap-3">
              <Switch checked={deployNow} onCheckedChange={setDeployNow} label="Deploy immediately" />
              Deploy immediately after creating
            </label>
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-border pt-4">
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={!stepValid[step]} onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void submit()}>
              {deployNow ? 'Create and deploy' : 'Create application'}
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}
