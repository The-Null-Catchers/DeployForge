import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import { can, type Permission, type SessionInfo, type WorkspaceSummary } from '@deployforge/contracts';
import { ApiError, onUnauthorized, setCsrfToken } from '../api/client';
import { keys, useMe, useStatus } from '../api/queries';
import { Spinner } from '../components/ui';

const SessionContext = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionGate');
  return s;
}

/** Current workspace from the URL, with role-based permission checks for UI only. */
export function useWorkspace(): WorkspaceSummary & { can: (p: Permission) => boolean } {
  const session = useSession();
  const { ws } = useParams();
  const w = session.workspaces.find((x) => x.id === ws) ?? session.workspaces[0];
  if (!w) throw new Error('No workspace');
  return { ...w, can: (p: Permission) => can(w.role, p) };
}

/** Requires an authenticated session; redirects to setup/login otherwise. */
export function SessionGate({ children }: { children: ReactNode }) {
  const status = useStatus();
  const me = useMe();
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => onUnauthorized(() => void qc.invalidateQueries({ queryKey: keys.me })), [qc]);
  useEffect(() => setCsrfToken(me.data?.csrfToken), [me.data?.csrfToken]);

  const value = useMemo(() => me.data ?? null, [me.data]);
  if (status.isLoading || me.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner label="Loading DeployForge" />
      </div>
    );
  }
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (me.error || !value) {
    const unauth = me.error instanceof ApiError && me.error.status === 401;
    if (!unauth && me.error) {
      return (
        <div className="grid h-full place-items-center p-6 text-center text-sm text-muted">
          <div>
            <p className="font-medium text-fg">The DeployForge server could not be reached.</p>
            <p className="mt-1">Check that the API is running, then reload.</p>
          </div>
        </div>
      );
    }
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function RequirePermission({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  const w = useWorkspace();
  return <>{w.can(permission) ? children : fallback}</>;
}
