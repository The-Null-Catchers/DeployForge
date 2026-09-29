import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { testEnv } from './env';

/** Recreate the test database and apply the committed migrations. */
export default async function setup(): Promise<void> {
  const env = testEnv();
  const dbName = new URL(env.databaseUrl).pathname.slice(1);
  if (!process.env.TEST_DATABASE_URL) {
    const admin = new Client({ connectionString: env.adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
  }
  execFileSync(process.execPath, [resolve(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: env.databaseUrl },
    stdio: 'pipe',
  });
}
