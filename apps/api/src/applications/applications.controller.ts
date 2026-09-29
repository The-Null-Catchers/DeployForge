import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  createApplicationRequestSchema,
  deleteApplicationRequestSchema,
  envNameSchema,
  envVarInputSchema,
  envVarReplaceSchema,
  updateApplicationRequestSchema,
  type ApplicationView,
  type EnvView,
  type MetricsView,
} from '@deployforge/contracts';
import { AccessService } from '../common/access.service';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { conflict } from '../common/errors';
import { jsonSchema } from '../common/openapi';
import { Auth, Meta, type AuthContext, type RequestMeta } from '../auth/auth.types';
import { ApplicationsService } from './applications.service';
import { EnvService } from './env.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { LiveService } from '../deployments/live.service';

@ApiTags('applications')
@Controller('api')
export class ApplicationsController {
  constructor(
    private readonly access: AccessService,
    private readonly apps: ApplicationsService,
    private readonly env: EnvService,
    private readonly deployments: DeploymentsService,
    private readonly audit: AuditService,
    private readonly live: LiveService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('workspaces/:workspaceId/apps')
  @ApiOperation({ summary: 'Create an application (owner, developer). Optionally deploy immediately.' })
  @ApiBody({ schema: jsonSchema(createApplicationRequestSchema) })
  async create(
    @Auth() auth: AuthContext,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodPipe(createApplicationRequestSchema)) body: z.infer<typeof createApplicationRequestSchema>,
    @Meta() meta: RequestMeta,
  ): Promise<ApplicationView & { deploymentId?: string }> {
    await this.access.workspace(auth, workspaceId, 'app.create');
    const app = await this.apps.create(workspaceId, auth.userId, body, meta);
    let deploymentId: string | undefined;
    if (body.deployNow) {
      const d = await this.deployments.create(app, { trigger: 'manual', actorId: auth.userId, meta });
      deploymentId = d.id;
    }
    return { ...(await this.apps.view(app)), deploymentId };
  }

  @Get('apps/:id')
  @ApiOperation({ summary: 'Application details' })
  async get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ApplicationView> {
    const { app } = await this.access.app(auth, id, 'app.read');
    return this.apps.view(app);
  }

