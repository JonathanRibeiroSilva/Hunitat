/**
 * `DC-7.5 Block` — `FR-7.16`, `FR-7.18`.
 *
 * ── Durability falls out of phase 6 rather than being implemented ────────────
 *
 * `FR-7.18` asks for blocks that are "personal and durable for the blocker's
 * identity (persists across sessions for accounts)". Both halves of that are
 * already true of the phase 6 identity string: `acct:<id>` outlives every
 * session, `guest:<session>` does not. So the table keys on it and there is no
 * separate durability mechanism to get wrong — an account's blocks come back
 * because the key comes back, and a guest's do not because it does not.
 *
 * ── Why there is a cache ────────────────────────────────────────────────────
 *
 * `resolveAudience` is called for every listener on every tick, and it consults
 * the block set inside the loop. A database read there would put a query on the
 * 50 ms tick budget (`NFR-7`) several hundred times a second.
 *
 * So a participant's block set is loaded **once, at join**, into memory, and
 * invalidated when they change it. Blocks are per-identity and only the identity
 * itself can change them, so there is exactly one writer per cache entry and no
 * invalidation race to reason about. With no database the cache is the whole
 * implementation, which is the honest behaviour for that configuration: a block
 * still works for as long as the session it was made in lasts.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { BlockEntity } from './moderation.entities.js';

@Injectable()
export class BlockService {
  private readonly logger = new Logger(BlockService.name);
  private readonly blocks: Repository<BlockEntity> | null;

  /**
   * blocker identity → the identities they have blocked.
   *
   * Populated on join and dropped when the last session for that identity
   * leaves. Keyed by *identity* rather than by session so an account with two
   * tabs open has one entry, and blocking somebody in one tab silences them in
   * both.
   */
  private readonly cache = new Map<string, Set<string>>();

  constructor(@Inject(DATA_SOURCE) dataSource: DataSource | null) {
    this.blocks = dataSource ? dataSource.getRepository(BlockEntity) : null;
  }

  /**
   * Load one identity's blocks into memory. Called at join, before the first
   * tick that could deliver anything.
   *
   * Idempotent, and it re-reads rather than returning early on a cache hit: a
   * second tab joining is the moment a stale entry from a previous session would
   * otherwise become permanent for the life of the process.
   */
  async load(identity: string): Promise<void> {
    if (!this.blocks) {
      // With no database there is nothing to load, but the entry must exist:
      // an absent key and an empty set are the same answer to `blockedBy`, and
      // an in-memory block added later needs somewhere to go.
      if (!this.cache.has(identity)) this.cache.set(identity, new Set());
      return;
    }

    try {
      const rows = await this.blocks.find({ where: { blockerIdentity: identity } });
      this.cache.set(identity, new Set(rows.map((row) => row.blockedIdentity)));
    } catch (error) {
      this.logger.warn(`Could not load blocks for ${identity}: ${(error as Error).message}`);
      if (!this.cache.has(identity)) this.cache.set(identity, new Set());
    }
  }

  /** Drop an identity's entry once nobody is acting under it any more. */
  release(identity: string): void {
    this.cache.delete(identity);
  }

  /** The identities this one has blocked. Empty rather than undefined for an
   *  identity nobody has loaded, so callers never have to distinguish "no blocks"
   *  from "not here". */
  blockedBy(identity: string): ReadonlySet<string> {
    return this.cache.get(identity) ?? EMPTY;
  }

  /**
   * The symmetric question, in identity terms.
   *
   * The audience path asks it through `symmetricBlocks` in `world-core`, which
   * works in session ids. Chat asks it here, in identities, because a room
   * message's recipients are participants and the answer must not depend on
   * which of them reconnected most recently.
   */
  isBlockedEitherWay(a: string, b: string): boolean {
    return this.blockedBy(a).has(b) || this.blockedBy(b).has(a);
  }

  /**
   * `FR-7.16` — block or unblock, durably where the blocker is durable.
   *
   * The in-memory set is updated **first**, and that ordering is the requirement:
   * `FR-7.16` says the blocker stops receiving media and chat, and the next tick
   * is 50 ms away. Waiting for a write to land before the silence starts would
   * mean a block that takes a database round trip to take effect, which is the
   * one moment somebody is watching for it to.
   *
   * A failed write therefore degrades to a session-scoped block rather than to no
   * block at all. That is the right way round: the person asked not to hear
   * somebody, and the worst acceptable outcome is that they have to ask again
   * next time.
   */
  async set(
    blockerIdentity: string,
    blockedIdentity: string,
    blockedName: string,
    blocked: boolean,
  ): Promise<void> {
    if (blockerIdentity === blockedIdentity) return;

    const set = this.cache.get(blockerIdentity) ?? new Set<string>();
    if (blocked) set.add(blockedIdentity);
    else set.delete(blockedIdentity);
    this.cache.set(blockerIdentity, set);

    if (!this.blocks) return;

    try {
      if (blocked) {
        // `orIgnore` rather than a check first: blocking somebody twice is a
        // double-click, not a conflict, and it must not surface as an error.
        await this.blocks
          .createQueryBuilder()
          .insert()
          .values({ blockerIdentity, blockedIdentity, blockedName })
          .orIgnore()
          .execute();
      } else {
        await this.blocks.delete({ blockerIdentity, blockedIdentity });
      }
    } catch (error) {
      this.logger.warn(
        `Block ${blocked ? 'add' : 'remove'} for ${blockerIdentity} did not persist: ` +
          `${(error as Error).message}. It applies to this session.`,
      );
    }
  }

  /** What somebody has blocked, for a "manage your blocks" list. */
  async list(blockerIdentity: string): Promise<{ identity: string; name: string }[]> {
    if (!this.blocks) {
      return [...this.blockedBy(blockerIdentity)].map((identity) => ({ identity, name: identity }));
    }
    const rows = await this.blocks.find({
      where: { blockerIdentity },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => ({ identity: row.blockedIdentity, name: row.blockedName }));
  }
}

const EMPTY: ReadonlySet<string> = new Set();
