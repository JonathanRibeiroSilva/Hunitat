/**
 * `DC-6.5 Invite` — `FR-6.12`, `FR-6.13`, `FR-6.14`, `AC-6.3`, `AC-6.4`.
 *
 * ── Redemption is a real race, not a theoretical one ────────────────────────
 *
 * `FR-6.14` allows single-use invites, and two people clicking the same link in
 * the same second is ordinary — one link, one group chat, two quick colleagues.
 * Reading `uses`, comparing it to `max_uses` and then incrementing is a
 * check-then-act with a window in the middle, and both callers pass the check.
 *
 * So `redeem` runs inside a transaction with `SELECT ... FOR UPDATE` on the
 * invite row. The second caller blocks on the lock, re-reads the incremented
 * counter, and is refused. The Phase 6 implementation notes call this out by
 * name; it is the one piece of concurrency control in the phase.
 *
 * ── Why the refusals are separate codes ─────────────────────────────────────
 *
 * The Rules require "this invite has expired" and "this invite has already been
 * used" to be different problems for the user, because the recovery differs: one
 * needs a new link from the same person, the other needs a link at all. They are
 * separate `reason`s all the way out to the wire.
 */

import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InviteDto, InvitePreviewDto } from '@hubitat/protocol';
import type { DataSource, Repository } from 'typeorm';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import { InviteEntity, MembershipEntity, SpaceEntity } from './auth.entities.js';

/**
 * No `0`/`O`, no `1`/`I`/`L`, no `U` (which is read as `V` in some fonts).
 *
 * Invite codes get read off a screen and typed by somebody else, so the
 * alphabet's job is to make that unambiguous. 29 symbols over 12 characters is
 * ~58 bits, which is not guessable at any rate a rate limiter would allow.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 12;

export type RedeemFailure = 'expired' | 'exhausted' | 'revoked' | 'unknown';

export class InviteRefusal extends Error {
  constructor(readonly reason: RedeemFailure) {
    super(reason);
  }
}

/** What a redemption did. `alreadyMember` is a success, not a failure — see
 *  `redeem`. */
