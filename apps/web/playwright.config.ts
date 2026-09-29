import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against a real DeployForge stack (API + worker + runner +
 * Caddy + the git fixture). Start it with `scripts/acceptance.sh up` or the
 * dev setup, then:
 *
 *   E2E_BASE_URL=http://localhost:5173 pnpm --filter @deployforge/web test:e2e
 *
 * PW_CHROMIUM_PATH lets environments with a preinstalled Chromium use it
 * instead of downloading Playwright's pinned build.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    storageState: 'test-results/.auth/owner.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
