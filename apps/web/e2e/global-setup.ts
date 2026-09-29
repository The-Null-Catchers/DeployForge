import { chromium, type FullConfig } from '@playwright/test';
import { ensureOwner, OWNER } from './fixtures';

export const STORAGE = 'test-results/.auth/owner.json';

/** Sign in once through the real login page and reuse the session in all tests. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  await ensureOwner();
  const use = config.projects[0]!.use;
  const browser = await chromium.launch(use.launchOptions);
  const page = await browser.newPage({ baseURL: use.baseURL });
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/w\/[a-z0-9]+/);
  await page.context().storageState({ path: STORAGE });
  await browser.close();
}
