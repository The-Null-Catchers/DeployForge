-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('browser', 'mobile');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('queued', 'preparing', 'cloning', 'building', 'starting', 'checking_health', 'promoting', 'succeeded', 'failed', 'canceled', 'interrupted');

-- CreateEnum
CREATE TYPE "ReleaseState" AS ENUM ('none', 'active', 'superseded');

-- CreateEnum
CREATE TYPE "DeploymentTrigger" AS ENUM ('manual', 'push', 'rollback', 'redeploy');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('github', 'public');

-- CreateEnum
CREATE TYPE "DesiredState" AS ENUM ('running', 'stopped');

-- CreateEnum
CREATE TYPE "DomainKind" AS ENUM ('platform', 'custom');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('pending_verification', 'verified', 'active', 'error');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "tokenHash" TEXT,
    "csrfSecret" TEXT,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "replacedById" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "githubInstallationId" TEXT,
    "githubRepositoryId" INTEGER,
    "sourceStatus" TEXT NOT NULL DEFAULT 'ok',
    "branch" TEXT NOT NULL,
    "contextDir" TEXT NOT NULL,
    "dockerfilePath" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "healthPath" TEXT NOT NULL,
    "healthTimeoutSeconds" INTEGER NOT NULL,
    "healthIntervalSeconds" INTEGER NOT NULL,
    "healthStartPeriodSeconds" INTEGER NOT NULL,
    "healthRetries" INTEGER NOT NULL,
    "cpuLimit" DOUBLE PRECISION NOT NULL,
    "memoryLimitMb" INTEGER NOT NULL,
    "autoDeploy" BOOLEAN NOT NULL,
    "securityProfile" TEXT NOT NULL DEFAULT 'standard',
    "desiredState" "DesiredState" NOT NULL DEFAULT 'running',
    "currentConfigRevisionId" TEXT,
    "currentEnvRevisionId" TEXT,
    "activeDeploymentId" TEXT,
    "nextDeploymentNumber" INTEGER NOT NULL DEFAULT 1,
    "lockDeploymentId" TEXT,
    "lockToken" INTEGER NOT NULL DEFAULT 0,
    "lockExpiresAt" TIMESTAMP(3),
    "deletingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigRevision" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvRevision" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "entries" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "trigger" "DeploymentTrigger" NOT NULL,
    "actorId" TEXT,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'queued',
    "releaseState" "ReleaseState" NOT NULL DEFAULT 'none',
    "branch" TEXT,
    "commitSha" TEXT,
    "commitMessage" TEXT,
    "configRevisionId" TEXT NOT NULL,
    "envRevisionId" TEXT NOT NULL,
    "imageId" TEXT,
    "imageTag" TEXT,
    "containerId" TEXT,
    "containerName" TEXT,
    "rollbackOfId" TEXT,
    "previousActiveId" TEXT,
    "failureCategory" TEXT,
    "failureStage" TEXT,
    "errorMessage" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "imagePrunedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "logLines" INTEGER NOT NULL DEFAULT 0,
    "logBytes" INTEGER NOT NULL DEFAULT 0,
    "logsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "logsExpiredAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentStage" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'running',

    CONSTRAINT "DeploymentStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "stream" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" "DomainKind" NOT NULL,
    "status" "DomainStatus" NOT NULL,
    "verificationToken" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "dnsObserved" JSONB,
    "dnsOk" BOOLEAN,
    "dnsCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "installationId" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "githubInstallationId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubConnectState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "returnTo" TEXT NOT NULL DEFAULT 'web',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubConnectState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_name_key" ON "Project"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Application_slug_key" ON "Application"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Application_activeDeploymentId_key" ON "Application"("activeDeploymentId");

-- CreateIndex
CREATE INDEX "Application_workspaceId_idx" ON "Application"("workspaceId");

-- CreateIndex
CREATE INDEX "Application_githubInstallationId_githubRepositoryId_idx" ON "Application"("githubInstallationId", "githubRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigRevision_applicationId_number_key" ON "ConfigRevision"("applicationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "EnvRevision_applicationId_number_key" ON "EnvRevision"("applicationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_idempotencyKey_key" ON "Deployment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Deployment_applicationId_status_idx" ON "Deployment"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_workspaceId_createdAt_idx" ON "Deployment"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_applicationId_number_key" ON "Deployment"("applicationId", "number");

-- CreateIndex
CREATE INDEX "DeploymentStage_deploymentId_idx" ON "DeploymentStage"("deploymentId");

-- CreateIndex
CREATE INDEX "DeploymentEvent_deploymentId_id_idx" ON "DeploymentEvent"("deploymentId", "id");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_id_idx" ON "DeploymentLog"("deploymentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- CreateIndex
CREATE INDEX "Domain_applicationId_idx" ON "Domain"("applicationId");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_dispatchedAt_availableAt_idx" ON "OutboxEvent"("dispatchedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_githubInstallationId_key" ON "GithubInstallation"("githubInstallationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_workspaceId_idx" ON "GithubInstallation"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubConnectState_stateHash_key" ON "GithubConnectState"("stateHash");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_githubInstallationId_fkey" FOREIGN KEY ("githubInstallationId") REFERENCES "GithubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_activeDeploymentId_fkey" FOREIGN KEY ("activeDeploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigRevision" ADD CONSTRAINT "ConfigRevision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvRevision" ADD CONSTRAINT "EnvRevision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_configRevisionId_fkey" FOREIGN KEY ("configRevisionId") REFERENCES "ConfigRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_envRevisionId_fkey" FOREIGN KEY ("envRevisionId") REFERENCES "EnvRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rollbackOfId_fkey" FOREIGN KEY ("rollbackOfId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentStage" ADD CONSTRAINT "DeploymentStage_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
