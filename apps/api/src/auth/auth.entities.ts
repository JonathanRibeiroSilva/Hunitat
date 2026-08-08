/**
 * `DC-6.1`–`DC-6.6` — accounts, profiles, spaces, memberships, invites, sessions.
 *
 * Decorated classes rather than a schema builder, as ADR 0008 chose, so the
 * shape lives beside the code that reads it. The SQL that creates them is
 * hand-written in `migrations/1755000000000-accounts.ts`; these are the read
 * model, and the migration is the authority.
 *
 * ── Two things that are not here, deliberately ──────────────────────────────
 *
 * **No password column anywhere but `accounts.password_hash`,** and nothing that
 * can be reversed into one. `FR-6.3` is a guarantee about what the table
 * contains, not about what the code does with it — the only way to keep it is to
 * have nowhere to put a recoverable secret.
 *
 * **No password column anywhere but `accounts.password_hash` and
 * `spaces.access_password_hash`,** and nothing that can be reversed into either.
 * The second one arrives in phase 7 (`FR-7.12`) and is argon2id like the first,
 * for the same reason: a Space password is typed by people, so it is chosen
 * badly, so a fast hash is the wrong hash.
 *
 * Phase 7 also adds a `role` column to `memberships` and the access-policy
 * columns to `spaces`, rather than tables of their own. Both are properties of
 * rows that already exist, and a separate table would make "does this account
 * belong here" and "is this Space locked" questions with two answers. The
 * moderation entities that genuinely are new — bans, blocks, reports, the audit
 * log, the allowlist — live in `moderation/moderation.entities.ts`.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AvatarAppearance, PresenceStatus } from '@hubitat/protocol';

/**
 * `DC-8.1 Space`, in the minimal form phase 6 needs.
 *
 * Phase 6 has exactly one row and phase 8 is where this becomes a real
 * multi-tenant table, so everything that would only matter with more than one
 * Space — owners, directories, per-space maps — is absent. What is here is what
 * `FR-6.8` and `FR-6.13` actually require: something for a membership to point
 * at, and a flag saying whether strangers may walk in.
 */
