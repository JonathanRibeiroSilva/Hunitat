/**
 * Accounts, identity and membership — phase 6.
 *
 * Knows nothing about the world. That is what lets `WorldModule` import this one
 * so the gateway can authenticate a handshake (`FR-6.18`) without producing a
 * cycle; the single thing that has to travel the other way — rebinding a live
 * session after a guest upgrade — goes through `IdentityBridge`, which the
 * gateway fills in at bootstrap.
 *
 * `PersistenceModule` is not imported because it is global from phase 6: the
 * connection is a singleton and three modules need it.
 *
 * Every service here handles a **null** `DataSource`. A server with no database
 * still runs — guests join, chat lives in memory — and the account routes answer
 * 503 rather than 500. That is not a degraded mode nobody tests: it is the
 * README's development flow.
 */

import { Module } from '@nestjs/common';
import { AccountService } from './account.service.js';
import { AccessTokenGuard } from './auth.guard.js';
import { AuthController } from './auth.controller.js';
import { IdentityBridge } from './identity-bridge.js';
import { InviteController } from './invite.controller.js';
import { InviteService } from './invite.service.js';
import { MailerService } from './mailer.service.js';
import { PasswordService } from './password.service.js';
import { RolesService } from './roles.service.js';
import { SpaceService } from './space.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController, InviteController],
  providers: [
    AccountService,
    PasswordService,
    TokenService,
    SpaceService,
    InviteService,
    MailerService,
    IdentityBridge,
    AccessTokenGuard,
    // Phase 7. Here rather than in `ModerationModule` because a role is a
    // property of a membership, and because that module imports this one — the
    // reverse would be a cycle. See `roles.service.ts`.
    RolesService,
  ],
  // `AccountService` for the gateway's handshake, `IdentityBridge` for the
  // gateway to register itself into, `SpaceService` for the guest check and for
  // /health to report the policy. From phase 7, `RolesService` for both guards
  // and `PasswordService` for the Space password (`FR-7.12`), which is argon2id
  // like every other password here.
  exports: [
    AccountService,
    IdentityBridge,
    SpaceService,
    TokenService,
    RolesService,
    PasswordService,
    AccessTokenGuard,
  ],
})
export class AuthModule {}
