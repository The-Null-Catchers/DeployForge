import { createBrowserRouter, Navigate } from 'react-router';
import { SessionGate, useSession } from './auth/session';
import { AppShell } from './components/AppShell';
import { AcceptInvitePage, GithubResultPage, LoginPage, SetupPage } from './pages/auth';
import { WorkspaceOverview } from './pages/WorkspaceOverview';
import { NewAppWizard } from './pages/NewAppWizard';
import { AppLayout, AppOverview } from './pages/app/AppLayout';
import { DeploymentsPage } from './pages/app/Deployments';
import { DeploymentDetail } from './pages/app/DeploymentDetail';
import { RuntimeLogsPage } from './pages/app/RuntimeLogs';
import { VariablesPage } from './pages/app/Variables';
import { DomainsPage } from './pages/app/Domains';
import { MetricsPage } from './pages/app/Metrics';
import { AppSettingsPage } from './pages/app/Settings';
import { MembersPage } from './pages/Members';
import { ActivityPage } from './pages/Activity';
import { WorkspaceSettingsPage } from './pages/WorkspaceSettings';
import { DiagnosticsPage } from './pages/Diagnostics';
import { AccountPage } from './pages/Account';

function Home() {
  const s = useSession();
  return <Navigate to={`/w/${s.workspaces[0]?.id ?? ''}`} replace />;
}

function NotFound() {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-muted">The page does not exist, or you do not have access to it.</p>
        <a href="/" className="mt-4 inline-block text-sm text-accent underline">
          Back to the dashboard
        </a>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  { path: '/github/result', element: <GithubResultPage /> },
  {
    path: '/',
    element: (
      <SessionGate>
        <Home />
      </SessionGate>
    ),
  },
  {
    path: '/w/:ws',
    element: (
      <SessionGate>
        <AppShell />
      </SessionGate>
    ),
    children: [
      { index: true, element: <WorkspaceOverview /> },
      { path: 'new', element: <NewAppWizard /> },
      {
        path: 'apps/:appId',
        element: <AppLayout />,
        children: [
          { index: true, element: <AppOverview /> },
          { path: 'deployments', element: <DeploymentsPage /> },
          { path: 'deployments/:deploymentId', element: <DeploymentDetail /> },
          { path: 'logs', element: <RuntimeLogsPage /> },
          { path: 'variables', element: <VariablesPage /> },
          { path: 'domains', element: <DomainsPage /> },
          { path: 'metrics', element: <MetricsPage /> },
          { path: 'settings', element: <AppSettingsPage /> },
        ],
      },
      { path: 'members', element: <MembersPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'settings', element: <WorkspaceSettingsPage /> },
      { path: 'diagnostics', element: <DiagnosticsPage /> },
      { path: 'account', element: <AccountPage /> },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
