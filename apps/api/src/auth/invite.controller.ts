/**
 * Invites — `FR-6.12`, `FR-6.13`, `FR-6.14`, `AC-6.3`, `AC-6.4`.
 *
 * ── Who may issue one ───────────────────────────────────────────────────────
 *
 * A member of the Space. Phase 6 could only say that, because member-versus-guest
 * was the only distinction that existed (`FR-6.13`).
 *
 * Phase 7 says the same thing through the capability matrix instead, and one
 * answer changes: `manage-invites` is a member capability, so issuing invites
 * still works exactly as it did — but `PATCH /spaces/:slug`, which closes a
 * Space to guests, now needs `manage-access` and is therefore admin-only. That
 * is a deliberate tightening rather than a side effect. Phase 6's own note said
 * it: any member could close the Space "because member is the only distinction
 * that exists", and `FR-7.11`–`FR-7.15` make it one of five access controls that
 * clearly belong together.
 *
 * The checks are explicit calls rather than `RolesGuard`, because this
 * controller lives in `AuthModule` and the guard lives in `ModerationModule`,
 * which imports it. Both ask `hasCapability` about the same matrix, which is the
 * property `NFR-34` actually needs — one set of rules, not one decorator.
 *
 * ── The preview route is unauthenticated, and that is deliberate ────────────
 *
 * Somebody following an invite link usually has no account yet: the whole point
 * is that the link is how they get one. So `GET /invites/:code` is open, and
 * `InviteService.preview` is written to be worth nothing to a guesser — an
 * invented code and a real expired one both come back `unknown` without a Space
 * name attached.
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
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  hasCapability,
  inviteCodeSchema,
  inviteCreateRequestSchema,
  spaceUpdateRequestSchema,
  type AccountDto,
  type Capability,
  type InviteCreateRequest,
  type InviteDto,
  type InvitePreviewDto,
  type SpaceDto,
  type SpaceUpdateRequest,
} from '@hubitat/protocol';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { AccountService, type ResolvedAccount } from './account.service.js';
import { AccessTokenGuard, CurrentAccount } from './auth.guard.js';
import { InviteRefusal, InviteService, type RedeemFailure } from './invite.service.js';
import { RolesService } from './roles.service.js';
import { SpaceService } from './space.service.js';
import { ZodBody } from './zod.pipe.js';

/**
 * The Rules require expired and exhausted to be *different problems for the
 * user*, because the recovery differs: one needs a fresh link from the same
 * person, the other needs a link at all. Kept as one map so a new refusal reason
 * cannot be added without someone writing the sentence a person will read.
 */
const REFUSAL_MESSAGE: Record<RedeemFailure, string> = {
  expired: 'This invite has expired. Ask whoever sent it for a new one.',
  exhausted: 'This invite has already been used. Ask whoever sent it for a new one.',
  revoked: 'This invite was withdrawn. Ask whoever sent it for a new one.',
  unknown: 'That invite code is not valid. Check it for typos, or ask for a new link.',
};

@Controller()
export class InviteController {
  private readonly config: RuntimeConfig = loadConfig();

  constructor(
    private readonly invites: InviteService,
    private readonly spaces: SpaceService,
    private readonly accounts: AccountService,
    private readonly roles: RolesService,
  ) {}

  /** `AC-6.4` — what a recipient is told before they act. Open, by necessity. */
  @Get('invites/:code')
  async preview(@Param('code') raw: string): Promise<InvitePreviewDto> {
    const parsed = inviteCodeSchema.safeParse(raw);
    // A malformed code is answered like an unknown one rather than with a 400.
    // "That is not the right shape" and "that is not a real code" are the same
    // fact to the person holding a bad link, and separating them tells a guesser
    // when their format is right.
    if (!parsed.success) {
      return { code: raw.slice(0, 32), valid: false, reason: 'unknown' };
    }
    return this.invites.preview(parsed.data);
  }

