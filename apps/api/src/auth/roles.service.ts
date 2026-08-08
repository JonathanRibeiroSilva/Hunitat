/**
 * `DC-7.1 Role` — `FR-7.1`, `FR-7.2`, `FR-7.3`.
 *
 * ── Why this lives in `auth/` and not in `moderation/` ──────────────────────
 *
 * A role is what an identity *is within a Space*, which is exactly what
 * `memberships` already records. Everything in `moderation/` — bans, blocks,
 * reports, the audit log — is about things that **happen**; this is about what
 * somebody **is**, and it is stored on the row phase 6 already writes.
 *
 * The dependency direction settles it: `ModerationModule` imports `AuthModule`
 * for the Space and the password hasher, so a roles service over there would
 * have to be imported back and that is a cycle. Auth needs the answer too — a
 * guest upgrading to an account is told their role on the `IDENTITY` frame — so
 * the service that owns it belongs on the side nothing else depends on.
 *
 * ── The one rule this file exists to hold ───────────────────────────────────
 *
 * From the Phase 7 Rules:
 *
 *   > The owner role must not be removable by anyone but through an explicit
 *   > ownership-transfer path.
 *
 * `setRole` refuses to write `owner` and refuses to overwrite one. `transfer` is
 * the only path that can, it is gated by its own capability, and it moves the
 * role rather than granting it — so a Space has exactly one owner at every
 * instant, including the instant in the middle.
 */

