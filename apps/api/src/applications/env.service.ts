import { Inject, Injectable } from '@nestjs/common';
import type { EnvScope, EnvVarInput, EnvVarView, EnvView } from '@deployforge/contracts';
import { PrismaService } from '../common/prisma.service';
import { conflict, notFound } from '../common/errors';
import { SECRET_BOX } from '../crypto/crypto.module';
import type { SecretBox } from '../crypto/secret-box';
import type { Prisma } from '../generated/prisma/client';

/** Stored form of one variable inside an EnvRevision. `value` is ciphertext. */
export interface StoredEnvEntry {
  key: string;
  scope: EnvScope;
  secret: boolean;
  value: string;
  updatedAt: string;
}

export interface ResolvedEnv {
  runtime: Record<string, string>;
  buildArgs: Record<string, string>;
  buildSecrets: { id: string; value: string }[];
  /** All secret plaintexts (for log redaction). */
  secretValues: string[];
}

export const MAX_ENV_VARS = 200;

@Injectable()
export class EnvService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
  ) {}

  context(applicationId: string, key: string): string {
    return `env:${applicationId}:${key}`;
  }

  encryptEntries(applicationId: string, inputs: EnvVarInput[]): StoredEnvEntry[] {
    const seen = new Set<string>();
    const now = new Date().toISOString();
    return inputs.map((v) => {
      if (seen.has(v.key)) throw conflict(`Duplicate variable ${v.key}`, 'duplicate_variable');
      seen.add(v.key);
      return { key: v.key, scope: v.scope, secret: v.secret, value: this.box.encrypt(v.value, this.context(applicationId, v.key)), updatedAt: now };
    });
  }

  entriesOf(rev: { entries: Prisma.JsonValue }): StoredEnvEntry[] {
    return (rev.entries as unknown as StoredEnvEntry[]) ?? [];
  }

  async view(applicationId: string, currentRevisionId: string | null, activeEnvRevisionId: string | null): Promise<EnvView> {
    const rev = currentRevisionId ? await this.prisma.envRevision.findUnique({ where: { id: currentRevisionId } }) : null;
    const active = activeEnvRevisionId ? await this.prisma.envRevision.findUnique({ where: { id: activeEnvRevisionId } }) : null;
    const vars: EnvVarView[] = (rev ? this.entriesOf(rev) : [])
      .map((e) => ({
        key: e.key,
        scope: e.scope,
        secret: e.secret,
        // Secret values are never decrypted for display.
        ...(e.secret ? {} : { value: this.box.decrypt(e.value, this.context(applicationId, e.key)) }),
        updatedAt: e.updatedAt,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { revision: rev?.number ?? 0, activeRevision: active?.number ?? null, vars };
  }

  /**
   * Apply a change by writing a new immutable revision. Serialized per
   * application with a row lock; `expectedRevision` provides optimistic
   * concurrency for clients.
   */
  async mutate(
    applicationId: string,
    actorId: string,
    expectedRevision: number | undefined,
    change: (entries: StoredEnvEntry[]) => StoredEnvEntry[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${applicationId} FOR UPDATE`;
      const app = await tx.application.findUniqueOrThrow({ where: { id: applicationId } });
      const current = app.currentEnvRevisionId ? await tx.envRevision.findUnique({ where: { id: app.currentEnvRevisionId } }) : null;
      const currentNumber = current?.number ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== currentNumber) {
        throw conflict('Variables were changed by someone else. Reload and try again.', 'revision_conflict');
      }
      const next = change(current ? this.entriesOf(current) : []);
      if (next.length > MAX_ENV_VARS) throw conflict(`At most ${MAX_ENV_VARS} variables are allowed`, 'too_many_variables');
      const keys = new Set<string>();
      for (const e of next) {
        if (keys.has(e.key)) throw conflict(`Duplicate variable ${e.key}`, 'duplicate_variable');
        keys.add(e.key);
      }
      const rev = await tx.envRevision.create({
        data: { applicationId, number: currentNumber + 1, entries: next as unknown as Prisma.InputJsonValue, createdById: actorId },
      });
      await tx.application.update({ where: { id: applicationId }, data: { currentEnvRevisionId: rev.id } });
      return rev.number;
    });
  }

  async set(applicationId: string, actorId: string, input: EnvVarInput, mode: 'create' | 'replace', expectedRevision?: number): Promise<number> {
    return this.mutate(applicationId, actorId, expectedRevision, (entries) => {
      const idx = entries.findIndex((e) => e.key === input.key);
      if (mode === 'create' && idx >= 0) throw conflict(`${input.key} already exists; replace it instead`, 'duplicate_variable');
      if (mode === 'replace' && idx < 0) throw notFound('Variable');
      const [entry] = this.encryptEntries(applicationId, [input]);
      const out = entries.slice();
      if (idx >= 0) out[idx] = entry!;
      else out.push(entry!);
      return out;
    });
  }

  async remove(applicationId: string, actorId: string, key: string, expectedRevision?: number): Promise<number> {
    return this.mutate(applicationId, actorId, expectedRevision, (entries) => {
      if (!entries.some((e) => e.key === key)) throw notFound('Variable');
      return entries.filter((e) => e.key !== key);
    });
  }

  /** Decrypt a revision for deployment. Only called by the worker. */
  async resolve(envRevisionId: string): Promise<ResolvedEnv> {
    const rev = await this.prisma.envRevision.findUniqueOrThrow({ where: { id: envRevisionId } });
    const out: ResolvedEnv = { runtime: {}, buildArgs: {}, buildSecrets: [], secretValues: [] };
    for (const e of this.entriesOf(rev)) {
      const value = this.box.decrypt(e.value, this.context(rev.applicationId, e.key));
      if (e.secret) out.secretValues.push(value);
      if (e.scope === 'runtime') out.runtime[e.key] = value;
      else if (e.secret) out.buildSecrets.push({ id: e.key, value });
      else out.buildArgs[e.key] = value;
    }
    return out;
  }
}
