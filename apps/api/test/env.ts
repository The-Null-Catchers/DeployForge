import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Test environment. Uses TEST_DATABASE_URL / TEST_REDIS_URL when set (CI),
 * otherwise derives a separate `deployforge_test` database from the
 * repository .env used for local development.
 */
export function testEnv(): { databaseUrl: string; adminUrl: string; redisUrl: string } {
  const envFile = resolve(__dirname, '..', '..', '..', '.env');
  if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Set TEST_DATABASE_URL (or run `node scripts/setup.mjs --dev` and start dev infra)');
  const u = new URL(base);
  const admin = new URL(base);
  admin.pathname = '/postgres';
  if (!process.env.TEST_DATABASE_URL) u.pathname = '/deployforge_test';
  const redis = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const r = new URL(redis);
  if (!process.env.TEST_REDIS_URL) r.pathname = '/5';
  return { databaseUrl: u.toString(), adminUrl: admin.toString(), redisUrl: r.toString() };
}
