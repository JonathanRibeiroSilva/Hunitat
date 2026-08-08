/**
 * Permissions and moderation — phase 7.
 *
 * ── Where the pieces live, and why they are split this way ──────────────────
 *
 * This module holds everything about moderation that has **no opinion about the
 * world**: bans as records, blocks, reports, the audit log, the access policy,
 * and the guard that reads the capability matrix. That constraint is what lets
 * `WorldModule` import it — the gateway has to evaluate access policy during a
 * handshake and resolve capabilities before it dispatches a `MODERATE` frame —
 * without producing the cycle a world-aware moderation module would.
 *
 * The two halves that are missing from this list are missing on purpose:
 *
 *   `RolesService` is in `auth/`, because a role is a property of a membership
 *   and auth is the side nothing else depends on. See its header.
 *
 *   `ModerationService` — the enforcement half, the thing that actually mutes a
 *   participant and closes a socket — is provided by `WorldModule`, beside
 *   `ChatService` and for exactly the same reason phase 5 put it there: it needs
 *   `WorldInstanceService`, and the gateway needs it.
 *
 * What has to travel from HTTP back into the live world — a ban issued from the
 * panel removing somebody who is standing in the room — goes through
 * `WorldModerationBridge`, which the gateway fills in at bootstrap. Identical in
 * shape to phase 6's `IdentityBridge`, and for an identical reason.
 *
 * Every service here handles a **null** `DataSource`. A server with no database
 * has no roles, no bans and no audit log, and says so — the same supported state
 * phase 6 established, one phase further on.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccessPolicyService } from './access-policy.service.js';
import { AuditService } from './audit.service.js';
import { BlockService } from './block.service.js';
import { ModerationController } from './moderation.controller.js';
import { ReportService } from './report.service.js';
import { RolesGuard } from './roles.guard.js';
import { WorldModerationBridge } from './world-moderation.bridge.js';

@Module({
  imports: [AuthModule],
  controllers: [ModerationController],
  providers: [
    AccessPolicyService,
    AuditService,
    BlockService,
    ReportService,
    RolesGuard,
    WorldModerationBridge,
  ],
  exports: [
    AccessPolicyService,
    AuditService,
    BlockService,
    ReportService,
    RolesGuard,
    WorldModerationBridge,
  ],
})
export class ModerationModule {}
