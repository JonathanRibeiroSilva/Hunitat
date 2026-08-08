/**
 * `DC-7.4 Access Policy` and `DC-7.3 Ban` at the door — `FR-7.8`, `FR-7.11`–`FR-7.15`.
 *
 * Everything that decides **whether somebody may enter**, in one function, so
 * there is one order and one set of messages rather than five checks scattered
 * through a handshake.
 *
 * ── The split with `authenticate` ───────────────────────────────────────────
 *
 * The gateway resolves *who somebody is* first (phase 6: a token, or a guest, or
 * a refusal) and asks this second. The two are genuinely different questions and
 * conflating them produces the wrong message: `guests-not-allowed` is about
 * identity — "this Space requires an account" — and everything here is about
 * policy applied to an identity that has already been established.
 *
 * ── Order, and why it is this order ─────────────────────────────────────────
 *
 *   1. **Ban.** Unconditional, first, and it runs on the resume path too. The
 *      Phase 7 notes name this as a sharp edge: a banned identity presenting a
 *      valid resume token must be refused, and a ban check that lives only in
 *      the fresh-join branch is a ban that lasts until the target's client
 *      reconnects.
 *   2. **Lock**, 3. **password**, 4. **allowlist**, 5. **capacity** — cheapest
 *      and most absolute first. A locked Space should not spend 50 ms of argon2
 *      verifying a password before saying it is closed, and somebody who is not
 *      on the allowlist should not be told the Space is full instead.
 *
 * ── Moderators are not locked out of their own Space ────────────────────────
 *
 * A holder of `manage-access` passes 2–5. This is a deliberate exception and not
 * an oversight: every one of those controls can be switched on from inside the
 * world, and without it an admin who locks a Space and then loses their
 * connection has no way back in to unlock it. The ban check has no such
 * exception, because an admin who has been banned was banned by somebody who
 * outranked them.
 *
 * Capacity is included in the exception, so a full Space can still be moderated.
 * The cost is that the ceiling is soft by the number of moderators, which is a
 * handful against `DEFAULT_MAP_CAPACITY`; the alternative is a Space that becomes
 * ungovernable exactly when it is busiest.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TUNING,
  hasCapability,
  type AccessPolicyDto,
  type AccessPolicyUpdate,
  type BanDto,
  type Role,
} from '@hubitat/protocol';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { PasswordService } from '../auth/password.service.js';
import { SpaceService } from '../auth/space.service.js';
import { SpaceEntity } from '../auth/auth.entities.js';
import { AllowlistEntity, BanEntity } from './moderation.entities.js';

/** The refusal codes on the wire, and the sentence each one carries. */
export interface EntryRefusal {
  code:
    | 'banned'
    | 'space-locked'
    | 'password-required'
    | 'password-incorrect'
    | 'not-allowlisted'
    | 'world-full';
  message: string;
}

export interface EntryRequest {
  /** Null for a guest. */
  accountId: string | null;
  /** The account's address, for the allowlist. Null for a guest, who can never
   *  be on one — an allowlist names identities, and a guest has none. */
  email: string | null;
  role: Role;
  /** Weak, and only used for a guest ban. See `JOIN.clientFingerprint`. */
  fingerprint: string | null;
  ip: string | null;
  /** `FR-7.12`, when the client has one to offer. */
  password: string | null;
  /** How many participants are already connected, for `FR-7.14`. */
  occupancy: number;
  /**
   * True when this is a reconnect inside the resume window rather than a new
   * arrival.
   *
   * Only capacity treats it differently: the participant is already counted in
   * `occupancy` and is already retained, so refusing them for being one over
   * would evict somebody for a dropped packet. Every other check applies
   * unchanged — a ban issued while they were away is the whole point of running
   * this on the resume path.
   */
  resuming: boolean;
}

/** A live ban, as the join path needs it. */
interface ActiveBan {
  reason: string | null;
  expiresAt: Date | null;
}

@Injectable()
export class AccessPolicyService {
  private readonly logger = new Logger(AccessPolicyService.name);
  private readonly config: RuntimeConfig = loadConfig();

