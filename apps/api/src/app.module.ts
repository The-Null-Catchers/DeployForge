import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { CONFIG, loadConfig, type AppConfig } from './config/config';
import { PrismaService } from './common/prisma.service';
import { RedisService } from './common/redis.service';
import { AccessService } from './common/access.service';
import { AuditService } from './common/audit.service';
import { RateLimitService } from './common/rate-limit.service';
import { ErrorFilter } from './common/errors';
import { CryptoModule } from './crypto/crypto.module';
import { GithubClientModule } from './github/github.module';
import { SessionService } from './auth/session.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { EnvService } from './applications/env.service';
import { DeploymentsController } from './deployments/deployments.controller';
import { DeploymentsService } from './deployments/deployments.service';
import { LiveService } from './deployments/live.service';
import { DomainsController } from './domains/domains.controller';
import { GithubController } from './github/github.controller';
import { WebhookProcessor } from './github/webhook.processor';
import { DiagnosticsController } from './diagnostics/diagnostics.controller';
import { RunnerClient } from './runner/runner.client';
import { ProxyService } from './proxy/proxy.service';
import { OutboxService } from './engine/outbox.service';
import { CoordinationService } from './engine/coordination.service';
import { QueuesService } from './engine/queues';
import { DeploymentExecutor } from './engine/deployment.executor';
import { PlatformJobsService } from './engine/platform-jobs.service';
import { ReconcilerService } from './engine/reconciler.service';
import { WorkerService } from './engine/worker.service';

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
class ConfigModule {}

@Module({
  imports: [
    ConfigModule,
    CryptoModule,
    GithubClientModule,
    LoggerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.NODE_ENV === 'test' ? 'warn' : 'info',
          // Never log credentials, cookies or tokens.
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-hub-signature-256"]', 'res.headers["set-cookie"]'],
            censor: '[REDACTED]',
          },
          autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
          serializers: {
            req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: (req.url ?? '').split('?')[0] }),
          },
        },
      }),
    }),
  ],
  controllers: [
    AuthController,
    WorkspacesController,
    ApplicationsController,
    DeploymentsController,
    DomainsController,
    GithubController,
    DiagnosticsController,
  ],
  providers: [
    PrismaService,
    RedisService,
    AccessService,
    AuditService,
    RateLimitService,
    SessionService,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
    ApplicationsService,
    EnvService,
    DeploymentsService,
    LiveService,
    RunnerClient,
    ProxyService,
    OutboxService,
    CoordinationService,
    QueuesService,
    DeploymentExecutor,
    PlatformJobsService,
    ReconcilerService,
    WebhookProcessor,
    WorkerService,
  ],
})
export class AppModule {}
