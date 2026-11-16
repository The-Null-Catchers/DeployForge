import { expect, test } from '@playwright/test';
import {
  APPS_DOMAIN,
  fixtureShas,
  FIXTURE_REPO,
  login,
  OWNER,
  ownerApi,
  uniqueSlug,
  viaProxy,
} from './fixtures';

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('login rejects wrong credentials and accepts correct ones', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill('definitely wrong password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
});

test('create an application with variables, deploy it, and inspect status and logs', async ({
  page,
}) => {
  const slug = uniqueSlug('e2e');
  await login(page);
  await page.getByRole('link', { name: 'New application' }).first().click();

  // Repository
  await page.getByLabel('Repository URL').fill(FIXTURE_REPO);
  await page.getByRole('button', { name: 'Continue' }).click();
  // Branch
  await page.getByLabel('Branch').fill('release-a');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Build
  await page.getByLabel('Application name').fill(`E2E ${slug}`);
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Dockerfile path').fill('../Dockerfile');
  await expect(page.getByText('Path must not contain ".." segments')).toBeVisible();
  await page.getByLabel('Dockerfile path').fill('Dockerfile');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Runtime
  await page.getByLabel('Health check path').fill('/health');
  await page.getByLabel('Start period (s)').fill('1');
  await page.getByLabel('Check interval (s)').fill('1');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Variables
  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByLabel('Name').fill('GREETING');
  await page.getByLabel('Value').fill('hello from e2e');
  await page.getByRole('switch', { name: 'Secret GREETING' }).click(); // not secret
  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByLabel('Name').nth(1).fill('API_TOKEN');
  await page.getByLabel('Value').nth(1).fill('e2e-super-secret-token');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Review
  await expect(page.getByText('GREETING, API_TOKEN')).toBeVisible();
  await page.getByRole('button', { name: 'Create and deploy' }).click();

  // Deployment detail: live stages and logs
  await expect(page.getByRole('heading', { name: /Deployment #1/ })).toBeVisible();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('log')).toContainText('Built image');
  await expect(page.getByRole('log')).not.toContainText('e2e-super-secret-token');
  await expect(page.getByText('Traffic now routed to deployment #1')).toBeVisible();

  // The application answers through the proxy.
  const res = await viaProxy(`${slug}.${APPS_DOMAIN}`, '/version');
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body).version).toBe('A');
  const home = await viaProxy(`${slug}.${APPS_DOMAIN}`, '/');
  expect(home.body).toContain('hello from e2e');

  // Variables tab never shows the secret value.
  await page.getByRole('link', { name: 'Variables' }).click();
  await expect(page.getByRole('cell', { name: 'GREETING', exact: true })).toBeVisible();
  await expect(page.getByText('hello from e2e')).toBeVisible();
  await expect(page.getByLabel('Secret value hidden')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2e-super-secret-token');

  // Runtime logs stream.
  await page.getByRole('link', { name: 'Runtime logs' }).click();
  await expect(page.getByRole('log')).toContainText('listening on 0.0.0.0:3000', {
    timeout: 30_000,
  });
});

test('configure variables: add, replace without revealing, delete', async ({ page }) => {
  const { api, csrf, workspaceId } = await ownerApi();
  const projects = await (await api.get(`/api/workspaces/${workspaceId}/projects`)).json();
  const slug = uniqueSlug('vars');
  const app = await (
    await api.post(`/api/workspaces/${workspaceId}/apps`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        projectId: projects[0].id,
        name: slug,
        slug,
        source: { type: 'public', repoUrl: FIXTURE_REPO },
        branch: 'release-a',
      },
    })
  ).json();
  await login(page);
  await page.goto(`/w/${workspaceId}/apps/${app.id}/variables`);
  await page.getByRole('button', { name: 'Add variable' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('DB_PASSWORD');
  await dialog.getByLabel('Value').fill('first-secret-value');
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  await expect(page.getByRole('cell', { name: 'DB_PASSWORD', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Replace DB_PASSWORD' }).click();
  await expect(page.getByRole('dialog')).toContainText('The current value is never shown');
  await expect(page.getByRole('dialog').getByLabel('Value')).toHaveValue('');
  await page.getByRole('dialog').getByLabel('Value').fill('second-secret-value');
  await page.getByRole('dialog').getByRole('button', { name: 'Replace value' }).click();
  await expect(page.getByText(/Revision r3/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete DB_PASSWORD' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete variable' }).click();
  await expect(page.getByText('No variables')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('secret-value');
});

test('manage domain configuration', async ({ page }) => {
  const { api, csrf, workspaceId } = await ownerApi();
  const projects = await (await api.get(`/api/workspaces/${workspaceId}/projects`)).json();
  const slug = uniqueSlug('dom');
  const app = await (
    await api.post(`/api/workspaces/${workspaceId}/apps`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        projectId: projects[0].id,
        name: slug,
        slug,
        source: { type: 'public', repoUrl: FIXTURE_REPO },
        branch: 'release-a',
      },
    })
  ).json();
  await login(page);
  await page.goto(`/w/${workspaceId}/apps/${app.id}/domains`);
  await expect(page.getByText(`${slug}.${APPS_DOMAIN}`)).toBeVisible();
  await page.getByLabel('Hostname').fill('not a hostname');
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByText('Enter a fully-qualified domain name')).toBeVisible();
  const host = `${slug}.example.test`;
  await page.getByLabel('Hostname').fill(host);
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByText('Pending verification')).toBeVisible();
  await expect(page.getByText(`_deployforge-challenge.${host}`)).toBeVisible();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/TXT (lookup failed|record)/)).toBeVisible();
  await page.getByRole('button', { name: `Remove ${host}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove domain' }).click();
  await expect(page.getByText(host, { exact: true })).toHaveCount(0);
});

test('request a rollback to a retained release', async ({ page }) => {
  const shas = await fixtureShas();
  const { api, csrf, workspaceId } = await ownerApi();
  const projects = await (await api.get(`/api/workspaces/${workspaceId}/projects`)).json();
  const slug = uniqueSlug('rb');
  const app = await (
    await api.post(`/api/workspaces/${workspaceId}/apps`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        projectId: projects[0].id,
        name: slug,
        slug,
        source: { type: 'public', repoUrl: FIXTURE_REPO },
        branch: 'release-a',
        healthCheck: {
          path: '/health',
          intervalSeconds: 1,
          startPeriodSeconds: 1,
          retries: 20,
          timeoutSeconds: 3,
        },
      },
    })
  ).json();
  const waitFor = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const d = await (await api.get(`/api/deployments/${id}`)).json();
      if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(d.status)) return d;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('deployment did not finish');
  };
  const d1 = await (
    await api.post(`/api/apps/${app.id}/deployments`, {
      headers: { 'x-csrf-token': csrf },
      data: { commitSha: shas.A },
    })
  ).json();
  expect((await waitFor(d1.id)).status).toBe('succeeded');
  const d2 = await (
    await api.post(`/api/apps/${app.id}/deployments`, {
      headers: { 'x-csrf-token': csrf },
      data: { commitSha: shas.B },
    })
  ).json();
  expect((await waitFor(d2.id)).status).toBe('succeeded');
  expect(JSON.parse((await viaProxy(`${slug}.${APPS_DOMAIN}`, '/version')).body).version).toBe('B');

  await login(page);
  await page.goto(`/w/${workspaceId}/apps/${app.id}/deployments`);
  await page.getByRole('row', { name: /#1/ }).getByRole('button', { name: 'Roll back' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Nothing is rebuilt');
  await expect(dialog).toContainText('expired or been revoked');
  await expect(dialog).toContainText('does not undo database migrations');
  await dialog.getByRole('button', { name: 'Roll back to #1' }).click();
  await expect(page.getByRole('heading', { name: /Deployment #3/ })).toBeVisible();
  await expect(page.getByText(/using its retained image/)).toBeVisible();
  await expect(page.getByText('Succeeded').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Reused image').first()).toBeVisible();
  expect(JSON.parse((await viaProxy(`${slug}.${APPS_DOMAIN}`, '/version')).body).version).toBe('A');
});

test('viewer role cannot change anything (UI and API)', async ({ page, browser }) => {
  const { api, csrf, workspaceId } = await ownerApi();
  const email = `${uniqueSlug('viewer')}@example.com`;
  const inv = await (
    await api.post(`/api/workspaces/${workspaceId}/invites`, {
      headers: { 'x-csrf-token': csrf },
      data: { email, role: 'viewer' },
    })
  ).json();
  const token = String(inv.inviteUrl).split('/invite/')[1];
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const vp = await ctx.newPage();
  await vp.goto(`/invite/${token}`);
  await expect(vp.getByText(/invited as viewer/)).toBeVisible();
  await vp.getByLabel('Your name').fill('Vera Viewer');
  await vp.getByLabel('Choose a password').fill('viewer password 123');
  await vp.getByRole('button', { name: 'Accept invitation' }).click();
  await vp.waitForURL(/\/w\//);
  const projects = await (await api.get(`/api/workspaces/${workspaceId}/projects`)).json();
  const appId = projects.flatMap((p: { applications: { id: string }[] }) => p.applications)[0]?.id;
  expect(appId).toBeTruthy();
  await vp.goto(`/w/${workspaceId}/apps/${appId}`);
  await expect(vp.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Deploy' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(vp.getByRole('link', { name: 'New application' })).toHaveCount(0);
  await vp.goto(`/w/${workspaceId}/apps/${appId}/variables`);
  await expect(vp.getByRole('button', { name: 'Add variable' })).toHaveCount(0);
  // The server enforces the same rules if the UI is bypassed.
  const csrfV = await vp.evaluate(
    async () => (await (await fetch('/api/auth/me')).json()).csrfToken,
  );
  const status = await vp.evaluate(
    async ([id, token]) =>
      (
        await fetch(`/api/apps/${id}/deployments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token as string },
          body: '{}',
        })
      ).status,
    [appId, csrfV],
  );
  expect(status).toBe(403);
  await ctx.close();
  void page;
});