  private readonly bans: Repository<BanEntity> | null;
  private readonly allowlist: Repository<AllowlistEntity> | null;
  private readonly spaceRows: Repository<SpaceEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly spaces: SpaceService,
    private readonly passwords: PasswordService,
  ) {
    this.bans = dataSource ? dataSource.getRepository(BanEntity) : null;
    this.allowlist = dataSource ? dataSource.getRepository(AllowlistEntity) : null;
    this.spaceRows = dataSource ? dataSource.getRepository(SpaceEntity) : null;
  }

  /** With no database there is no policy to enforce and no bans to check, which
   *  is the same answer phase 6 gives: everybody is a guest and everybody
   *  enters. */
  get enabled(): boolean {
    return this.bans !== null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The door
  // ───────────────────────────────────────────────────────────────────────────

  /** `FR-7.15` — "access-control changes apply to new entries immediately".
   *  Evaluated per join against the current row, never cached beyond the Space
   *  itself, which `SpaceService` writes through. */
  async evaluate(request: EntryRequest): Promise<EntryRefusal | null> {
    if (!this.enabled) return null;

    const space = await this.spaces.current();
    if (!space) return null;

    // ── 1. Ban (FR-7.8) ─────────────────────────────────────────────────────
    const ban = await this.banFor(space.id, request);
    if (ban) return { code: 'banned', message: banMessage(ban) };

    // Moderators pass everything below — see the file header.
    if (hasCapability(request.role, 'manage-access')) return null;

    // ── 2. Lock (FR-7.11) ───────────────────────────────────────────────────
    if (space.locked) {
      return {
        code: 'space-locked',
        message:
          'This space is closed to new arrivals right now. Ask whoever runs it to unlock it.',
      };
    }

    // ── 3. Password (FR-7.12) ───────────────────────────────────────────────
    if (space.accessPasswordHash) {
      if (!request.password) {
        return { code: 'password-required', message: 'This space needs a password to enter.' };
      }
      const ok = await this.passwords.verify(space.accessPasswordHash, request.password);
      if (!ok) {
        return {
          code: 'password-incorrect',
          message: 'That is not the password for this space.',
        };
      }
    }

    // ── 4. Allowlist (FR-7.13) ──────────────────────────────────────────────
    //
    // Checked against the *account's* address. A guest has none and is therefore
    // never on the list, which is the honest reading of "only specified
    // identities may enter": a guest is not a specified identity, and an
    // allowlisted Space that admitted anonymous visitors would not be one.
    if (space.allowlistEnabled) {
      const listed = request.email
        ? await this.allowlist!.findOne({ where: { spaceId: space.id, email: request.email } })
        : null;
      if (!listed) {
        return {
          code: 'not-allowlisted',
          message: request.email
            ? 'This space is limited to invited people, and your account is not on the list.'
            : 'This space is limited to invited people. Sign in with an account that has access.',
        };
      }
    }

    // ── 5. Capacity (FR-7.14) ───────────────────────────────────────────────
    //
    // `FR-7.14` allows "refused **or** routed to overflow", and the Phase 7 Rules
    // require that choice to agree with `FR-8.8` rather than be made twice.
    // There is one instance until phase 8 builds more, so refusing is the only
    // one of the two this build can honestly implement — and the message says
    // capacity rather than sounding like a fault, so it does not read as the
    // server being broken.
    if (!request.resuming) {
      // The Space's own value when it has one, `DEFAULT_MAP_CAPACITY` otherwise
      // — read through configuration rather than from the shared constant, so
      // `NFR-39` holds: no rebuild to change any value in tuning-defaults.
      const capacity = space.capacity ?? this.config.defaultMapCapacity;
      if (request.occupancy >= capacity) {
        return {
          code: 'world-full',
          message: `This space is full (${capacity} people). Try again in a few minutes.`,
        };
      }
    }

    return null;
  }

  /**
   * The active ban for this arrival, or null.
   *
   * ── Account bans are exact. Guest bans are not, and say so ──────────────────
   *
   * An account ban keys on `account_id`: one row, one person, and it survives
   * every browser and every network.
   *
   * A guest ban matches on **fingerprint or address**, which is what the Phase 7
   * notes describe and what the Rules mean by "available identifying signals,
   * with known limitations documented". The limitations, in full:
   *
   *   - clearing site data changes the fingerprint and defeats it;
   *   - a different browser has a different fingerprint and defeats it;
   *   - matching on the address alone catches everybody behind the same NAT,
   *     which in an office is a floor of colleagues.
   *
   * All three are surfaced to the admin at the moment they ban a guest, because
   * the real remedy is `FR-6.8` — requiring accounts — and that is one checkbox
   * away in the same panel.
   */
  private async banFor(spaceId: string, request: EntryRequest): Promise<ActiveBan | null> {
    const now = new Date();

    if (request.accountId) {
      const rows = await this.bans!.query<{ reason: string | null; expires_at: Date | null }[]>(
        `SELECT "reason", "expires_at" FROM "bans"
          WHERE "space_id" = $1 AND "kind" = 'account' AND "account_id" = $2
            AND "lifted_at" IS NULL
            AND ("expires_at" IS NULL OR "expires_at" > $3)
          ORDER BY "expires_at" IS NULL DESC, "expires_at" DESC
          LIMIT 1`,
        [spaceId, request.accountId, now],
      );
      const row = rows[0];
      return row ? { reason: row.reason, expiresAt: row.expires_at } : null;
    }

    if (!request.fingerprint && !request.ip) return null;

    const rows = await this.bans!.query<{ reason: string | null; expires_at: Date | null }[]>(
      `SELECT "reason", "expires_at" FROM "bans"
        WHERE "space_id" = $1 AND "kind" = 'guest'
          AND "lifted_at" IS NULL
          AND ("expires_at" IS NULL OR "expires_at" > $2)
          AND (
            ($3::text IS NOT NULL AND "fingerprint" = $3)
            OR ($4::text IS NOT NULL AND "ip" = $4)
          )
        ORDER BY "expires_at" IS NULL DESC, "expires_at" DESC
        LIMIT 1`,
      [spaceId, now, request.fingerprint, request.ip],
    );
    const row = rows[0];
    return row ? { reason: row.reason, expiresAt: row.expires_at } : null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bans as records — FR-7.8
  // ───────────────────────────────────────────────────────────────────────────

  async ban(input: {
    accountId: string | null;
    fingerprint: string | null;
    ip: string | null;
    displayName: string;
    reason?: string;
    durationMinutes?: number;
    createdBy: string;
    createdByName: string;
  }): Promise<BanEntity | null> {
    if (!this.bans) return null;
    const space = await this.spaces.current();
    if (!space) return null;

    const kind = input.accountId ? 'account' : 'guest';
    if (kind === 'guest' && !input.fingerprint && !input.ip) {
      // Nothing to key on. Refusing to write the row is better than writing one
      // that can never match: a ban list containing an entry that does nothing
      // is worse than an admin being told it could not be done.
      this.logger.warn(
        `Refusing to ban guest "${input.displayName}": no fingerprint and no address to key on.`,
      );
      return null;
    }

    const row = await this.bans.save(
      this.bans.create({
        spaceId: space.id,
        kind,
        accountId: input.accountId,
        fingerprint: kind === 'guest' ? input.fingerprint : null,
        // Recorded on an account ban as evidence, never matched on — see
        // `banFor`. Matching it would ban a meeting room.
        ip: input.ip,
        displayName: input.displayName.slice(0, 64),
        reason: input.reason?.trim() || null,
        createdBy: input.createdBy,
        createdByName: input.createdByName.slice(0, 64),
        expiresAt: input.durationMinutes
          ? new Date(Date.now() + input.durationMinutes * 60_000)
          : null,
        liftedAt: null,
      }),
    );

    this.logger.log(
      `${input.createdByName} banned ${input.displayName} (${kind}) ` +
        `${row.expiresAt ? `until ${row.expiresAt.toISOString()}` : 'permanently'}.`,
    );
    return row;
  }

  /** Lift, without deleting. The row is the record `FR-7.20` asks to be able to
   *  trust, and a ban that was issued and quietly removed is exactly what an
   *  audit trail exists to make visible. */
  async lift(id: string): Promise<BanEntity | null> {
    if (!this.bans) return null;
    const space = await this.spaces.current();
    if (!space) return null;

    const row = await this.bans.findOne({ where: { id, spaceId: space.id } });
    if (!row || row.liftedAt !== null) return null;

    await this.bans.update({ id }, { liftedAt: new Date() });
    row.liftedAt = new Date();
    return row;
  }

  /** Every ban, live ones first. Expired and lifted rows stay in the list — "why
   *  can this person get in again" is a question the list should answer. */
  async listBans(): Promise<BanDto[]> {
    if (!this.bans) return [];
    const space = await this.spaces.current();
    if (!space) return [];

    const rows = await this.bans.find({
      where: { spaceId: space.id },
      order: { createdAt: 'DESC' },
      take: TUNING.MODERATION_PAGE_SIZE,
    });

    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      displayName: row.displayName,
      kind: row.kind,
      reason: row.reason,
      createdBy: row.createdByName,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      liftedAt: row.liftedAt?.toISOString() ?? null,
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The policy itself — FR-7.11 to FR-7.15
  // ───────────────────────────────────────────────────────────────────────────

  async describe(): Promise<AccessPolicyDto> {
    const space = await this.spaces.current();
    const emails = space && this.allowlist ? await this.listAllowlist(space.id) : [];

    return {
      locked: space?.locked ?? false,
      // The hash never leaves the server. An admin who has forgotten the password
      // sets a new one; nothing hands the old one back.
      passwordSet: Boolean(space?.accessPasswordHash),
      allowlistEnabled: space?.allowlistEnabled ?? false,
      allowlist: emails,
      capacity: space?.capacity ?? null,
      allowGuests: space?.allowGuests ?? true,
    };
  }

  /**
   * `FR-7.15` — a change applies to new entries immediately.
   *
   * Which it does by construction: `evaluate` reads the Space row on every join
   * and `SpaceService` writes through its cache, so there is no interval during
   * which the old policy is still in force. Nobody already inside is affected,
   * which is the requirement — locking a Space is a door, not an eviction, and
   * removing people is `FR-7.7`.
   *
   * Returns what actually changed, for the audit entry. A no-op update writes no
   * audit row, because "changed the access policy" with nothing after it is a
   * line that makes a log harder to read rather than easier.
   */
  async update(patch: AccessPolicyUpdate): Promise<Record<string, unknown>> {
    if (!this.spaceRows) return {};
    const space = await this.spaces.current();
    if (!space) return {};

    const changed: Record<string, unknown> = {};
    const fields: Partial<SpaceEntity> = {};

    if (patch.locked !== undefined && patch.locked !== space.locked) {
      fields.locked = patch.locked;
      changed.locked = patch.locked;
    }
    if (patch.allowlistEnabled !== undefined && patch.allowlistEnabled !== space.allowlistEnabled) {
      fields.allowlistEnabled = patch.allowlistEnabled;
      changed.allowlistEnabled = patch.allowlistEnabled;
    }
    if (patch.capacity !== undefined && patch.capacity !== space.capacity) {
      fields.capacity = patch.capacity;
      changed.capacity = patch.capacity;
    }
    if (patch.allowGuests !== undefined && patch.allowGuests !== space.allowGuests) {
      fields.allowGuests = patch.allowGuests;
      changed.allowGuests = patch.allowGuests;
    }
    if (patch.password !== undefined) {
      // The password itself never reaches the audit log or this return value —
      // only that it was set or cleared. A record of who changed a credential is
      // accountability; a record of what they changed it to is a second copy of
      // the credential in a table designed never to be edited.
      fields.accessPasswordHash =
        patch.password === null ? null : await this.passwords.hash(patch.password);
      changed.password = patch.password === null ? 'cleared' : 'set';
    }

    if (Object.keys(fields).length === 0) return {};

    await this.spaceRows.update({ id: space.id }, fields);
    Object.assign(space, fields);
    // `SpaceService` caches the row and is the only reader of `allowGuests` on
    // the join path, so its copy has to be the one that was mutated. Assigning
    // into `space` does that: `current()` returns the cached instance.
    this.logger.log(`Access policy updated: ${JSON.stringify(changed)}`);
    return changed;
  }

  async listAllowlist(spaceId?: string): Promise<string[]> {
    if (!this.allowlist) return [];
    const id = spaceId ?? (await this.spaces.current())?.id;
    if (!id) return [];
    const rows = await this.allowlist.find({ where: { spaceId: id }, order: { email: 'ASC' } });
    return rows.map((row) => row.email);
  }

  /** `FR-7.13`. Idempotent: adding an address twice is a double-click. */
  async addToAllowlist(email: string, addedBy: string): Promise<void> {
    if (!this.allowlist) return;
    const space = await this.spaces.current();
    if (!space) return;

    await this.allowlist
      .createQueryBuilder()
      .insert()
      .values({ spaceId: space.id, email, addedBy: addedBy.slice(0, 64) })
      .orIgnore()
      .execute();
  }

  async removeFromAllowlist(email: string): Promise<void> {
    if (!this.allowlist) return;
    const space = await this.spaces.current();
    if (!space) return;
    await this.allowlist.delete({ spaceId: space.id, email });
  }
}

/**
 * `AC-7.4` — "refuses ineligible entrants with a clear reason".
 *
 * A ban is the one refusal where the message has real work to do: the recovery
 * differs entirely between "until Tuesday" and "not at all", and somebody who is
 * told only "you are banned" has no idea whether to wait or to ask.
 */
function banMessage(ban: ActiveBan): string {
  const until = ban.expiresAt
    ? `until ${ban.expiresAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'from this space';
  const reason = ban.reason ? ` Reason: ${ban.reason}` : '';
  return `You have been banned ${until}.${reason}`;
}
