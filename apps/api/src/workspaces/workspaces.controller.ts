import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import {
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  inviteMemberRequestSchema,
  permissionsFor,
  updateMemberRequestSchema,
  updateProjectRequestSchema,
  updateWorkspaceRequestSchema,
  type AuditEventView,
  type InviteView,
  type MemberView,
  type Paginated,
  type ProjectView,
  type Role,
  type WorkspaceSummary,
} from '@deployforge/contracts';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { conflict, forbidden, notFound } from '../common/errors';
import { jsonSchema } from '../common/openapi';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { Auth, Meta, type AuthContext, type RequestMeta } from '../auth/auth.types';
import { uniqueSlug } from '../auth/auth.controller';
import { ApplicationsService } from '../applications/applications.service';

@ApiTags('workspaces')
@Controller('api')
export class WorkspacesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly apps: ApplicationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('workspaces')
  @ApiOperation({ summary: 'List workspaces you belong to' })
  async list(@Auth() auth: AuthContext): Promise<WorkspaceSummary[]> {
    const ms = await this.prisma.membership.findMany({ where: { userId: auth.userId }, include: { workspace: true }, orderBy: { createdAt: 'asc' } });
    return ms.map((m) => ({ id: m.workspace.id, name: m.workspace.name, slug: m.workspace.slug, role: m.role as Role, permissions: permissionsFor(m.role as Role) }));
  }

  @Post('workspaces')
  @ApiOperation({ summary: 'Create a workspace (instance administrators only)' })
  @ApiBody({ schema: jsonSchema(createWorkspaceRequestSchema) })
  async create(@Auth() auth: AuthContext, @Body(new ZodPipe(createWorkspaceRequestSchema)) body: z.infer<typeof createWorkspaceRequestSchema>, @Meta() meta: RequestMeta): Promise<WorkspaceSummary> {
    if (!auth.isInstanceAdmin) throw forbidden('Only instance administrators can create workspaces');
    const ws = await this.prisma.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { name: body.name, slug: await uniqueSlug(tx, body.name) } });
      await tx.membership.create({ data: { workspaceId: w.id, userId: auth.userId, role: 'owner' } });
      await tx.project.create({ data: { workspaceId: w.id, name: 'Default' } });
      await this.audit.record({ workspaceId: w.id, actorId: auth.userId, action: 'workspace.created', targetType: 'workspace', targetId: w.id, meta }, tx);
      return w;
    });
    return { id: ws.id, name: ws.name, slug: ws.slug, role: 'owner', permissions: permissionsFor('owner') };
  }

  @Patch('workspaces/:id')
  @ApiOperation({ summary: 'Rename a workspace (owner)' })
  @ApiBody({ schema: jsonSchema(updateWorkspaceRequestSchema) })
  async update(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(updateWorkspaceRequestSchema)) body: z.infer<typeof updateWorkspaceRequestSchema>, @Meta() meta: RequestMeta) {
    await this.access.workspace(auth, id, 'workspace.update');
    const ws = await this.prisma.workspace.update({ where: { id }, data: { name: body.name } });
    await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'workspace.renamed', targetType: 'workspace', targetId: id, metadata: { name: body.name }, meta });
    return { id: ws.id, name: ws.name, slug: ws.slug };
  }

  @Delete('workspaces/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty workspace (owner)' })
  async remove(@Auth() auth: AuthContext, @Param('id') id: string, @Meta() meta: RequestMeta): Promise<void> {
    await this.access.workspace(auth, id, 'workspace.delete');
    const apps = await this.prisma.application.count({ where: { workspaceId: id } });
    if (apps > 0) throw conflict('Delete all applications in this workspace first', 'workspace_not_empty');
    await this.audit.record({ workspaceId: null, actorId: auth.userId, action: 'workspace.deleted', targetType: 'workspace', targetId: id, meta });
    await this.prisma.workspace.delete({ where: { id } });
  }

  // ---- members ----

  @Get('workspaces/:id/members')
  @ApiOperation({ summary: 'List workspace members' })
  async members(@Auth() auth: AuthContext, @Param('id') id: string): Promise<MemberView[]> {
    await this.access.workspace(auth, id, 'members.read');
    const ms = await this.prisma.membership.findMany({ where: { workspaceId: id }, include: { user: true }, orderBy: { createdAt: 'asc' } });
    return ms.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role as Role, joinedAt: m.createdAt.toISOString() }));
  }

  @Patch('workspaces/:id/members/:userId')
  @ApiOperation({ summary: 'Change a member role (owner)' })
  @ApiBody({ schema: jsonSchema(updateMemberRequestSchema) })
  async updateMember(@Auth() auth: AuthContext, @Param('id') id: string, @Param('userId') userId: string, @Body(new ZodPipe(updateMemberRequestSchema)) body: z.infer<typeof updateMemberRequestSchema>, @Meta() meta: RequestMeta): Promise<MemberView> {
    await this.access.workspace(auth, id, 'members.manage');
    const m = await this.prisma.$transaction(async (tx) => {
      const current = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId } }, include: { user: true } });
      if (!current) throw notFound('Member');
      if (current.role === 'owner' && body.role !== 'owner') {
        const owners = await tx.membership.count({ where: { workspaceId: id, role: 'owner' } });
        if (owners <= 1) throw conflict('A workspace must keep at least one owner', 'last_owner');
      }
      const updated = await tx.membership.update({ where: { workspaceId_userId: { workspaceId: id, userId } }, data: { role: body.role }, include: { user: true } });
      await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { from: current.role, to: body.role }, meta }, tx);
      return updated;
    });
    return { userId: m.userId, name: m.user.name, email: m.user.email, role: m.role as Role, joinedAt: m.createdAt.toISOString() };
  }

  @Delete('workspaces/:id/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member (owner)' })
  async removeMember(@Auth() auth: AuthContext, @Param('id') id: string, @Param('userId') userId: string, @Meta() meta: RequestMeta): Promise<void> {
    await this.access.workspace(auth, id, 'members.manage');
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId } } });
      if (!current) throw notFound('Member');
      if (current.role === 'owner') {
        const owners = await tx.membership.count({ where: { workspaceId: id, role: 'owner' } });
        if (owners <= 1) throw conflict('A workspace must keep at least one owner', 'last_owner');
      }
      await tx.membership.delete({ where: { workspaceId_userId: { workspaceId: id, userId } } });
      await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'member.removed', targetType: 'user', targetId: userId, meta }, tx);
    });
  }

  @Get('workspaces/:id/invites')
  @ApiOperation({ summary: 'List pending invitations (owner)' })
  async invites(@Auth() auth: AuthContext, @Param('id') id: string): Promise<InviteView[]> {
    await this.access.workspace(auth, id, 'members.manage');
    const rows = await this.prisma.invite.findMany({ where: { workspaceId: id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    return rows.map((i) => ({ id: i.id, email: i.email, role: i.role as Role, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }));
  }

  @Post('workspaces/:id/invites')
  @ApiOperation({ summary: 'Invite someone by email (owner). Returns a one-time invitation link.' })
  @ApiBody({ schema: jsonSchema(inviteMemberRequestSchema) })
  async invite(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(inviteMemberRequestSchema)) body: z.infer<typeof inviteMemberRequestSchema>, @Meta() meta: RequestMeta): Promise<InviteView> {
    await this.access.workspace(auth, id, 'members.manage');
    const existingUser = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser && (await this.access.role(existingUser.id, id))) throw conflict('That person is already a member', 'already_member');
    const token = randomToken('dfi_');
    const inv = await this.prisma.invite.create({
      data: { workspaceId: id, email: body.email, role: body.role, tokenHash: sha256Hex(token), invitedById: auth.userId, expiresAt: new Date(Date.now() + 7 * 86400_000) },
    });
    await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'member.invited', targetType: 'invite', targetId: inv.id, metadata: { email: body.email, role: body.role }, meta });
    const inviteUrl = `${this.config.PUBLIC_URL.replace(/\/$/, '')}/invite/${token}`;
    return { id: inv.id, email: inv.email, role: inv.role as Role, expiresAt: inv.expiresAt.toISOString(), createdAt: inv.createdAt.toISOString(), inviteUrl };
  }

  @Delete('workspaces/:id/invites/:inviteId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an invitation (owner)' })
  async revokeInvite(@Auth() auth: AuthContext, @Param('id') id: string, @Param('inviteId') inviteId: string, @Meta() meta: RequestMeta): Promise<void> {
    await this.access.workspace(auth, id, 'members.manage');
    const r = await this.prisma.invite.updateMany({ where: { id: inviteId, workspaceId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count === 0) throw notFound('Invitation');
    await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'member.invite_revoked', targetType: 'invite', targetId: inviteId, meta });
  }

  // ---- audit ----

  @Get('workspaces/:id/audit')
  @ApiOperation({ summary: 'Workspace audit log (owner, developer), newest first' })
  async auditLog(@Auth() auth: AuthContext, @Param('id') id: string, @Query('cursor') cursor?: string, @Query('action') action?: string): Promise<Paginated<AuditEventView>> {
    await this.access.workspace(auth, id, 'audit.read');
    const rows = await this.prisma.auditEvent.findMany({
      where: { workspaceId: id, ...(action ? { action: { startsWith: action } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = new Map((await this.prisma.user.findMany({ where: { id: { in: actorIds } } })).map((u) => [u.id, u.name]));
    const page = rows.slice(0, 50);
    return {
      items: page.map((r) => ({
        id: r.id,
        ts: r.createdAt.toISOString(),
        actor: r.actorId ? { id: r.actorId, name: actors.get(r.actorId) ?? 'Deleted user' } : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata as Record<string, unknown>,
        ip: r.ip,
      })),
      nextCursor: rows.length > 50 ? page[page.length - 1]!.id : null,
    };
  }

  // ---- projects ----

  @Get('workspaces/:id/projects')
  @ApiOperation({ summary: 'Projects with their applications' })
  async projects(@Auth() auth: AuthContext, @Param('id') id: string): Promise<ProjectView[]> {
    await this.access.workspace(auth, id, 'app.read');
    const projects = await this.prisma.project.findMany({ where: { workspaceId: id }, orderBy: { createdAt: 'asc' } });
    const summaries = await this.apps.summariesForWorkspace(id);
    return projects.map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
      applications: summaries.filter((a) => a.projectId === p.id),
    }));
  }

  @Post('workspaces/:id/projects')
  @ApiOperation({ summary: 'Create a project (owner, developer)' })
  @ApiBody({ schema: jsonSchema(createProjectRequestSchema) })
  async createProject(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodPipe(createProjectRequestSchema)) body: z.infer<typeof createProjectRequestSchema>, @Meta() meta: RequestMeta) {
    await this.access.workspace(auth, id, 'project.create');
    const p = await this.prisma.project.create({ data: { workspaceId: id, name: body.name, description: body.description ?? null } });
    await this.audit.record({ workspaceId: id, actorId: auth.userId, action: 'project.created', targetType: 'project', targetId: p.id, metadata: { name: p.name }, meta });
    return { id: p.id, workspaceId: id, name: p.name, description: p.description, createdAt: p.createdAt.toISOString(), applications: [] };
  }

  @Patch('projects/:projectId')
  @ApiOperation({ summary: 'Update a project (owner, developer)' })
  @ApiBody({ schema: jsonSchema(updateProjectRequestSchema) })
  async updateProject(@Auth() auth: AuthContext, @Param('projectId') projectId: string, @Body(new ZodPipe(updateProjectRequestSchema)) body: z.infer<typeof updateProjectRequestSchema>, @Meta() meta: RequestMeta) {
    const { project } = await this.access.project(auth, projectId, 'project.update');
    const p = await this.prisma.project.update({ where: { id: project.id }, data: body });
    await this.audit.record({ workspaceId: p.workspaceId, actorId: auth.userId, action: 'project.updated', targetType: 'project', targetId: p.id, meta });
    return { id: p.id, workspaceId: p.workspaceId, name: p.name, description: p.description, createdAt: p.createdAt.toISOString() };
  }

  @Delete('projects/:projectId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty project (owner)' })
  async deleteProject(@Auth() auth: AuthContext, @Param('projectId') projectId: string, @Meta() meta: RequestMeta): Promise<void> {
    const { project } = await this.access.project(auth, projectId, 'project.delete');
    const n = await this.prisma.application.count({ where: { projectId } });
    if (n > 0) throw conflict('Delete or move the applications in this project first', 'project_not_empty');
    await this.prisma.project.delete({ where: { id: projectId } });
    await this.audit.record({ workspaceId: project.workspaceId, actorId: auth.userId, action: 'project.deleted', targetType: 'project', targetId: projectId, meta });
  }
}
