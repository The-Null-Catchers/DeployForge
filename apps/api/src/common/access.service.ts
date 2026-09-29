import { Injectable } from '@nestjs/common';
import { can, type Permission, type Role } from '@deployforge/contracts';
import { PrismaService } from './prisma.service';
import { forbidden, notFound } from './errors';
import type { AuthContext } from '../auth/auth.types';

/**
 * Server-side workspace authorization. Every workspace-scoped resource is
 * loaded through this service, which resolves the owning workspace from the
 * resource itself (never from client input) and checks the caller's role.
 *
 * Callers that are not members of the owning workspace get 404, so resource
 * existence does not leak across workspaces. Members lacking the permission
 * get 403.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async role(userId: string, workspaceId: string): Promise<Role | null> {
    const m = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    return (m?.role as Role | undefined) ?? null;
  }

  async check(auth: AuthContext, workspaceId: string, permission: Permission, what = 'Resource'): Promise<Role> {
    const role = await this.role(auth.userId, workspaceId);
    if (!role) throw notFound(what);
    if (!can(role, permission)) throw forbidden();
    return role;
  }

  async workspace(auth: AuthContext, workspaceId: string, permission: Permission) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw notFound('Workspace');
    const role = await this.check(auth, ws.id, permission, 'Workspace');
    return { workspace: ws, role };
  }

  async project(auth: AuthContext, projectId: string, permission: Permission) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw notFound('Project');
    const role = await this.check(auth, project.workspaceId, permission, 'Project');
    return { project, role };
  }

  async app(auth: AuthContext, appId: string, permission: Permission) {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app || app.deletingAt) throw notFound('Application');
    const role = await this.check(auth, app.workspaceId, permission, 'Application');
    return { app, role };
  }

  async deployment(auth: AuthContext, deploymentId: string, permission: Permission) {
    const deployment = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, include: { application: true } });
    if (!deployment || deployment.application.deletingAt) throw notFound('Deployment');
    const role = await this.check(auth, deployment.workspaceId, permission, 'Deployment');
    return { deployment, app: deployment.application, role };
  }

  async domain(auth: AuthContext, domainId: string, permission: Permission) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId }, include: { application: true } });
    if (!domain || domain.application.deletingAt) throw notFound('Domain');
    const role = await this.check(auth, domain.workspaceId, permission, 'Domain');
    return { domain, app: domain.application, role };
  }
}
