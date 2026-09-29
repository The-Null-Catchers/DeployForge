import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { clsx } from 'clsx';
import { AlertTriangle, Check, CircleAlert, Copy, Info, Loader2 } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { DeploymentStatus } from '@deployforge/contracts';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-surface text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90 dark:text-black',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(({ className, mono, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg placeholder:text-muted/70 aria-[invalid=true]:border-danger',
      mono && 'font-mono',
      className,
    )}
    {...rest}
  />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={cn('h-9 rounded-md border border-border bg-surface px-2.5 text-sm text-fg', !/\bw-/.test(className ?? '') && 'w-full', className)} {...rest}>
    {children}
  </select>
));
Select.displayName = 'Select';

/** Label + control + hint/error, wired with aria attributes. */
export function Field({ label, hint, error, children, id: idProp }: { label: string; hint?: ReactNode; error?: string | null; children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode; id?: string }) {
  const auto = useId();
  const id = idProp ?? auto;
  const descId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': descId })}
      {error ? (
        <p id={descId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Card({ title, actions, children, className, description }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div>
            {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const tones = {
  ok: 'bg-ok/12 text-ok ring-ok/25',
  warn: 'bg-warn/12 text-warn ring-warn/25',
  danger: 'bg-danger/12 text-danger ring-danger/25',
  info: 'bg-info/12 text-info ring-info/25',
  neutral: 'bg-surface-2 text-muted ring-border',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', tones[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  cloning: 'Cloning',
  building: 'Building',
  starting: 'Starting',
  checking_health: 'Health check',
  promoting: 'Promoting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
};
export function statusTone(s: DeploymentStatus): Tone {
  if (s === 'succeeded') return 'ok';
  if (s === 'failed' || s === 'interrupted') return 'danger';
  if (s === 'canceled') return 'neutral';
  return 'warn';
}
export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const running = !['succeeded', 'failed', 'canceled', 'interrupted'].includes(status);
  return (
    <Badge tone={statusTone(status)}>
      {running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} aria-hidden />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warn' ? AlertTriangle : tone === 'ok' ? Check : Info;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', tone === 'danger' ? 'border-danger/30 bg-danger/8' : tone === 'warn' ? 'border-warn/30 bg-warn/8' : tone === 'ok' ? 'border-ok/30 bg-ok/8' : 'border-info/30 bg-info/8')}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', { info: 'text-info', warn: 'text-warn', danger: 'text-danger', ok: 'text-ok' }[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className="text-muted [&_code]:font-mono">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return <Notice tone="danger" title="Could not load this page" action={retry && <Button size="sm" onClick={retry}>Retry</Button>}>{msg}</Notice>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('font-mono text-[0.85em]', className)}>{children}</code>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}
      icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
    >
      <span className="sr-only sm:not-sr-only">{copied ? 'Copied' : label}</span>
    </Button>
  );
}

export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted">—</span>;
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  const text =
    diff < 45 ? 'just now' : diff < 3600 ? `${Math.round(diff / 60)} min ago` : diff < 86400 ? `${Math.round(diff / 3600)} h ago` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <time dateTime={iso} title={d.toLocaleString()}>
      {text}
    </time>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function Switch({ checked, onCheckedChange, label, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

/**
 * Confirmation for dangerous actions. `consequences` explains what will
 * happen; `confirmText` (optional) must be typed exactly to proceed.
 */
export function ConfirmDialog({
  trigger,
  title,
  consequences,
  confirmLabel,
  confirmText,
  danger = true,
  onConfirm,
  busy,
}: {
  trigger: ReactNode;
  title: string;
  consequences: ReactNode;
  confirmLabel: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setTyped('');
        setError(null);
      }}
    >
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold text-fg">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-2 text-sm text-muted">{consequences}</div>
          </AlertDialog.Description>
          {confirmText && (
            <div className="mt-4 space-y-1.5">
              <label htmlFor={inputId} className="text-sm text-fg">
                Type <Mono className="rounded bg-surface-2 px-1">{confirmText}</Mono> to confirm
              </label>
              <Input id={inputId} mono autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              disabled={!!confirmText && typed !== confirmText}
              onClick={async () => {
                try {
                  setError(null);
                  await onConfirm();
                  setOpen(false);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-muted">{breadcrumb}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