import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ROLE_RANK, type Role } from '@hubitat/protocol';
import { In, type DataSource, type Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { AccountEntity, MembershipEntity, ProfileEntity } from './auth.entities.js';
import { SpaceService } from './space.service.js';

/** A member of the Space with everything a roles screen needs, before the world
 *  is asked who is currently online. */
export interface MemberRecord {
  accountId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: Date;
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  private readonly memberships: Repository<MembershipEntity> | null;
  private readonly accounts: Repository<AccountEntity> | null;
  private readonly profiles: Repository<ProfileEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource | null,
    private readonly spaces: SpaceService,
  ) {
    this.memberships = dataSource ? dataSource.getRepository(MembershipEntity) : null;
    this.accounts = dataSource ? dataSource.getRepository(AccountEntity) : null;
    this.profiles = dataSource ? dataSource.getRepository(ProfileEntity) : null;
  }

  /**
   * `FR-7.1` — the role an account holds here, `guest` when it holds none.
   *
   * A signed-in account that has never redeemed an invite is a `guest` by this
   * function and an `account` by `FR-6.13`, and both are true: they own their
   * name and they do not belong to this Space. Phase 6 already draws that
   * distinction; this is what it means for permissions.
   *
   * With no database everybody is a guest, which is the same answer phase 6
   * gives to every identity question in that configuration.
   */
  async roleOf(accountId: string | null | undefined): Promise<Role> {
    if (!accountId || !this.memberships) return 'guest';

    const space = await this.spaces.current();
    if (!space) return 'guest';

    const membership = await this.memberships.findOne({
      where: { accountId, spaceId: space.id },
    });
    if (!membership) return 'guest';

    // Promoted on read rather than on write, because the row that needs it was
    // created by phase 6 code that had no column to put it in. See `claimOwner`.
    if (membership.role === 'member') {
      const promoted = await this.claimOwner(space.id, accountId);
      if (promoted) return 'owner';
    }

    return membership.role;
  }

  /**
   * `FR-7.3` — assign or revoke, within what the actor may hand out.
   *
   * Three refusals, and each is a different mistake:
   *
   *   - `owner` as the requested role. The schema already refuses it; this is the
   *     second door, because "the owner role must not be removable" has to hold
   *     even if somebody later adds a call site that skips the schema.
   *   - the **target** is the owner. An admin who could demote the owner could
   *     take a Space; an owner who could demote themselves could orphan one.
   *   - the actor does not outrank the target. Two admins cannot demote each
   *     other, which is the same rule that stops them kicking each other and for
   *     the same reason: there is no way to undo it from the losing side.
   *
   * Returns the previous role, which the audit entry needs — `FR-7.19` asks what
   * happened, and "set to member" without "from admin" is half a record.
   */
  async setRole(
    actorRole: Role,
    actorAccountId: string,
    targetAccountId: string,
    role: Role,
  ): Promise<{ previous: Role }> {
    this.require();
    const space = (await this.spaces.current())!;

    if (role === 'owner') {
      throw new ForbiddenException(
        'Ownership moves through the transfer path, not through a role change.',
      );
    }

    const membership = await this.memberships!.findOne({
      where: { accountId: targetAccountId, spaceId: space.id },
    });
    if (!membership) throw new NotFoundException('That account is not a member of this space.');

    const previous = membership.role as Role;

    if (previous === 'owner') {
      throw new ForbiddenException(
        'The owner cannot be demoted. Transfer ownership first, then change the role.',
      );
    }
    if (targetAccountId === actorAccountId) {
      // Reachable only for a non-owner, since the owner check above catches the
      // usual case. Refused anyway: a role change is an act performed on
      // somebody, and performing it on yourself is either a mistake or an
      // escalation.
      throw new ForbiddenException('You cannot change your own role.');
    }
    if (ROLE_RANK[actorRole] <= ROLE_RANK[previous]) {
      throw new ForbiddenException(`You cannot change the role of ${previous}s.`);
    }

    if (role === 'guest') {
      // `guest` is the absence of a membership, not a value the column holds —
      // the check constraint would refuse it, and storing it would create a
      // membership that is not one. Revoking the role revokes the membership,
      // which is what "revoke" means in `FR-7.3`.
      await this.memberships!.delete({ accountId: targetAccountId, spaceId: space.id });
      this.logger.log(`Membership revoked for ${targetAccountId} in "${space.slug}".`);
      return { previous };
    }

    await this.memberships!.update(
      { accountId: targetAccountId, spaceId: space.id },
      { role: role as 'admin' | 'member' },
    );
    this.logger.log(`${targetAccountId} is now ${role} in "${space.slug}".`);
    return { previous };
  }

  /**
   * The Rules' "explicit ownership-transfer path".
   *
   * Both writes in one transaction, because the intermediate states are both
   * wrong: two owners is a Space where either can remove the other, and no owner
   * is a Space where nobody can appoint one. The successor must already be a
   * member — ownership is not a way to add somebody.
   */
  async transferOwnership(
    fromAccountId: string,
    toAccountId: string,
  ): Promise<{ previousRole: Role }> {
    this.require();
    const space = (await this.spaces.current())!;

    if (fromAccountId === toAccountId) {
      throw new ForbiddenException('You already own this space.');
    }

    return this.dataSource!.transaction(async (manager) => {
      const successor = await manager.findOne(MembershipEntity, {
        where: { accountId: toAccountId, spaceId: space.id },
      });
      if (!successor) {
        throw new NotFoundException(
          'That account is not a member of this space. Ownership can only move to a member.',
        );
      }

      const previousRole = successor.role as Role;

      await manager.update(
        MembershipEntity,
        { accountId: toAccountId, spaceId: space.id },
        { role: 'owner' },
      );
      // The outgoing owner becomes an admin rather than a member: they keep the
      // ability to moderate, which is what somebody handing over a Space almost
      // always intends, and losing it silently at the same moment is a surprise
      // with no undo.
      await manager.update(
        MembershipEntity,
        { accountId: fromAccountId, spaceId: space.id },
        { role: 'admin' },
      );

      this.logger.log(
        `Ownership of "${space.slug}" transferred from ${fromAccountId} to ${toAccountId}.`,
      );
      return { previousRole };
    });
  }

  /** Everyone who belongs here, owners first. The roles screen's whole list. */
  async members(): Promise<MemberRecord[]> {
    if (!this.memberships) return [];
    const space = await this.spaces.current();
    if (!space) return [];

    // Ensure the founding row has been promoted before anybody reads the list,
    // or a Space whose owner has not signed in since the migration shows four
    // members and no owner.
    await this.ensureOwner(space.id);

    const rows = await this.memberships.find({
      where: { spaceId: space.id },
      order: { joinedAt: 'ASC' },
    });
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.accountId);
    const [accounts, profiles] = await Promise.all([
      this.accounts!.find({ where: { id: In(ids) } }),
      this.profiles!.find({ where: { accountId: In(ids) } }),
    ]);

    const emailById = new Map(accounts.map((account) => [account.id, account.email]));
    const nameById = new Map(profiles.map((profile) => [profile.accountId, profile.displayName]));

    return rows
      .map((row) => ({
        accountId: row.accountId,
        email: emailById.get(row.accountId) ?? '',
        displayName: nameById.get(row.accountId) ?? emailById.get(row.accountId) ?? 'Unknown',
        role: row.role as Role,
        joinedAt: row.joinedAt,
      }))
      .sort(
        (a, b) =>
          ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.displayName.localeCompare(b.displayName),
      );
  }

  /**
   * Give the founding member the owner role, if the Space has no owner yet.
   *
   * Phase 6's `grantFoundingMembership` admitted the first account "because there
   * was nobody to issue an invite". Phase 7 has the same bootstrap problem one
   * level up: a Space whose members are all `member` has nobody who can appoint
   * an admin, and `manage-roles` is owner-only. So the earliest membership
   * becomes the owner.
   *
   * Conditional in SQL rather than read-then-write, because two people signing in
   * at once would both see "no owner" and both claim it. `WHERE NOT EXISTS` makes
   * the second statement a no-op instead.
   */
  private async claimOwner(spaceId: string, accountId: string): Promise<boolean> {
    const result = await this.memberships!.query(
      `UPDATE "memberships" AS m
          SET "role" = 'owner'
        WHERE m."space_id" = $1
          AND m."account_id" = $2
          AND m."role" = 'member'
          AND NOT EXISTS (
                SELECT 1 FROM "memberships" o
                 WHERE o."space_id" = $1 AND o."role" = 'owner')
          AND m."joined_at" = (
                SELECT MIN(e."joined_at") FROM "memberships" e WHERE e."space_id" = $1)`,
      [spaceId, accountId],
    );

    // `query` returns [rows, affected] for an UPDATE under the postgres driver.
    const affected = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    if (affected > 0) {
      this.logger.log(
        `Account ${accountId} is the earliest member of this space and had no owner above ` +
          `them, so they hold the owner role (FR-7.3). Transfer it from the moderation panel.`,
      );
    }
    return affected > 0;
  }

  /** The same promotion, without knowing who to promote — used when the list is
   *  read rather than when somebody signs in. */
  private async ensureOwner(spaceId: string): Promise<void> {
    const earliest = await this.memberships!.findOne({
      where: { spaceId },
      order: { joinedAt: 'ASC' },
    });
    if (earliest && earliest.role === 'member') await this.claimOwner(spaceId, earliest.accountId);
  }

  private require(): void {
    if (!this.memberships || !this.dataSource) {
      throw new NotFoundException('Roles are not available on a server without a database.');
    }
  }
}
