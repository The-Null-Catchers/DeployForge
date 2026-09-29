import { z } from 'zod';
import {
  branchSchema,
  envNameSchema,
  healthPathSchema,
  hostnameSchema,
  LIMITS,
  MAX_ENV_VALUE_BYTES,
  relativePathSchema,
  slugSchema,
  COMMIT_SHA_RE,
} from './validation';
import { ROLES } from './permissions';

/** Request schemas for the public (dashboard/mobile) API. */

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256, 'Password is too long');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const nameSchema = z.string().trim().min(1).max(80);

export const setupRequestSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  workspaceName: nameSchema,
});
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export const tokenLoginRequestSchema = loginRequestSchema.extend({
  deviceName: z.string().trim().min(1).max(80).default('Mobile device'),
});
export const refreshRequestSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const acceptInviteRequestSchema = z.object({
  token: z.string().min(20).max(200),
  name: nameSchema,
  password: passwordSchema,
});
export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const createWorkspaceRequestSchema = z.object({ name: nameSchema });
export const updateWorkspaceRequestSchema = z.object({ name: nameSchema });
export const inviteMemberRequestSchema = z.object({ email: emailSchema, role: z.enum(ROLES) });
export const updateMemberRequestSchema = z.object({ role: z.enum(ROLES) });

export const createProjectRequestSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(500).optional(),
});
export const updateProjectRequestSchema = createProjectRequestSchema.partial();

export const healthCheckSchema = z.object({
  path: healthPathSchema.default('/'),
  timeoutSeconds: z
    .number()
    .int()
    .min(LIMITS.healthTimeoutSeconds.min)
    .max(LIMITS.healthTimeoutSeconds.max)
    .default(LIMITS.healthTimeoutSeconds.default),
  intervalSeconds: z
    .number()
    .int()
    .min(LIMITS.healthIntervalSeconds.min)
    .max(LIMITS.healthIntervalSeconds.max)
    .default(LIMITS.healthIntervalSeconds.default),
  startPeriodSeconds: z
    .number()
    .int()
    .min(LIMITS.healthStartPeriodSeconds.min)
    .max(LIMITS.healthStartPeriodSeconds.max)
    .default(LIMITS.healthStartPeriodSeconds.default),
  retries: z
    .number()
    .int()
    .min(LIMITS.healthRetries.min)
    .max(LIMITS.healthRetries.max)
    .default(LIMITS.healthRetries.default),
});
export type HealthCheckConfig = z.infer<typeof healthCheckSchema>;

export const ENV_SCOPES = ['runtime', 'build'] as const;
export type EnvScope = (typeof ENV_SCOPES)[number];

const envValueSchema = z
  .string()
  .refine(
    (v) => new TextEncoder().encode(v).length <= MAX_ENV_VALUE_BYTES,
    'Value exceeds 32 KiB',
  )
  .refine((v) => !v.includes('\u0000'), 'Value must not contain NUL bytes');

export const envVarInputSchema = z.object({
  key: envNameSchema,
  value: envValueSchema,
  scope: z.enum(ENV_SCOPES).default('runtime'),
  secret: z.boolean().default(true),
});
export type EnvVarInput = z.infer<typeof envVarInputSchema>;

export const envVarReplaceSchema = z.object({
  value: envValueSchema,
  scope: z.enum(ENV_SCOPES).optional(),
  secret: z.boolean().optional(),
  expectedRevision: z.number().int().optional(),
});

export const repositorySourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    installationId: z.string().min(1),
    repositoryId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('public'),
    repoUrl: z.string().trim().url().max(300),
  }),
]);
export type RepositorySource = z.infer<typeof repositorySourceSchema>;

export const SECURITY_PROFILES = ['standard', 'strict'] as const;

export const appSettingsSchema = z.object({
  branch: branchSchema.default('main'),
  contextDir: relativePathSchema.default('.'),
  dockerfilePath: relativePathSchema.default('Dockerfile'),
  port: z.number().int().min(LIMITS.port.min).max(LIMITS.port.max).default(LIMITS.port.default),
  healthCheck: healthCheckSchema.default({
    path: '/',
    timeoutSeconds: LIMITS.healthTimeoutSeconds.default,
    intervalSeconds: LIMITS.healthIntervalSeconds.default,
    startPeriodSeconds: LIMITS.healthStartPeriodSeconds.default,
    retries: LIMITS.healthRetries.default,
  }),
  cpuLimit: z.number().min(LIMITS.cpu.min).max(LIMITS.cpu.max).default(LIMITS.cpu.default),
  memoryLimitMb: z
    .number()
    .int()
    .min(LIMITS.memoryMb.min)
    .max(LIMITS.memoryMb.max)
    .default(LIMITS.memoryMb.default),
  autoDeploy: z.boolean().default(false),
  securityProfile: z.enum(SECURITY_PROFILES).default('standard'),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const createApplicationRequestSchema = appSettingsSchema.extend({
  projectId: z.string().min(1),
  name: nameSchema,
  slug: slugSchema,
  source: repositorySourceSchema,
  env: z.array(envVarInputSchema).max(200).default([]),
  deployNow: z.boolean().default(false),
});
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;

export const updateApplicationRequestSchema = z
  .object({
    name: nameSchema,
    branch: branchSchema,
    contextDir: relativePathSchema,
    dockerfilePath: relativePathSchema,
    port: z.number().int().min(LIMITS.port.min).max(LIMITS.port.max),
    healthCheck: healthCheckSchema,
    cpuLimit: z.number().min(LIMITS.cpu.min).max(LIMITS.cpu.max),
    memoryLimitMb: z.number().int().min(LIMITS.memoryMb.min).max(LIMITS.memoryMb.max),
    autoDeploy: z.boolean(),
    securityProfile: z.enum(SECURITY_PROFILES),
  })
  .partial();

export const createDeploymentRequestSchema = z.object({
  /** Deploy this exact commit. When omitted the branch head is resolved once and recorded. */
  commitSha: z.string().regex(COMMIT_SHA_RE, 'Expected a full 40-character commit SHA').optional(),
});

export const rollbackRequestSchema = z.object({
  /** Clients must send true after showing the rollback disclosure. */
  confirm: z.literal(true),
});

export const deleteApplicationRequestSchema = z.object({
  /** Must equal the application's slug. */
  confirmSlug: z.string(),
});

export const createDomainRequestSchema = z.object({ hostname: hostnameSchema });

export const retainReleaseRequestSchema = z.object({ pinned: z.boolean() });

export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