  @Patch('apps/:id')
  @ApiOperation({ summary: 'Update settings. Takes effect on the next deployment.' })
  @ApiBody({ schema: jsonSchema(updateApplicationRequestSchema) })
  async update(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(updateApplicationRequestSchema)) body: z.infer<typeof updateApplicationRequestSchema>, @Meta() meta: RequestMeta): Promise<ApplicationView> {
    const { app } = await this.access.app(auth, id, 'app.update');
    const updated = await this.apps.update(app, auth.userId, body, meta);
    await this.live.notifyApp(app.id);
    return this.apps.view(updated);
  }

  @Delete('apps/:id')
  @HttpCode(202)
  @ApiOperation({ summary: 'Delete an application (owner). Requires confirmSlug; removes routes, containers and images it owns.' })
  @ApiBody({ schema: jsonSchema(deleteApplicationRequestSchema) })
  async remove(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(deleteApplicationRequestSchema)) body: z.infer<typeof deleteApplicationRequestSchema>, @Meta() meta: RequestMeta) {
    const { app } = await this.access.app(auth, id, 'app.delete');
    if (body.confirmSlug !== app.slug) throw conflict('Type the application slug to confirm deletion', 'confirmation_mismatch');
    await this.apps.requestDelete(app, auth.userId, meta);
    return { status: 'deleting' };
  }

  @Post('apps/:id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the active release (owner, developer)' })
  start(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<ApplicationView> {
    return this.lifecycle(auth, id, 'start', meta);
  }

  @Post('apps/:id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the active release; the route serves 503 until started (owner, developer)' })
  stop(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<ApplicationView> {
    return this.lifecycle(auth, id, 'stop', meta);
  }

  @Post('apps/:id/restart')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restart the active container (owner, developer)' })
  restart(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<ApplicationView> {
    return this.lifecycle(auth, id, 'restart', meta);
  }

  private async lifecycle(auth: AuthContext, id: string, action: 'start' | 'stop' | 'restart', meta: RequestMeta): Promise<ApplicationView> {
    const { app } = await this.access.app(auth, id, 'app.lifecycle');
    return this.apps.view(await this.apps.lifecycle(app, action, auth.userId, meta));
  }

  @Get('apps/:id/metrics')
  @ApiOperation({ summary: 'Current resource metrics of the active container (point-in-time sample)' })
  async metrics(@Auth() auth: AuthContext, @Param('id') id: string): Promise<MetricsView | { unavailable: string }> {
    const { app } = await this.access.app(auth, id, 'metrics.read');
    try {
      return (await this.apps.metrics(app)) ?? { unavailable: 'not_deployed' };
    } catch {
      return { unavailable: 'runner_unreachable' };
    }
  }

  // ---- environment variables ----

  @Get('apps/:id/env')
  @ApiOperation({ summary: 'List variables. Secret values are never returned.' })
  async listEnv(@Auth() auth: AuthContext, @Param('id') id: string): Promise<EnvView> {
    const { app } = await this.access.app(auth, id, 'env.read');
    const active = app.activeDeploymentId ? await this.deploymentEnvRevision(app.activeDeploymentId) : null;
    return this.env.view(app.id, app.currentEnvRevisionId, active);
  }

  private async deploymentEnvRevision(deploymentId: string): Promise<string | null> {
    const d = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { envRevisionId: true } });
    return d?.envRevisionId ?? null;
  }

  @Post('apps/:id/env')
  @ApiOperation({ summary: 'Create a variable (owner, developer). Requires a deployment to take effect.' })
  @ApiBody({ schema: jsonSchema(envVarInputSchema) })
  async createEnv(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(envVarInputSchema)) body: z.infer<typeof envVarInputSchema>, @Meta() meta: RequestMeta): Promise<EnvView> {
    const { app } = await this.access.app(auth, id, 'env.write');
    const rev = await this.env.set(app.id, auth.userId, body, 'create');
    await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'env.created', targetType: 'application', targetId: app.id, metadata: { key: body.key, scope: body.scope, secret: body.secret, revision: rev }, meta });
    return this.listEnv(auth, id);
  }

  @Put('apps/:id/env/:key')
  @ApiOperation({ summary: 'Replace a variable value without revealing the old value' })
  @ApiBody({ schema: jsonSchema(envVarReplaceSchema) })
  async replaceEnv(@Auth() auth: AuthContext, @Param('id') id: string, @Param('key', new ZodPipe(envNameSchema)) key: string, @Body(new ZodPipe(envVarReplaceSchema)) body: z.infer<typeof envVarReplaceSchema>, @Meta() meta: RequestMeta): Promise<EnvView> {
    const { app } = await this.access.app(auth, id, 'env.write');
    const current = await this.env.view(app.id, app.currentEnvRevisionId, null);
    const existing = current.vars.find((v) => v.key === key);
    const rev = await this.env.set(
      app.id,
      auth.userId,
      { key, value: body.value, scope: body.scope ?? existing?.scope ?? 'runtime', secret: body.secret ?? existing?.secret ?? true },
      'replace',
      body.expectedRevision,
    );
    await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'env.replaced', targetType: 'application', targetId: app.id, metadata: { key, revision: rev }, meta });
    return this.listEnv(auth, id);
  }

  @Delete('apps/:id/env/:key')
  @ApiOperation({ summary: 'Delete a variable' })
  async deleteEnv(@Auth() auth: AuthContext, @Param('id') id: string, @Param('key', new ZodPipe(envNameSchema)) key: string, @Meta() meta: RequestMeta): Promise<EnvView> {
    const { app } = await this.access.app(auth, id, 'env.write');
    const rev = await this.env.remove(app.id, auth.userId, key);
    await this.audit.record({ workspaceId: app.workspaceId, actorId: auth.userId, action: 'env.deleted', targetType: 'application', targetId: app.id, metadata: { key, revision: rev }, meta });
    return this.listEnv(auth, id);
  }
}
