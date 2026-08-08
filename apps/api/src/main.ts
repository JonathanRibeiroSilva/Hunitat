import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { configWarnings, loadConfig } from './config/tuning.config.js';
import { assetsRoot } from './world/map.service.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  for (const warning of configWarnings(config)) new Logger('config').warn(warning);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableShutdownHooks();

  /**
   * Phase 1 runs web and api on different origins in development.
   *
   * `credentials: true` was already here and phase 6 is what makes it
   * load-bearing: without it the browser sends no cookies cross-origin and the
   * refresh token — which is the whole of `FR-6.17` — never reaches the server.
   * `origin: true` reflects the caller's origin rather than allowing `*`, which
   * is not merely stylistic: `*` and `credentials: true` are incompatible and
   * every browser refuses the pair.
   */
  app.enableCors({ origin: true, credentials: true });

  /**
   * Phase 6. The refresh token lives in an `httpOnly` cookie (ADR 0011), and
   * without this `request.cookies` is undefined — which presents as every
   * refresh returning 401 rather than as a missing middleware.
   */
  app.use(cookieParser());

  /**
   * So `request.protocol` and `request.secure` reflect the *client's* scheme
   * behind a reverse proxy rather than the plain HTTP hop inside the network.
   * The `Secure` attribute on the refresh cookie is decided from it; getting it
   * wrong under Compose means the cookie is set without `Secure` on a TLS site.
   */
  app.set('trust proxy', 1);

  // The api serves the world assets so the GLB and its Map Document have exactly
  // one home — the server needs the document for spawns anyway, and a second
  // copy under the web app would drift.
  app.useStaticAssets(assetsRoot(), { prefix: '/assets/' });

  await app.listen(config.port, '0.0.0.0');

  const logger = new Logger('bootstrap');
  logger.log(`API listening on :${config.port}`);
  logger.log(`Assets served from ${assetsRoot()} at /assets/`);
}

bootstrap().catch((error) => {
  // A misconfigured AOI radius pair or an unreadable map document must stop the
  // process here, with the reason, rather than producing a world that behaves
  // strangely on first join.
  new Logger('bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
