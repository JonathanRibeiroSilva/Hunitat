/**
 * `FR-10.16` — shared state that endures.
 *
 * ── Compaction is not optional ──────────────────────────────────────────────
 *
 * Sharp edge nº1 in the phase notes, and worth restating because it does not fix
 * itself: a CRDT retains history, so a whiteboard that has been drawn on for six
 * months has a snapshot containing every stroke ever *and* every stroke ever
 * deleted. Loading it gets slower and the row gets larger, and nothing about the
 * data structure will ever shrink it.
 *
 * So past `YJS_COMPACT_ABOVE_BYTES` the document is re-encoded into a fresh one
 * before it is written. That discards the history — undo across sessions goes,
 * which nobody expects to survive a week anyway — and keeps the content.
 *
 * ── Absence is a supported state ────────────────────────────────────────────
 *
 * With no database, shared objects still work: two people draw on a whiteboard
 * together and it converges, exactly as `FR-10.11`–`FR-10.14` require. What is
 * lost is `FR-10.16`, and it is lost *loudly* — the boot log says so, rather
 * than a workshop being discovered missing on Monday.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { YJS_COMPACT_ABOVE_BYTES, YJS_PERSIST_DEBOUNCE_MS } from '@hubitat/protocol';
import * as Y from 'yjs';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { ObjectStateEntity } from './object-state.entities.js';

@Injectable()
export class ObjectStateService {
  private readonly logger = new Logger(ObjectStateService.name);
  private readonly states: Repository<ObjectStateEntity> | null;

  constructor(@Inject(DATA_SOURCE) dataSource: DataSource | null) {
    this.states = dataSource ? dataSource.getRepository(ObjectStateEntity) : null;
    if (!this.states) {
      this.logger.warn(
        'No database — shared objects work but nothing is kept. A whiteboard converges while ' +
          'people are on it and is gone when the last one leaves (FR-10.16 needs a database).',
      );
    }
  }

  get enabled(): boolean {
    return this.states !== null;
  }

  get debounceMs(): number {
    return YJS_PERSIST_DEBOUNCE_MS;
  }

  /** The stored snapshot, or null for an object nobody has used yet. */
  async load(mapId: string, objectId: string): Promise<Uint8Array | null> {
    if (!this.states) return null;
    const row = await this.states.findOne({ where: { mapId, objectId } });
    return row ? new Uint8Array(row.state) : null;
  }

  /**
   * Write the whole document, compacting first when it has grown past the
   * ceiling.
   *
   * The whole document rather than an incremental update: `object_states` is a
   * snapshot, not a log, so a reader never has to replay anything and a partial
   * write can never produce a document that is half of two versions.
   */
  async save(mapId: string, objectId: string, contentType: string, doc: Y.Doc): Promise<void> {
    if (!this.states) return;

    let update = Y.encodeStateAsUpdate(doc);

    if (update.byteLength > YJS_COMPACT_ABOVE_BYTES) {
      // Re-encoding through a fresh document discards the history and keeps the
      // content — see the header for why this is necessary rather than tidy.
      const compacted = new Y.Doc();
      Y.applyUpdate(compacted, update);
      const rewritten = Y.encodeStateAsUpdate(compacted);
      compacted.destroy();

      if (rewritten.byteLength < update.byteLength) {
        this.logger.log(
          `Compacted ${mapId}:${objectId} from ${(update.byteLength / 1024).toFixed(0)} KB to ` +
            `${(rewritten.byteLength / 1024).toFixed(0)} KB.`,
        );
        update = rewritten;
      }
    }

    const state = Buffer.from(update);
    // `orUpdate` rather than a read-then-write: two flushes racing on one object
    // would otherwise be a lost update, and the composite key is exactly what
    // Postgres needs to resolve it.
    await this.states
      .createQueryBuilder()
      .insert()
      .values({ mapId, objectId, state, contentType, bytes: state.byteLength })
      .orUpdate(['state', 'content_type', 'bytes', 'updated_at'], ['map_id', 'object_id'])
      .execute();
  }

  /** Every stored object in one Map, for the management view and for knowing
   *  what a delete would take with it. */
  async listForMap(
    mapId: string,
  ): Promise<{ objectId: string; bytes: number; updatedAt: string }[]> {
    if (!this.states) return [];
    const rows = await this.states.find({ where: { mapId }, order: { updatedAt: 'DESC' } });
    return rows.map((row) => ({
      objectId: row.objectId,
      bytes: row.bytes,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