@Entity({ name: 'spaces' })
export class SpaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable, human-readable, and what `SPACE_SLUG` seeds. URLs and invite links
   *  are built from it, so it is the id that survives a rename. */
  @Column({ type: 'varchar', length: 64, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  /**
   * `FR-6.8` — whether guests may enter at all.
   *
   * The database is authoritative once the row exists; `SPACE_ALLOW_GUESTS` only
   * seeds it. Otherwise an operator who closed the Space through the API would
   * find it reopened by the next restart, which is a policy silently reverting
   * to a default.
   */
  @Column({ name: 'allow_guests', type: 'boolean', default: true })
  allowGuests!: boolean;

  // ── DC-7.4 Access Policy — phase 7 ─────────────────────────────────────────
  //
  // Columns rather than a table, for the reason the file header gives: a policy
  // row that could be missing would make "is this Space locked" a question with
  // three answers, and the safe default for a missing row is the opposite of the
  // safe default for a missing column.

  /** `FR-7.11` — no new participants may enter. People already inside stay,
   *  which is what makes this a door rather than an eviction. */
  @Column({ type: 'boolean', default: false })
  locked!: boolean;

  /**
   * `FR-7.12` — argon2id, like an account password.
   *
   * A Space password is typed by people and shared out loud, so it is chosen
   * badly and it is guessable. That is precisely the case a slow hash defends,
   * and using a fast one here because "it is only a room password" would put the
   * one credential most likely to be reused in a whole company behind SHA-256.
   */
  @Column({ name: 'access_password_hash', type: 'text', nullable: true })
  accessPasswordHash!: string | null;

  /** `FR-7.13` — when true, `space_allowlist` decides. Separate from the list
   *  being empty: an empty allowlist that is *on* admits nobody, which is a
   *  legitimate way to close a Space, and an allowlist that is *off* should not
   *  start refusing people the moment somebody adds the first entry. */
  @Column({ name: 'allowlist_enabled', type: 'boolean', default: false })
  allowlistEnabled!: boolean;

  /** `FR-7.14`. Null means `DEFAULT_MAP_CAPACITY`; the column exists so a Space
   *  can be made smaller than the map without rebuilding the map. */
  @Column({ type: 'int', nullable: true })
  capacity!: number | null;

  // ── DC-8.1 Space — phase 8 ─────────────────────────────────────────────────
  //
  // The three columns that turn "the Space" into "a Space". Every one of them is
  // nullable and every default is the phase 7 behaviour, so a database that
  // existed before this migration keeps working exactly as it did: one Space,
  // owned by nobody in particular, landing on the only Map there is.

  /**
   * `FR-8.1` — a Space is owned by an account.
   *
   * Nullable because the Space that phase 6's migration seeded predates the idea
   * of ownership, and because a server running before anybody has signed in has
   * no account to point at. `RolesService` already promotes the first account to
   * `owner`; this column is where that fact becomes a property of the Space
   * rather than of a membership row, which is what `FR-8.15`'s "create a Space"
   * needs in order to say who created it.
   */
  @Column({ name: 'owner_account_id', type: 'uuid', nullable: true })
  ownerAccountId!: string | null;

  /**
   * `FR-8.2`, `FR-8.7` — where somebody entering the Space lands.
   *
   * A uuid pointing into `maps`, with no foreign key on purpose: the Map may be
   * deleted, and a Space that could not be *loaded* because its landing Map was
   * removed would be a Space nobody could enter to fix. `MapRegistry` falls back
   * to the lowest-sorted live Map, which is what `FR-8.7` actually asks for —
   * "a valid spawn on the default map" is about arriving somewhere sensible, not
   * about a pointer being intact.
   */
  @Column({ name: 'default_map_id', type: 'uuid', nullable: true })
  defaultMapId!: string | null;

  /** `FR-8.17` — inaccessible but retained. Distinct from deletion, which is
   *  durable removal; an archived Space refuses entry and keeps everything. */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/** `DC-6.1 Account` — the durable identity everything else in phase 6 hangs off. */
@Entity({ name: 'accounts' })
export class AccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Stored already normalised — lowercased and trimmed by `emailSchema` before
   * it ever reaches here.
   *
   * The unique index is on this exact value rather than on `lower(email)`,
   * because a functional index would let a call site that forgot to normalise
   * *insert* a mixed-case duplicate that the index still considers distinct.
   * Normalising at the edge and indexing the plain column means there is one
   * spelling of an address in the system and the constraint enforces it.
   */
  @Column({ type: 'varchar', length: 320, unique: true })
  email!: string;

  /**
   * argon2id, at the OWASP floor (`FR-6.3`, ADR 0011).
   *
   * The encoded string carries its own parameters, which is what makes raising
   * `ARGON2_MEMORY_KIB` safe: existing hashes keep verifying against the
   * parameters they were made with, and `PasswordService` re-hashes them on the
   * next successful sign-in.
   */
  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * `DC-6.2 Profile` — `FR-6.9`, `FR-6.10`.
 *
 * A table of its own rather than columns on `accounts`, because the two have
 * different lifetimes and different readers: credentials are written at
 * registration and at a password change, and the profile is read on every join
 * and written whenever somebody picks a different hat. Phase 4's note that
 * appearance "moves to `profiles.avatar_appearance` and nothing else about it
 * changes" is this row.
 */
@Entity({ name: 'profiles' })
export class ProfileEntity {
  @PrimaryColumn({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @OneToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity;

  @Column({ name: 'display_name', type: 'varchar', length: 64 })
  displayName!: string;

  /** `DC-4.1`, durable at last. `jsonb` rather than columns per field: it is
   *  read and written whole, never queried across accounts. */
  @Column({ name: 'avatar_appearance', type: 'jsonb' })
  avatarAppearance!: AvatarAppearance;

  /** `DC-6.2` "status preferences" — what to return as. The live value is a
   *  `SET_STATUS` frame and is not persisted; the *preference* is. */
  @Column({ name: 'status_preference', type: 'varchar', length: 16, default: 'available' })
  statusPreference!: PresenceStatus;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * `DC-6.4 Membership` — `FR-6.15`, `FR-6.16`.
 *
 * A join table with a composite key, which is what makes "a returning member is
 * recognised without re-invitation" true by construction: the row is the
 * recognition, and there is nowhere for a second one to go.
 */
@Entity({ name: 'memberships' })
export class MembershipEntity {
  @PrimaryColumn({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @PrimaryColumn({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  /** `DC-6.4` asks for the date joined, so it is a column rather than an
   *  inference from whichever invite happened to be redeemed. */
  @CreateDateColumn({ name: 'joined_at', type: 'timestamptz' })
  joinedAt!: Date;

  /** Which invite let them in, when one did. Null for the account that created
   *  the Space, and for an administrative grant. Phase 7's audit log is where
   *  this stops being a convenience and starts being a requirement. */
  @Column({ name: 'invite_id', type: 'uuid', nullable: true })
  inviteId!: string | null;

  /**
   * `DC-7.1 Role` — `FR-7.1`, `FR-7.2`.
   *
   * On this row rather than in a table of its own, because a role is what an
   * identity *is within a Space* and that is exactly what this row already
   * records. `FR-7.16` gives an account with no membership the `guest` role by
   * absence, which is why there is no fourth value here: `guest` is what you get
   * when there is no row, and storing it would create a membership that is not
   * one.
   *
   * The default is `member`, so every row phase 6 wrote means what it meant.
   * `RolesService` promotes the founding member to `owner` on first sight — a
   * Space whose only account is a member has nobody who can appoint anybody.
   */
  @Column({ type: 'varchar', length: 16, default: 'member' })
  role!: 'owner' | 'admin' | 'member';
}

/**
 * `DC-6.5 Invite` — `FR-6.12`, `FR-6.13`, `FR-6.14`.
 *
 * `uses` is a counter on the row rather than a count of memberships, and the
 * difference is load-bearing: an invite that admitted somebody who has since
 * been removed has still been used, and a single-use link must not become
 * reusable because its one redemption was undone.
 */
@Entity({ name: 'invites' })
@Index('idx_invites_space', ['spaceId'])
export class InviteEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Uppercase, from an unambiguous alphabet — these get read aloud and typed
   *  by hand. Unique, because it is what a redemption looks up. */
  @Column({ type: 'varchar', length: 32, unique: true })
  code!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  /**
   * `FR-6.14` — never null.
   *
   * Every invite is bounded in time even when its use count is not, because
   * "at least one bound mechanism is required" and an unlimited-use link with no
   * expiry is a permanent door. `INVITE_DEFAULT_TTL_HOURS` fills this in when the
   * caller does not.
   */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Null means unlimited uses; the expiry above is still the bound. */
  @Column({ name: 'max_uses', type: 'int', nullable: true })
  maxUses!: number | null;

  @Column({ type: 'int', default: 0 })
  uses!: number;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `DC-6.6 Auth Session` — the refresh half. `FR-6.17`, ADR 0011.
 *
 * ── Why rows at all, when the access token is stateless ─────────────────────
 *
 * Because rotation without state is theatre. The refresh token is opaque and
 * random; what makes it safer than a long-lived token is that presenting it
 * *twice* is detectable — and detecting that needs somewhere to record that the
 * first presentation happened. `consumedAt` is that record, and `familyId` is
 * what a detection invalidates: every token descended from one sign-in, so a
 * thief and the legitimate holder are cut off together rather than the thief
 * quietly surviving alongside.
 *
 * Only the SHA-256 of the token is stored. It is 256 bits of `randomBytes`, so
 * there is nothing for argon2 to defend against — the reason to hash passwords
 * is that people choose them, and nobody chose this.
 */
@Entity({ name: 'refresh_tokens' })
@Index('idx_refresh_tokens_family', ['familyId'])
@Index('idx_refresh_tokens_account', ['accountId'])
export class RefreshTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity;

  /** One sign-in. Rotation issues a new row in the same family; reuse detection
   *  and logout both act on the family, never on a single row. */
  @Column({ name: 'family_id', type: 'uuid' })
  familyId!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Set when this token is exchanged. A second presentation of a consumed token
   *  is the theft signal. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  /** Set on logout, on reuse detection, and on a password reset. Distinct from
   *  `consumedAt`: consumed means "spent normally", revoked means "this family is
   *  over". */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `FR-6.5` — a single-use, expiring password reset.
 *
 * Keyed by the hash of the token for the same reason refresh tokens are: what
 * lands in the mailbox is a password equivalent, and a table of live ones is a
 * table of live passwords. Rows are kept after use rather than deleted, so a
 * second click on a link that already worked can be answered with "this link has
 * been used" instead of the same message an invented token gets.
 */
@Entity({ name: 'password_resets' })
@Index('idx_password_resets_account', ['accountId'])
export class PasswordResetEntity {
  @PrimaryColumn({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
