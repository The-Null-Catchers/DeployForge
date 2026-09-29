import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, Boxes, ChevronsUpDown, LayoutGrid, LogOut, Menu, Monitor, Moon, Settings, Stethoscope, Sun, User, Users, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { post, setCsrfToken } from '../api/client';
import { useSession, useWorkspace } from '../auth/session';
import { useTheme } from '../lib/theme';
import { cn } from './ui';

function NavItem({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors', isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')
      }
    >
      <span className="size-4 shrink-0 [&>svg]:size-4" aria-hidden>
        {icon}
      </span>
      {children}
    </NavLink>
  );
}

const menuItem = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2';

export function AppShell() {
  const session = useSession();
  const ws = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isOwner = session.user.isInstanceAdmin || session.workspaces.some((w) => w.role === 'owner');

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setCsrfToken(undefined);
    qc.clear();
    navigate('/login', { replace: true });
  };

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 p-3">
      <div className="flex items-center gap-2 px-1.5 pt-1">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="font-semibold tracking-tight">DeployForge</span>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="flex w-full items-center justify-between rounded-md border border-border bg-surface px-2.5 py-2 text-left text-sm" aria-label="Switch workspace">
          <span className="min-w-0">
            <span className="block truncate font-medium">{ws.name}</span>
            <span className="block text-xs text-muted capitalize">{ws.role}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted" aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg">
            <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">Workspaces</DropdownMenu.Label>
            {session.workspaces.map((w) => (
              <DropdownMenu.Item key={w.id} className={menuItem} onSelect={() => navigate(`/w/${w.id}`)}>
                <span className="flex-1 truncate">{w.name}</span>
                <span className="text-xs text-muted capitalize">{w.role}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <div className="space-y-0.5">
        <NavItem to={`/w/${ws.id}`} end icon={<LayoutGrid />}>
          Overview
        </NavItem>
        <NavItem to={`/w/${ws.id}/members`} icon={<Users />}>
          Members
        </NavItem>
        {ws.can('audit.read') && (
          <NavItem to={`/w/${ws.id}/activity`} icon={<Activity />}>
            Activity
          </NavItem>
        )}
        <NavItem to={`/w/${ws.id}/settings`} icon={<Settings />}>
          Workspace settings
        </NavItem>
      </div>
      <div className="space-y-0.5">
        <p className="px-2.5 text-xs font-medium tracking-wide text-muted uppercase">Platform</p>
        {isOwner && (
          <NavItem to={`/w/${ws.id}/diagnostics`} icon={<Stethoscope />}>
            Diagnostics
          </NavItem>
        )}
        <a href="/api/docs" className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">
          <Boxes className="size-4" aria-hidden /> API reference
        </a>
      </div>
      <div className="mt-auto">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm hover:bg-surface-2" aria-label="Account menu">
            <span className="grid size-7 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{session.user.name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{session.user.name}</span>
              <span className="block truncate text-xs text-muted">{session.user.email}</span>
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="top" align="start" sideOffset={4} className="z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg">
              <DropdownMenu.Item className={menuItem} onSelect={() => navigate(`/w/${ws.id}/account`)}>
                <User className="size-4" aria-hidden /> Account and sessions
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">Theme</DropdownMenu.Label>
              {(
                [
                  ['system', Monitor, 'System'],
                  ['light', Sun, 'Light'],
                  ['dark', Moon, 'Dark'],
                ] as const
              ).map(([value, Icon, label]) => (
                <DropdownMenu.CheckboxItem key={value} checked={theme === value} className={menuItem} onSelect={() => setTheme(value)}>
                  <Icon className="size-4" aria-hidden /> {label}
                </DropdownMenu.CheckboxItem>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item className={menuItem} onSelect={() => void logout()}>
                <LogOut className="size-4" aria-hidden /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-surface" onClick={(e) => (e.target as HTMLElement).closest('a') && setMobileOpen(false)}>
            <button className="absolute top-3 right-3 rounded p-1 text-muted" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded p-1" aria-label="Open navigation">
            <Menu className="size-5" />
          </button>
          <span className="font-semibold">DeployForge</span>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
