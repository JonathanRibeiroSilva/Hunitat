/**
 * The administrative half of phase 7 — roles, access policy, bans, reports and
 * the audit log.
 *
 * ── The split with the socket ───────────────────────────────────────────────
 *
 * `MODERATE`, `BLOCK` and `REPORT` are WebSocket frames because each one acts on
 * a **session**: somebody standing in the room, addressed by the session id the
 * presence list already holds, with an effect `FR-7.10` requires to be immediate.
 *
 * Everything here is the opposite. A role outlives every session. A ban has to be
 * issuable against somebody who logged off an hour ago. An access policy is read
 * at the door by people who are not through it yet, and an audit log is read by
 * an admin who may not be in the world at all. None of that fits on a connection
 * that requires a `JOIN` first — which is the same argument phase 6 made for
 * putting accounts on HTTP, one phase later.
 *
 * ── Every route is guarded twice, and that is not redundant ─────────────────
 *
 * `AccessTokenGuard` establishes **who**; `RolesGuard` establishes **what they
 * may do**. Splitting them is what lets the WebSocket path reuse the second
 * decision without inheriting the first, which arrives there as a frame rather
 * than as a header — and `NFR-34` requires both paths to reach the same answer.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CAPABILITIES,
  accessPolicyUpdateSchema,
  allowlistEntrySchema,
  banCreateSchema,
  ownershipTransferSchema,
  outranks,
  roleUpdateSchema,
  type AccessPolicyUpdate,
  type AllowlistEntry,
  type BanCreateRequest,
  type ModerationOverviewDto,
  type OwnershipTransfer,
  type Role,
  type RoleUpdate,
} from '@hubitat/protocol';
import { accountIdentity } from '@hubitat/protocol';
import { AccountService, type ResolvedAccount } from '../auth/account.service.js';
import { AccessTokenGuard, CurrentAccount } from '../auth/auth.guard.js';
import { RolesService } from '../auth/roles.service.js';
import { SpaceService } from '../auth/space.service.js';
import { ZodBody } from '../auth/zod.pipe.js';
import { AccessPolicyService } from './access-policy.service.js';
import { AuditService } from './audit.service.js';
import { ReportService } from './report.service.js';
import { RequireCapability, RolesGuard, type RoleAwareRequest } from './roles.guard.js';
import { WorldModerationBridge } from './world-moderation.bridge.js';

@Controller('spaces/:slug/moderation')
@UseGuards(AccessTokenGuard, RolesGuard)
export class ModerationController {
  constructor(
    private readonly spaces: SpaceService,
    private readonly accounts: AccountService,
    private readonly roles: RolesService,
    private readonly access: AccessPolicyService,
    private readonly reports: ReportService,
    private readonly audit: AuditService,
    private readonly world: WorldModerationBridge,
  ) {}

  /**
   * Everything a moderation screen needs, in one response.
   *
   * One call rather than six, because five of them are useless alone: a member
   * list with no roles, a ban list with no audit trail, reports with nothing to
   * act on. The alternative is a screen that reconciles six responses and
   * renders four loading states.
   *
   * Available to any signed-in account, and what comes back depends on their
   * role. A member gets their own role and capabilities and empty lists — which
   * is the honest answer and is what lets the client decide whether to offer the
   * panel at all without a second endpoint to ask.
   */
  @Get()
  async overview(
    @Param('slug') slug: string,
    @Req() request: RoleAwareRequest,
  ): Promise<ModerationOverviewDto> {
    await this.requireSpace(slug);
    const role = request.role ?? 'guest';
    const capabilities = [...CAPABILITIES[role]];

    if (!capabilities.includes('review')) {
      return {
        role,
        capabilities,
        access: await this.access.describe(),
        members: [],
        bans: [],
        reports: [],
        audit: [],
      };
    }

    const online = new Set(this.world.connected().map((participant) => participant.accountId));

    const [members, bans, reports, audit, access] = await Promise.all([
      this.roles.members(),
      this.access.listBans(),
      this.reports.recent(),
      this.audit.recent(),
      this.access.describe(),
    ]);

    return {
      role,
      capabilities,
      access,
      members: members.map((member) => ({
        accountId: member.accountId,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
        online: online.has(member.accountId),
      })),
      bans,
      reports,
      audit,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.3 — roles
  // ───────────────────────────────────────────────────────────────────────────

  @Patch('members/:accountId/role')
  @RequireCapability('manage-roles')
  async setRole(
    @Param('slug') slug: string,
    @Param('accountId') targetAccountId: string,
    @Body(new ZodBody(roleUpdateSchema)) body: RoleUpdate,
    @CurrentAccount() actor: ResolvedAccount,
    @Req() request: RoleAwareRequest,
  ): Promise<{ role: Role }> {
    await this.requireSpace(slug);

    const target = await this.accounts.describe(targetAccountId);
    if (!target) throw new NotFoundException('No such account.');

    const { previous } = await this.roles.setRole(
      request.role ?? 'guest',
      actor.accountId,
      targetAccountId,
      body.role,
    );

    // The live half of `FR-7.10`. A demoted admin standing in the world keeps
    // the moderation controls on screen until something tells their client
    // otherwise, and "the buttons were still there" is how somebody discovers a
    // role change by being refused.
    this.world.refreshRole(targetAccountId, body.role);

    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'role',
      targetIdentity: accountIdentity(targetAccountId),
      targetName: target.displayName,
      detail: { from: previous, to: body.role },
    });

    return { role: body.role };
  }

  /** The Rules' "explicit ownership-transfer path". Its own route and its own
   *  capability, so a generic role change can never reach it. */
  @Post('transfer-ownership')
  @HttpCode(200)
  @RequireCapability('transfer-ownership')
  async transferOwnership(
    @Param('slug') slug: string,
    @Body(new ZodBody(ownershipTransferSchema)) body: OwnershipTransfer,
    @CurrentAccount() actor: ResolvedAccount,
  ): Promise<{ ok: true }> {
    await this.requireSpace(slug);

    const target = await this.accounts.describe(body.accountId);
    if (!target) throw new NotFoundException('No such account.');

    const { previousRole } = await this.roles.transferOwnership(actor.accountId, body.accountId);

    this.world.refreshRole(body.accountId, 'owner');
    this.world.refreshRole(actor.accountId, 'admin');

    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'ownership-transfer',
      targetIdentity: accountIdentity(body.accountId),
      targetName: target.displayName,
      detail: { from: previousRole, to: 'owner', outgoingOwnerBecomes: 'admin' },
    });

    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.11 – FR-7.15 — access policy
  // ───────────────────────────────────────────────────────────────────────────

  @Patch('access')
  @RequireCapability('manage-access')
  async updateAccess(
    @Param('slug') slug: string,
    @Body(new ZodBody(accessPolicyUpdateSchema)) body: AccessPolicyUpdate,
    @CurrentAccount() actor: ResolvedAccount,
  ) {
    await this.requireSpace(slug);
    const changed = await this.access.update(body);

    // `FR-7.19` lists access changes among the actions that must be recorded.
    // A no-op patch writes nothing: "changed the access policy" with nothing
    // after it makes a log harder to read rather than easier.
    if (Object.keys(changed).length > 0) {
      await this.audit.record({
        actorIdentity: accountIdentity(actor.accountId),
        actorName: actor.displayName,
        action: 'access',
        detail: changed,
      });
    }

    return this.access.describe();
  }

  @Post('allowlist')
  @HttpCode(200)
  @RequireCapability('manage-access')
  async addAllowlist(
    @Param('slug') slug: string,
    @Body(new ZodBody(allowlistEntrySchema)) body: AllowlistEntry,
    @CurrentAccount() actor: ResolvedAccount,
  ) {
    await this.requireSpace(slug);
    await this.access.addToAllowlist(body.email, actor.displayName);
    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'allowlist',
      detail: { added: body.email },
    });
    return this.access.describe();
  }

  @Delete('allowlist/:email')
  @RequireCapability('manage-access')
  async removeAllowlist(
    @Param('slug') slug: string,
    @Param('email') email: string,
    @CurrentAccount() actor: ResolvedAccount,
  ) {
    await this.requireSpace(slug);
    const normalised = email.trim().toLowerCase();
    await this.access.removeFromAllowlist(normalised);
    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'allowlist',
      detail: { removed: normalised },
    });
    return this.access.describe();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.8 — bans against people who are not here
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Ban an account, whether or not it is connected.
   *
   * The socket's `MODERATE ban` handles somebody standing in front of you. This
   * handles the other case — a report filed twenty minutes ago about a person who
   * has since logged off — which the socket cannot, because it addresses a
   * session and there is no session to address.
   */
  @Post('bans')
  @HttpCode(201)
  @RequireCapability('ban')
  async ban(
    @Param('slug') slug: string,
    @Body(new ZodBody(banCreateSchema)) body: BanCreateRequest,
    @CurrentAccount() actor: ResolvedAccount,
    @Req() request: RoleAwareRequest,
  ) {
    await this.requireSpace(slug);

    const target = await this.accounts.describe(body.accountId);
    if (!target) throw new NotFoundException('No such account.');

    // `FR-7.3` in its general form — see `outranks` for why it is strict. An
    // admin who could ban another admin could ban the one who is about to
    // review what they did.
    const targetRole = await this.roles.roleOf(body.accountId);
    if (!outranks(request.role ?? 'guest', targetRole)) {
      throw new ForbiddenException(
        targetRole === 'owner'
          ? 'The owner of this space cannot be banned.'
          : `You cannot ban another ${targetRole}.`,
      );
    }

    const identity = accountIdentity(body.accountId);
    const live = this.world.sessionsOf(identity);

    const row = await this.access.ban({
      accountId: body.accountId,
      fingerprint: null,
      // Recorded from whichever session they are on, as evidence. Never matched
      // against for an account ban — see `AccessPolicyService.banFor`.
      ip: live[0]?.ip ?? null,
      displayName: target.displayName,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
      createdBy: accountIdentity(actor.accountId),
      createdByName: actor.displayName,
    });
    if (!row) throw new ServiceUnavailableException('Bans need a database.');

    // `FR-7.10`, and the reason this endpoint talks to the world at all: a ban
    // that only refuses the *next* join leaves the person banned still standing
    // in the room until they choose to leave.
    for (const session of live) {
      this.world.kick(session.sessionId, banMessageFor(row.expiresAt, row.reason), true);
    }

    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'ban',
      targetIdentity: identity,
      targetName: target.displayName,
      detail: {
        expiresAt: row.expiresAt?.toISOString() ?? null,
        reason: row.reason,
        removedSessions: live.length,
      },
    });

    return this.access.listBans();
  }

  @Delete('bans/:id')
  @RequireCapability('ban')
  async unban(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentAccount() actor: ResolvedAccount,
  ) {
    await this.requireSpace(slug);
    const lifted = await this.access.lift(id);
    if (!lifted) throw new NotFoundException('No such active ban in this space.');

    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'unban',
      targetIdentity: lifted.accountId ? accountIdentity(lifted.accountId) : null,
      targetName: lifted.displayName,
      detail: { banId: lifted.id, kind: lifted.kind },
    });

    return this.access.listBans();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.17 — reports
  // ───────────────────────────────────────────────────────────────────────────

  @Post('reports/:id/reviewed')
  @HttpCode(200)
  @RequireCapability('review')
  async reviewReport(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentAccount() actor: ResolvedAccount,
  ) {
    await this.requireSpace(slug);

    const report = await this.reports.find(id);
    if (!report) throw new NotFoundException('No such report.');

    const marked = await this.reports.markReviewed(id, actor.displayName);
    if (!marked) throw new NotFoundException('No such report.');

    // Marking a report reviewed is itself a moderation act — it is the moment
    // somebody took responsibility for a complaint — so it goes in the log the
    // reports table cannot, because reports are a queue and the log is not.
    await this.audit.record({
      actorIdentity: accountIdentity(actor.accountId),
      actorName: actor.displayName,
      action: 'report-reviewed',
      targetIdentity: report.targetIdentity,
      targetName: report.targetName,
      detail: { reportId: id },
    });

    return this.reports.recent();
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async requireSpace(slug: string) {
    const space = await this.spaces.current();
    if (!space) {
      throw new ServiceUnavailableException(
        'Moderation is not available on this server: it is running without a database. ' +
          'Roles, bans and the audit log all need one.',
      );
    }
    if (space.slug !== slug) throw new NotFoundException(`No space "${slug}".`);
    return space;
  }
}

/** The same sentence a refused join gets, so somebody removed by a ban and
 *  somebody refused by one read the same thing. */
function banMessageFor(expiresAt: Date | null, reason: string | null): string {
  const until = expiresAt
    ? `until ${expiresAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'from this space';
  return `You have been banned ${until}.${reason ? ` Reason: ${reason}` : ''}`;
}

/** A request with a `slug` param, for the routes above. Exported so the module
 *  file does not have to import express types to describe them. */
export type SpaceRequest = Request & { params: { slug: string } };
