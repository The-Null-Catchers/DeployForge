import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLink, FolderPlus, GitBranch, Plus, Rocket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { ApplicationSummary, AppRuntimeState } from '@deployforge/contracts';
import { errorMessage, post } from '../api/client';
import { keys, useAction, useProjects } from '../api/queries';
import { useWorkspace } from '../auth/session';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Mono, PageHeader, RelativeTime, Skeleton, StatusBadge, type Tone } from '../components/ui';

const STATE: Record<AppRuntimeState, [Tone, string]> = {
  running: ['ok', 'Running'],
  deploying: ['warn', 'Deploying'],
  degraded: ['danger', 'Degraded'],
  stopped: ['neutral', 'Stopped'],
  not_deployed: ['neutral', 'Not deployed'],
  unknown: ['neutral', 'Unknown'],
};

export function RuntimeBadge({ state }: { state: AppRuntimeState }) {
  const [tone, label] = STATE[state];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

function AppCard({ app, ws }: { app: ApplicationSummary; ws: string }) {
  const latest = app.latestDeployment;
  return (
    <Link to={`/w/${ws}/apps/${app.id}`} className="group block rounded-lg border border-border bg-surface p-4 transition-colors hover:border-muted/50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-fg group-hover:underline">{app.name}</h3>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted">
            <GitBranch className="size-3.5 shrink-0" aria-hidden />
            <Mono>{app.repoFullName}</Mono>
            <span aria-hidden>·</span>
            <Mono>{app.branch}</Mono>
          </p>
        </div>
        <RuntimeBadge state={app.runtimeState} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted">
        {latest ? (
          <span className="flex items-center gap-2">
            <StatusBadge status={latest.status} />
            <span>
              #{latest.number} <Mono>{latest.commitSha?.slice(0, 7)}</Mono> · <RelativeTime iso={latest.createdAt} />
            </span>
          </span>
        ) : (
          <span>No deployments yet</span>
        )}
        {app.url && (
          <span className="flex items-center gap-1 truncate">
            <Mono className="truncate">{app.url.replace(/^https?:\/\//, '')}</Mono>
            <ExternalLink className="size-3" aria-hidden />
          </span>
        )}
      </div>
    </Link>
  );
}

function NewProjectDialog({ ws }: { ws: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((n: string) => post(`/api/workspaces/${ws}/projects`, { name: n }), [keys.projects(ws)]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync(name);
      setOpen(false);
      setName('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button icon={<FolderPlus className="size-4" />}>New project</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6">
          <Dialog.Title className="font-semibold">New project</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">Projects group related applications.</Dialog.Description>
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Name" error={error}>{(p) => <Input {...p} autoFocus required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" loading={create.isPending}>
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function WorkspaceOverview() {
  const ws = useWorkspace();
  const projects = useProjects(ws.id);
  const total = projects.data?.reduce((n, p) => n + p.applications.length, 0) ?? 0;
  return (
    <>
      <PageHeader
        title={ws.name}
        description="Projects and applications in this workspace."
        actions={
          <>
            {ws.can('project.create') && <NewProjectDialog ws={ws.id} />}
            {ws.can('app.create') && (
              <Link to={`/w/${ws.id}/new`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg hover:opacity-90">
                <Plus className="size-4" aria-hidden /> New application
              </Link>
            )}
          </>
        }
      />
      {projects.isLoading && (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {projects.error && <ErrorState error={projects.error} retry={() => void projects.refetch()} />}
      {projects.data && total === 0 && (
        <EmptyState icon={<Rocket className="size-8" />} title="Deploy your first application" action={ws.can('app.create') && <Link to={`/w/${ws.id}/new`} className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-accent-fg">New application</Link>}>
          Point DeployForge at a GitHub repository with a Dockerfile. It builds the image, starts it, checks its health and routes traffic to it.
          {!ws.can('app.create') && ' Ask a developer or owner to create one.'}
        </EmptyState>
      )}
      <div className="space-y-8">
        {projects.data
          ?.filter((p) => p.applications.length > 0 || total > 0)
          .map((p) => (
            <section key={p.id} aria-labelledby={`p-${p.id}`}>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 id={`p-${p.id}`} className="text-sm font-semibold">
                  {p.name} <span className="font-normal text-muted">· {p.applications.length} app{p.applications.length === 1 ? '' : 's'}</span>
                </h2>
                {ws.can('app.create') && (
                  <Link to={`/w/${ws.id}/new?project=${p.id}`} className="text-sm text-muted hover:text-fg">
                    Add application
                  </Link>
                )}
              </div>
              {p.applications.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No applications in this project.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {p.applications.map((a) => (
                    <AppCard key={a.id} app={a} ws={ws.id} />
                  ))}
                </div>
              )}
            </section>
          ))}
      </div>
    </>
  );
}
