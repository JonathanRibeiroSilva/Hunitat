/**
 * `DC-7.3`–`DC-7.7` — bans, blocks, reports, the allowlist and the audit log.
 *
 * The read model. `migrations/1756000000000-moderation.ts` is the authority on
 * what the database actually contains, as ADR 0008 requires and as phase 6
 * established.
 *
 * ── Two columns that are not here ───────────────────────────────────────────
 *
 * **Roles are not a table.** `FR-7.1` says every participant in a Space has a
 * role, and phase 6 already has the row that says a participant belongs to a
 * Space: `memberships`. A `roles` table would be a second answer to "does this
 * account belong here", and the two would disagree the first time one insert
 * failed. So the migration adds a column to `memberships` and `MembershipEntity`
 * grows a field; there is no entity in this file for it.
 *
 * **The access policy is not a table either**, for the same reason: `FR-7.11`–
 * `FR-7.14` are properties of a Space, `spaces` already exists, and a policy row
 * that could be missing would make "is this Space locked" a question with three
 * answers.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SpaceEntity } from '../auth/auth.entities.js';

/**
 * `DC-7.3` in its durable form — `FR-7.8`.
 *
 * ── Why one table holds two very different things ───────────────────────────
 *
 * An account ban is exact: it keys on `account_id`, survives every reconnect,
 * every browser and every network, and is checked the moment a token resolves. A
 * guest ban keys on a fingerprint cookie and an address, and the Phase 7 notes
 * are explicit that this is weak and that the weakness is to be documented
 * rather than solved.
 *
 * They are the same table because they answer the same question at the same
 * moment — "may this person enter" — and splitting them would mean two queries
 * on the join path and two places to forget the expiry check. `kind` says which
 * one a row is, so the interface can tell an administrator that the guest ban
 * they just issued is defeated by clearing cookies.
 */
@Entity({ name: 'bans' })
@Index('idx_bans_space', ['spaceId'])
@Index('idx_bans_account', ['accountId'])
@Index('idx_bans_fingerprint', ['fingerprint'])
export class BanEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'account' | 'guest';

  /** Set for `kind: 'account'`. The durable half of `FR-7.8`, and the only half
   *  that actually works. */
  @Column({ name: 'account_id', type: 'uuid', nullable: true })
  accountId!: string | null;

  /**
   * A guest's browser fingerprint, when there is one.
   *
   * Nullable because a client that sends none can still be banned by address
   * alone — badly, but banning nothing at all is worse — and because an account
   * ban has no use for it.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  fingerprint!: string | null;

  /**
   * The address the ban was issued from.
   *
   * Recorded for every ban and **matched only for guests**. On an account ban it
   * is evidence for whoever reads the audit log; matching on it would ban a
   * meeting room rather than a person. Even for guests it is the weakest of the
   * three signals — shared corporate NAT means one address is a floor of
   * colleagues — so it only ever matches *together with* a fingerprint, never
   * alone. See `AccessPolicyService.banFor`.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  ip!: string | null;

  /** What they were called when it happened. Denormalised on purpose: a ban list
   *  that says "account 0f3c…" is a list nobody can act on, and a guest has no
   *  row anywhere else to join against. */
  @Column({ name: 'display_name', type: 'varchar', length: 64 })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** The moderator's durable identity (`acct:<id>`). */
  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @Column({ name: 'created_by_name', type: 'varchar', length: 64 })
  createdByName!: string;

  /** `FR-7.8` — null is permanent, a date is time-limited. */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  /**
   * Set when a moderator lifts it, rather than the row being deleted.
   *
   * `FR-7.20` asks for a record that can be trusted. A ban that was issued and
   * then quietly removed is exactly the thing an audit trail exists to make
   * visible, and a `DELETE` would take the evidence with it.
   */
  @Column({ name: 'lifted_at', type: 'timestamptz', nullable: true })
  liftedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `DC-7.5 Block` — `FR-7.16`, `FR-7.18`.
 *
 * Keyed by the phase 6 identity string on both sides (`acct:<id>` or
 * `guest:<session>`), which is what makes `FR-7.18` fall out rather than need
 * implementing: an account's blocks are keyed by something that outlives the
 * session, so they persist across sign-ins, and a guest's are keyed by something
 * that does not, so they do not. That is precisely what the requirement asks for
 * — "durable for the blocker's identity (persists across sessions for accounts)"
 * — and it is the same asymmetry direct-message history already has.
 *
 * Not scoped to a Space. A block is a statement about a person, not about a
 * room, and somebody who does not want to hear from you in one place does not
 * want to hear from you in the next one.
 */