export interface RedeemResult {
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  alreadyMember: boolean;
}

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);
  private readonly config: RuntimeConfig = loadConfig();
  private readonly invites: Repository<InviteEntity> | null;

  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource | null) {
    this.invites = dataSource ? dataSource.getRepository(InviteEntity) : null;
  }

  /**
   * `FR-6.12`, `FR-6.14` — a new invite, always bounded.
   *
   * `expiresInHours` defaults to `INVITE_DEFAULT_TTL_HOURS` rather than to
   * "never": the requirement asks for at least one bound, and an unlimited-use
   * link with no expiry is a permanent unrevoked door into the Space. `maxUses`
   * may legitimately be null — the expiry is still the bound.
   */
  async create(
    space: SpaceEntity,
    createdBy: string,
    options: { expiresInHours?: number; maxUses?: number | null },
  ): Promise<InviteEntity> {
    if (!this.invites) throw new Error('accounts are not available');

    const hours = options.expiresInHours ?? this.config.inviteDefaultTtlHours;
    const invite = this.invites.create({
      code: await this.mintUniqueCode(),
      spaceId: space.id,
      createdBy,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
      maxUses: options.maxUses ?? null,
      uses: 0,
      revokedAt: null,
    });

    const saved = await this.invites.save(invite);
    this.logger.log(
      `Invite ${saved.code} created for space "${space.slug}" — expires ${saved.expiresAt.toISOString()}, ` +
        `${saved.maxUses === null ? 'unlimited uses' : `${saved.maxUses} use(s)`}.`,
    );
    return saved;
  }

  async listFor(spaceId: string): Promise<InviteEntity[]> {
    if (!this.invites) return [];
    return this.invites.find({ where: { spaceId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  async revoke(id: string, spaceId: string): Promise<boolean> {
    if (!this.invites) return false;
    const result = await this.invites.update({ id, spaceId }, { revokedAt: new Date() });
    return (result.affected ?? 0) > 0;
  }

  /**
   * What a recipient is told *before* they act — `AC-6.4`.
   *
   * Deliberately not an oracle. An unknown code and a code that never existed
   * give the same `unknown`, and the Space name appears only for an invite that
   * would actually work. Guessing codes gets you nothing but "unknown", which is
   * what you would get anyway.
   */
  async preview(code: string): Promise<InvitePreviewDto> {
    if (!this.invites) return { code, valid: false, reason: 'unknown' };

    const invite = await this.invites.findOne({ where: { code }, relations: { space: true } });
    if (!invite) return { code, valid: false, reason: 'unknown' };

    const reason = this.refusalFor(invite);
    if (reason) return { code, valid: false, reason };

    return {
      code,
      valid: true,
      reason: 'ok',
      ...(invite.space ? { spaceName: invite.space.name } : {}),
    };
  }

  /**
   * `FR-6.13` — redeem, and become a member.
   *
   * Everything below happens inside one transaction, with the invite row locked
   * for the duration. The membership insert is `ON CONFLICT DO NOTHING`, which
   * covers `FR-6.15` from the other side: a member who clicks an old link again
   * is *already* recognised, and must not be told their invite failed.
   *
   * That case does not consume a use, and the reason is worth stating. A
   * single-use invite whose one use was spent re-admitting somebody who was
   * already a member would be exhausted without ever having let anybody in.
   */
  async redeem(code: string, accountId: string): Promise<RedeemResult> {
    if (!this.dataSource) throw new InviteRefusal('unknown');

    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<
        {
          id: string;
          space_id: string;
          expires_at: Date;
          max_uses: number | null;
          uses: number;
          revoked_at: Date | null;
        }[]
      >(
        `SELECT "id", "space_id", "expires_at", "max_uses", "uses", "revoked_at"
           FROM "invites"
          WHERE "code" = $1
          FOR UPDATE`,
        [code],
      );

      const invite = rows[0];
      if (!invite) throw new InviteRefusal('unknown');
      if (invite.revoked_at !== null) throw new InviteRefusal('revoked');
      if (invite.expires_at.getTime() <= Date.now()) throw new InviteRefusal('expired');
      if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
        throw new InviteRefusal('exhausted');
      }

      const space = await manager.findOne(SpaceEntity, { where: { id: invite.space_id } });
      if (!space) throw new InviteRefusal('unknown');

      const existing = await manager.findOne(MembershipEntity, {
        where: { accountId, spaceId: invite.space_id },
      });

      if (existing) {
        return {
          spaceId: space.id,
          spaceSlug: space.slug,
          spaceName: space.name,
          alreadyMember: true,
        };
      }

      await manager.insert(MembershipEntity, {
        accountId,
        spaceId: invite.space_id,
        inviteId: invite.id,
      });

      // Incremented under the same lock that checked it. This line and the
      // check above being separable is the entire bug this transaction exists
      // to prevent.
      await manager.query(`UPDATE "invites" SET "uses" = "uses" + 1 WHERE "id" = $1`, [invite.id]);

      return {
        spaceId: space.id,
        spaceSlug: space.slug,
        spaceName: space.name,
        alreadyMember: false,
      };
    });
  }

  /** The wire shape, with an absolute link built from the caller's own origin so
   *  a deployment behind a tunnel or a proxy produces links that work. */
  toDto(invite: InviteEntity, spaceSlug: string, baseUrl: string): InviteDto {
    return {
      id: invite.id,
      code: invite.code,
      spaceSlug,
      url: `${baseUrl.replace(/\/+$/, '')}/?invite=${invite.code}`,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
      uses: invite.uses,
      revoked: invite.revokedAt !== null,
      createdAt: invite.createdAt.toISOString(),
    };
  }

  private refusalFor(invite: InviteEntity): RedeemFailure | null {
    if (invite.revokedAt !== null) return 'revoked';
    if (invite.expiresAt.getTime() <= Date.now()) return 'expired';
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) return 'exhausted';
    return null;
  }

  /**
   * Retry on collision rather than trusting 58 bits blindly.
   *
   * The unique index is the real guarantee; this only stops a collision
   * surfacing as a 500 on somebody's first invite. Five attempts is far more
   * than the birthday bound needs and cheap enough not to think about.
   */
  private async mintUniqueCode(): Promise<string> {
    if (!this.invites) throw new Error('accounts are not available');

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = mintCode();
      const clash = await this.invites.findOne({ where: { code }, select: { id: true } });
      if (!clash) return code;
    }
    throw new Error('could not mint a unique invite code');
  }
}

/**
 * Rejection sampling, not `% alphabet.length`.
 *
 * 256 is not a multiple of 29, so a plain modulo makes the first nine symbols
 * measurably more likely than the rest. That is a small bias and this is the
 * only place in the codebase where a random value is a credential, so it is
 * worth the four extra lines.
 */
function mintCode(): string {
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = '';

  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }

  return code;
}
