import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { WorldModule } from './world/world.module.js';

/**
 * `PersistenceModule` is listed first and is `@Global`. It resolves the database
 * connection — which is allowed to be absent — before anything that injects it,
 * so no service ever sees a `DataSource` that is still opening.
 *
 * `AuthModule` is imported here as well as by `WorldModule`, which is not
 * redundant: Nest resolves a controller's dependencies from *its own* module's
 * context, and `HealthController` lives here. Without this line `/health` cannot
 * see `AccountService`, and the failure is at boot rather than at the request.
 * The module itself is still a singleton.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Repo root, so one .env serves every workspace.
      envFilePath: ['../../.env'],
    }),
    PersistenceModule,
    AuthModule,
    // Phase 7. Listed here as well as by `WorldModule` for the same reason
    // `AuthModule` is: `HealthController` lives in this module's context and
    // reports the access policy, and Nest resolves a controller's dependencies
    // from its own module. The module is still a singleton.
    ModerationModule,
    WorldModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