@Entity({ name: 'blocks' })
@Index('idx_blocks_blocker', ['blockerIdentity'])
export class BlockEntity {
  @PrimaryColumn({ name: 'blocker_identity', type: 'varchar', length: 128 })
  blockerIdentity!: string;

  @PrimaryColumn({ name: 'blocked_identity', type: 'varchar', length: 128 })
  blockedIdentity!: string;

  /** For the person managing their own list — "you blocked them in March". */
  @Column({ name: 'blocked_name', type: 'varchar', length: 64 })
  blockedName!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `DC-7.6 Report` — `FR-7.17`.
 *
 * Everything here except `reason` is captured by the server at the moment of
 * filing. `DC-7.6` asks for context, and a client-supplied position is a
 * client-supplied fact about the person being complained about — the one party
 * with a motive to misstate it.
 */
@Entity({ name: 'reports' })
@Index('idx_reports_space', ['spaceId'])
export class ReportEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  @Column({ name: 'reporter_identity', type: 'varchar', length: 128 })
  reporterIdentity!: string;

  @Column({ name: 'reporter_name', type: 'varchar', length: 64 })
  reporterName!: string;

  @Column({ name: 'target_identity', type: 'varchar', length: 128 })
  targetIdentity!: string;

  @Column({ name: 'target_name', type: 'varchar', length: 64 })
  targetName!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Map, position and zone occupancy at the moment it was filed. `jsonb`
   *  because it is read whole and never queried across rows. */
  @Column({ type: 'jsonb' })
  context!: {
    mapId: string;
    x: number;
    y: number;
    z: number;
    zoneIds: string[];
  };

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'reviewed_by', type: 'varchar', length: 64, nullable: true })
  reviewedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `DC-7.7 Audit Log` — `FR-7.19`, `FR-7.20`.
 *
 * ── Append-only is enforced, not intended ───────────────────────────────────
 *
 * The Phase 7 notes name this as a sharp edge: "`audit_log` append-only is a
 * grant, not a convention. Without the grant, `FR-7.20`'s tamper-evidence is a
 * comment in the code." The migration revokes `UPDATE`, `DELETE` and `TRUNCATE`
 * **and** installs a trigger, and the reason for both is in there.
 *
 * There is deliberately no `reviewedAt`, no `resolved` flag, and no soft-delete.
 * Every one of them would be a column the application has to be able to write,
 * and a table with one writable column is not append-only.
 */
@Entity({ name: 'audit_log' })
@Index('idx_audit_space_at', ['spaceId', 'at'])
export class AuditEntity {
  /**
   * `BIGSERIAL`, not a UUID.
   *
   * The order rows were written in is part of what makes a log trustworthy, and
   * a random primary key cannot express it — `created_at` alone ties at
   * millisecond resolution, which is exactly the resolution two moderation
   * actions in one request arrive at.
   */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @Column({ name: 'actor_identity', type: 'varchar', length: 128 })
  actorIdentity!: string;

  @Column({ name: 'actor_name', type: 'varchar', length: 64 })
  actorName!: string;

  /** `mute`, `kick`, `ban`, `role`, `access`, … — the verb, not a sentence.
   *  Sentences are built at read time so a wording change does not require
   *  rewriting rows that cannot be rewritten. */
  @Column({ type: 'varchar', length: 32 })
  action!: string;

  @Column({ name: 'target_identity', type: 'varchar', length: 128, nullable: true })
  targetIdentity!: string | null;

  @Column({ name: 'target_name', type: 'varchar', length: 64, nullable: true })
  targetName!: string | null;

  /** Whatever the action needs: a ban's duration, a role's before and after, the
   *  access field that changed. `jsonb` rather than a column per action type. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  detail!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  at!: Date;
}

/**
 * `FR-7.13` — the allowlist.
 *
 * Keyed by **email**, not by account id, and that is the requirement rather than
 * a shortcut: an allowlist exists to name people who may enter, and the useful
 * case is naming somebody before they have registered. An account-id list could
 * only ever admit people who were already here.
 *
 * The address is normalised the same way `emailSchema` normalises it, so the
 * comparison at join time is an index lookup on the value the account was
 * created with rather than a case-folding function nobody remembers to apply.
 */
@Entity({ name: 'space_allowlist' })
export class AllowlistEntity {
  @PrimaryColumn({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  @PrimaryColumn({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ name: 'added_by', type: 'varchar', length: 64 })
  addedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
