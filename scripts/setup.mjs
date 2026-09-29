#!/usr/bin/env node
// DeployForge setup: generates a .env with fresh secrets.
//
//   node scripts/setup.mjs --dev
//   node scripts/setup.mjs --domain deployforge.example.com --apps-domain apps.example.com --email ops@example.com
//
// Safety: never overwrites an existing .env, never touches firewalls or
// system configuration, never resets data. Secrets are printed only once.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(opt('output') ?? join(root, '.env'));

if (existsSync(out)) {
  console.error(`${out} already exists. Refusing to overwrite it.`);
  console.error('Edit it by hand, or move it away first if you really want new secrets');
  console.error('(new master keys make existing encrypted variables unreadable).');
  process.exit(1);
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const masterKey = randomBytes(32).toString('base64');
const values = {
  SETUP_TOKEN: secret(24),
  SESSION_SECRET: secret(48),
  DEPLOYFORGE_MASTER_KEYS: `k1:${masterKey}`,
  DEPLOYFORGE_ACTIVE_KEY_ID: 'k1',
  RUNNER_SHARED_SECRET: secret(48),
  PROXY_PROBE_TOKEN: secret(24),
  POSTGRES_PASSWORD: secret(24),
};

let text;
if (flag('dev')) {
  mkdirSync(join(root, '.tmp', 'caddy-admin'), { recursive: true });
  text = `# DeployForge local development (generated ${new Date().toISOString()})
NODE_ENV=development
PUBLIC_URL=http://localhost:5173
DATABASE_URL=postgresql://deployforge:${values.POSTGRES_PASSWORD}@127.0.0.1:5432/deployforge
POSTGRES_PASSWORD=${values.POSTGRES_PASSWORD}
REDIS_URL=redis://127.0.0.1:6379
SETUP_TOKEN=${values.SETUP_TOKEN}
SESSION_SECRET=${values.SESSION_SECRET}
DEPLOYFORGE_MASTER_KEYS=${values.DEPLOYFORGE_MASTER_KEYS}
DEPLOYFORGE_ACTIVE_KEY_ID=k1
RUNNER_URL=http://127.0.0.1:7070
RUNNER_SHARED_SECRET=${values.RUNNER_SHARED_SECRET}
RUNNER_WORK_DIR=${join(root, '.tmp', 'runner-work')}
PROXY_PROBE_TOKEN=${values.PROXY_PROBE_TOKEN}
CADDY_ADMIN_URL=unix://${join(root, '.tmp', 'caddy-admin', 'admin.sock')}
CADDY_PROBE_URL=http://127.0.0.1:9080
APPS_DOMAIN=localhost
APPS_URL_SCHEME=http
APPS_PUBLIC_PORT=8080
TLS_MODE=off
GITHUB_MODE=disabled
`;
} else {
  const domain = opt('domain');
  const appsDomain = opt('apps-domain');
  const email = opt('email');
  if (!domain || !appsDomain || !email) {
    console.error('Usage: node scripts/setup.mjs --domain <dashboard host> --apps-domain <apps base domain> --email <ACME email> [--public-ip <ipv4>]');
    console.error('   or: node scripts/setup.mjs --dev');
    process.exit(2);
  }
  const template = readFileSync(join(root, '.env.example'), 'utf8');
  text = template
    .replace(/^PUBLIC_URL=.*$/m, `PUBLIC_URL=https://${domain}`)
    .replace(/^DASHBOARD_HOSTNAME=.*$/m, `DASHBOARD_HOSTNAME=${domain}`)
    .replace(/^APPS_DOMAIN=.*$/m, `APPS_DOMAIN=${appsDomain}`)
    .replace(/^ACME_EMAIL=.*$/m, `ACME_EMAIL=${email}`)
    .replace(/^PUBLIC_IPV4=.*$/m, `PUBLIC_IPV4=${opt('public-ip') ?? ''}`);
  for (const [k, v] of Object.entries(values)) text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
}

writeFileSync(out, text, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Wrote ${out} (mode 600).`);
console.log('');
console.log(`First-run setup token: ${values.SETUP_TOKEN}`);
console.log('');
console.log('IMPORTANT: back up DEPLOYFORGE_MASTER_KEYS separately from database backups.');
console.log('Without it, encrypted environment variables cannot be recovered. See docs/operations.md.');
