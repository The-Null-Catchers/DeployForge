import 'reflect-metadata';
// Development convenience: load the repository .env when asked to.
if (process.env.DEPLOYFORGE_ENV_FILE) process.loadEnvFile(process.env.DEPLOYFORGE_ENV_FILE);
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/config';

export function buildOpenApi(app: NestExpressApplication) {
  const doc = new DocumentBuilder()
    .setTitle('DeployForge API')
    .setDescription(
      'Control-plane API used by the DeployForge web dashboard and mobile apps. Browser clients authenticate with an HttpOnly session cookie plus the X-CSRF-Token header on unsafe methods; native clients use Bearer access tokens obtained from /api/auth/token.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .addCookieAuth('df_session')
    .build();
  return SwaggerModule.createDocument(app, doc);
}

/** HTTP middleware shared by the server and the integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", 'https://github.com'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get<AppConfig>(CONFIG);
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  configureApp(app, config);

  if (config.DEPLOYFORGE_PROCESS !== 'worker') {
    if (config.apiDocsEnabled) {
      const document = buildOpenApi(app);
      SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
    }
    // Serve the built dashboard (single-page app) when present.
    const webDir = resolve(config.WEB_DIST_DIR ?? join(__dirname, '..', '..', 'web', 'dist'));
    if (existsSync(join(webDir, 'index.html'))) {
      app.use(express.static(webDir, { index: false, maxAge: '1h', setHeaders: (res, path) => path.endsWith('.html') && res.setHeader('Cache-Control', 'no-store') }));
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/healthz' || req.path === '/readyz') return next();
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(join(webDir, 'index.html'));
      });
    }
  }
  await app.listen(config.PORT, config.HOST);
}

if (require.main === module) {
  bootstrap().catch((e: Error) => {
    // eslint-disable-next-line no-console
    console.error(e.message);
    process.exit(1);
  });
}
