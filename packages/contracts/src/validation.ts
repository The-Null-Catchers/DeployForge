import { z } from 'zod';

/**
 * Static configuration validation shared by the web client, the API and (as a
 * second line of defense) mirrored in the Go runner. Filesystem-level checks
 * such as symlink traversal can only happen after checkout and are done by the
 * runner against the real repository tree.
 */

export const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const slugSchema = z
  .string()
  .regex(SLUG_RE, 'Use 3-40 lowercase letters, digits and dashes, starting with a letter')
  .refine((s) => !s.includes('--'), 'Consecutive dashes are not allowed');

export const RESERVED_SLUGS = new Set([
  'api',
  'www',
  'admin',
  'dashboard',
  'app',
  'deployforge',
  'caddy',
  'runner',
  'status',
  'mail',
]);

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the platform injects or that would break containers if overridden. */
export const RESERVED_ENV_NAMES = new Set(['PORT', 'HOSTNAME', 'DEPLOYFORGE_RELEASE_ID']);
export const envNameSchema = z
  .string()
  .regex(ENV_NAME_RE, 'Must start with a letter or underscore and contain only A-Z, 0-9 and _')
  .refine((n) => !n.startsWith('DEPLOYFORGE_'), 'The DEPLOYFORGE_ prefix is reserved')
  .refine((n) => !RESERVED_ENV_NAMES.has(n), 'This name is reserved by the platform');

export const MAX_ENV_VALUE_BYTES = 32 * 1024;

/**
 * Validate a repository-relative path (build context or Dockerfile). Rejects
 * absolute paths, parent traversal, control characters and oddities that the
 * runner would reject anyway.
 */
export function checkRelativePath(input: string): string | null {
  if (input.length === 0) return 'Path must not be empty';
  if (input.length > 255) return 'Path is too long';
  if (input.startsWith('/') || input.startsWith('\\')) return 'Path must be relative to the repository root';
  if (/[\x00-\x1f\x7f\\]/.test(input)) return 'Path contains unsupported characters';
  if (!/^[A-Za-z0-9._\-/ @+]+$/.test(input)) return 'Path contains unsupported characters';
  if (input.split('/').some((p) => p === '..')) return 'Path must not contain ".." segments';
  return null;
}

export function normalizeRelativePath(input: string): string {
  const parts = input.split('/').filter((p) => p !== '' && p !== '.');
  return parts.length === 0 ? '.' : parts.join('/');
}

export const relativePathSchema = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const err = checkRelativePath(v);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  })
  .transform(normalizeRelativePath);

/** Only HTTPS GitHub repositories are supported in v1. */
export const GITHUB_REPO_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export interface ParsedRepoUrl {
  host: string;
  owner: string;
  name: string;
  /** Canonical clone URL without credentials. */
  cloneUrl: string;
  fullName: string;
}

/**
 * Parse a repository URL. `extraAllowedHosts` exists only for the hermetic
 * acceptance-test git fixture and is never enabled in production config.
 */
export function parseRepoUrl(
  url: string,
  extraAllowedHosts: readonly string[] = [],
): ParsedRepoUrl | null {
  const trimmed = url.trim();
  const m = GITHUB_REPO_RE.exec(trimmed);
  if (m) {
    const owner = m[1]!;
    const name = m[2]!;
    if (name === '.' || name === '..') return null;
    return {
      host: 'github.com',
      owner,
      name,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      fullName: `${owner}/${name}`,
    };
  }
  for (const host of extraAllowedHosts) {
    const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(https?)://${esc}/([A-Za-z0-9_-]{1,64})/([A-Za-z0-9._-]{1,100}?)(?:\\.git)?/?$`);
    const fm = re.exec(trimmed);
    if (fm) {
      const [, scheme, owner, name] = fm;
      if (name === '.' || name === '..') return null;
      return {
        host,
        owner: owner!,
        name: name!,
        cloneUrl: `${scheme}://${host}/${owner}/${name}.git`,
        fullName: `${owner}/${name}`,
      };
    }
  }
  return null;
}

export const BRANCH_RE = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$|.*\/$|-)[A-Za-z0-9._\/-]{1,200}$/;
export const branchSchema = z.string().trim().regex(BRANCH_RE, 'Invalid branch name');
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME_RE, 'Enter a fully-qualified domain name such as app.example.com')
  .refine((h) => !h.startsWith('*.'), 'Wildcard domains are not supported');

export const healthPathSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~\-/%?=&]*$/, 'Health path must start with / and contain only URL-safe characters');

export const LIMITS = {
  cpu: { min: 0.1, max: 8, default: 0.5 },
  memoryMb: { min: 64, max: 16384, default: 512 },
  port: { min: 1, max: 65535, default: 3000 },
  healthTimeoutSeconds: { min: 1, max: 60, default: 5 },
  healthIntervalSeconds: { min: 1, max: 60, default: 3 },
  healthStartPeriodSeconds: { min: 0, max: 600, default: 5 },
  healthRetries: { min: 1, max: 100, default: 20 },
} as const;
