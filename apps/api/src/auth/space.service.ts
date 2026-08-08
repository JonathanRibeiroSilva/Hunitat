/**
 * The Space this world instance belongs to — `FR-6.8`, `FR-6.13`.
 *
 * Phase 6 has exactly one, and phase 8 is where that stops being true. What this
 * service exists to keep straight until then is the difference between "there is
 * no Space" and "there is a Space that admits everybody", which look identical
 * from a call site that just reads a boolean:
 *
 *   no database   → accounts are unavailable, everybody is a guest, and guests
 *                   are allowed because refusing them would leave nobody able to
 *                   enter at all.
 *   Space present → `allow_guests` decides, and the database is authoritative.
 *
 * The row is created by the migration, not here. Seeding at boot would make "the
 * Space exists" a runtime condition that some path could reach before it holds;
 * seeding in the migration makes it a property of the schema.
 */

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import { SpaceEntity } from './auth.entities.js';

@Injectable()
export class SpaceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SpaceService.name);
  private readonly config: RuntimeConfig = loadConfig();
  private readonly spaces: Repository<SpaceEntity> | null;

  /**
   * The row, cached after the first read.
   *
   * Cached because it is consulted on every join and every guest check, and
   * because it changes roughly never — `allowGuests` flips when an operator
   * decides it does. `setAllowGuests` writes through, so the cache cannot go
   * stale within a process; across processes it would, which is a phase 8
   * problem the moment there is more than one.
   */
  private cached: SpaceEntity | null = null;

  constructor(@Inject(DATA_SOURCE) dataSource: DataSource | null) {
    this.spaces = dataSource ? dataSource.getRepository(SpaceEntity) : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.spaces) {
      this.logger.log(
        'No database — running without a Space. Everybody joins as a guest (FR-6.6) and ' +
          'nothing about them is retained.',
      );
      return;
    }

    const space = await this.load();
    if (!space) {
      this.logger.error(
        `No Space with slug "${this.config.spaceSlug}" exists. The accounts migration seeds ` +
          `"default"; set SPACE_SLUG to match, or create the row.`,
      );
      return;
    }

    // Name is reconciled from configuration, `allow_guests` deliberately is not:
    // the API can change the policy, and a restart that reverted it to an
    // environment default would undo a decision somebody made on purpose.
    if (space.name !== this.config.spaceName && this.config.spaceName) {
      await this.spaces.update({ id: space.id }, { name: this.config.spaceName });
      space.name = this.config.spaceName;
    }

    this.logger.log(
      `Space "${space.slug}" (${space.name}) — guests are ${space.allowGuests ? 'allowed' : 'not allowed'} (FR-6.8).`,
    );
  }

  /** Whether accounts can exist at all. False is a supported state, not a
   *  failure — see the header. */
  get enabled(): boolean {
    return this.spaces !== null;
  }

  /** Null when there is no database. Callers must treat that as "guest-only",
   *  never as an error. */
  async current(): Promise<SpaceEntity | null> {
    if (this.cached) return this.cached;
    return this.load();
  }

  /**
   * `FR-6.8` — may somebody without an account enter?
   *
   * True when there is no database, because a server with no accounts and no
   * guests is a server nobody can use. That is the honest reading of the
   * requirement: a Space *can* require accounts, and one that cannot have any is
   * not that Space.
   */
  async allowsGuests(): Promise<boolean> {
    const space = await this.current();
    return space ? space.allowGuests : true;
  }

  async setAllowGuests(allow: boolean): Promise<void> {
    const space = await this.current();
    if (!space || !this.spaces) return;
    await this.spaces.update({ id: space.id }, { allowGuests: allow });
    space.allowGuests = allow;
    this.cached = space;
  }

  private async load(): Promise<SpaceEntity | null> {
    if (!this.spaces) return null;
    const space = await this.spaces.findOne({ where: { slug: this.config.spaceSlug } });
    this.cached = space;
    return space;
  }
}