  /**
   * `FR-6.13` — redeem, and become a member.
   *
   * Requires an account, because membership is a relationship between an account
   * and a Space (`DC-6.4`) and a guest has nothing to attach it to. The client
   * registers or signs in first and then calls this; a registration can also
   * carry the code, which collapses the two steps for somebody arriving fresh.
   */
  @Post('invites/:code/redeem')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async redeem(
    @Param('code') raw: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<AccountDto> {
    const parsed = inviteCodeSchema.safeParse(raw);
    if (!parsed.success) throw new UnprocessableEntityException(REFUSAL_MESSAGE.unknown);

    try {
      await this.invites.redeem(parsed.data, account.accountId);
    } catch (error) {
      if (error instanceof InviteRefusal) {
        // 422 rather than 404 or 403: the request was well-formed and the code
        // was found or not, but either way the *state* is what refuses it. A 404
        // would also confirm which codes exist.
        throw new UnprocessableEntityException(REFUSAL_MESSAGE[error.reason]);
      }
      throw error;
    }

    // The membership list is what changed, so the whole account comes back
    // rather than a bare 204 the client would have to follow with a `GET /me`.
    const described = await this.accounts.describe(account.accountId);
    if (!described) throw new NotFoundException('That account no longer exists.');
    return described;
  }

  /**
   * `FR-6.8` — "whether guests are allowed is configurable per Space".
   *
   * Configurable means somebody has to be able to configure it, and an
   * environment variable read once at boot is not that: `SPACE_ALLOW_GUESTS`
   * only *seeds* the row.
   *
   * Kept here rather than folded into `PATCH …/moderation/access`, which also
   * accepts `allowGuests`, because this is the route phase 6 published and the
   * client and the harness both call it. What changed in phase 7 is the check in
   * front of it: `manage-access`, so it is one of the five access controls
   * `FR-7.11`–`FR-7.15` group together rather than something any member can do.
   *
   * Closing a Space still does not evict the guests already inside. Removing
   * somebody mid-session is `FR-7.7`, it has its own rules and its own audit
   * entry, and doing it as a side effect of a policy change would be a kick with
   * none of them.
   */
  @Patch('spaces/:slug')
  @UseGuards(AccessTokenGuard)
  async updateSpace(
    @Param('slug') slug: string,
    @CurrentAccount() account: ResolvedAccount,
    @Body(new ZodBody(spaceUpdateRequestSchema)) body: SpaceUpdateRequest,
  ): Promise<SpaceDto> {
    const space = await this.requireSpace(slug);
    // `FR-7.11`–`FR-7.15` — admin, not member. See the file header for why this
    // is the one phase 6 behaviour phase 7 deliberately tightens.
    await this.require(account, 'manage-access');

    if (body.allowGuests !== undefined) await this.spaces.setAllowGuests(body.allowGuests);

    const updated = await this.spaces.current();
    return {
      slug: updated?.slug ?? space.slug,
      name: updated?.name ?? space.name,
      allowGuests: updated?.allowGuests ?? space.allowGuests,
    };
  }

  /** `FR-6.12`, `FR-6.14`. */
  @Post('spaces/:slug/invites')
  @UseGuards(AccessTokenGuard)
  async create(
    @Param('slug') slug: string,
    @CurrentAccount() account: ResolvedAccount,
    @Body(new ZodBody(inviteCreateRequestSchema)) body: InviteCreateRequest,
    @Req() request: Request,
  ): Promise<InviteDto> {
    const space = await this.requireSpace(slug);
    await this.require(account, 'manage-invites');

    const invite = await this.invites.create(space, account.accountId, {
      ...(body.expiresInHours !== undefined ? { expiresInHours: body.expiresInHours } : {}),
      ...(body.maxUses !== undefined ? { maxUses: body.maxUses } : {}),
    });

    return this.invites.toDto(invite, space.slug, this.publicBaseUrl(request));
  }

  /** The member's own view of what they have issued — including spent and
   *  expired ones, which is what makes "why is nobody getting in" answerable. */
  @Get('spaces/:slug/invites')
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('slug') slug: string,
    @CurrentAccount() account: ResolvedAccount,
    @Req() request: Request,
  ): Promise<InviteDto[]> {
    const space = await this.requireSpace(slug);
    await this.require(account, 'manage-invites');

    const invites = await this.invites.listFor(space.id);
    const baseUrl = this.publicBaseUrl(request);
    return invites.map((invite) => this.invites.toDto(invite, space.slug, baseUrl));
  }

  /**
   * Withdraw a link.
   *
   * Not required by any `FR` — `FR-6.14` asks only that invites be *bounded*.
   * It is here because the alternative to withdrawing a link that got forwarded
   * to the wrong list is waiting out its expiry, and the row already carries
   * `revoked_at` for reuse detection's sake.
   */
  @Delete('spaces/:slug/invites/:id')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async revoke(
    @Param('slug') slug: string,
    @Param('id') id: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<void> {
    const space = await this.requireSpace(slug);
    await this.require(account, 'manage-invites');

    const revoked = await this.invites.revoke(id, space.id);
    if (!revoked) throw new NotFoundException('No such invite in this space.');
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async requireSpace(slug: string) {
    const space = await this.spaces.current();
    if (!space) {
      throw new ServiceUnavailableException(
        'Invites are not available on this server: it is running without a database.',
      );
    }
    // Phase 6 has one Space, so a slug that does not match it is a client
    // pointed at the wrong deployment rather than a permissions problem.
    if (space.slug !== slug) throw new NotFoundException(`No space "${slug}".`);
    return space;
  }

  /**
   * `FR-7.4` — the capability check, spelled the same way the guard spells it.
   *
   * `hasCapability` against the one matrix in `@hubitat/protocol`, so this
   * controller and `RolesGuard` and the WebSocket handler all reach the same
   * answer. What differs is only how they get the role: this one asks
   * `RolesService` directly, because it lives on the side of the dependency graph
   * the guard's module imports.
   */
  private async require(account: ResolvedAccount, capability: Capability): Promise<void> {
    const role = await this.roles.roleOf(account.accountId);
    if (hasCapability(role, capability)) return;

    throw new ForbiddenException(
      capability === 'manage-invites'
        ? 'Only members of this space can create invites. Redeem an invite first.'
        : 'Only admins can change who may enter this space.',
    );
  }

  /** `PUBLIC_WEB_URL` when set, otherwise the caller's own origin — which is
   *  what makes links pasted from behind a tunnel actually resolve. */
  private publicBaseUrl(request: Request): string {
    if (this.config.publicWebUrl) return this.config.publicWebUrl;
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) return origin;
    const proto = (request.headers['x-forwarded-proto'] as string) ?? request.protocol;
    return `${proto}://${request.headers.host ?? 'localhost'}`;
  }
}
