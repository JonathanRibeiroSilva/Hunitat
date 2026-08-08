/**
 * `DC-10.3 Shared Object State`, persisted — `FR-10.16`.
 *
 * ── Why the state is not in the Map Document ────────────────────────────────
 *
 * The Phase 10 Rules draw the line and the whole phase turns on it:
 * **configuration versions with the map; content does not.** That a whiteboard
 * is a whiteboard, how close you stand to it and whether it is shared are the
 * `interactive` block on a placed object, and phase 9 versions them. What people
 * drew on it is here — because reverting a map to last Tuesday must not silently
 * erase Wednesday's workshop.
 *
 * ── Why `bytea` and not a readable structure ────────────────────────────────
 *
 * The column holds `Y.encodeStateAsUpdate` output, which is an opaque CRDT
 * update. That is the point: `FR-10.12` (concurrent edits converge) and
 * `FR-10.13` (a late joiner sees current state) are properties of the data
 * structure rather than logic anybody wrote, and the only way to keep them is to
 * store what the structure produces.
 *
 * The cost is sharp edge nº2 in the phase notes and worth knowing before
 * somebody assumes otherwise: **server-side moderation of whiteboard content
 * would require materialising the document.** Possible, not planned. Phase 7
 * moderates people, not strokes.
 */

import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MapEntity } from './map.entities.js';

@Entity({ name: 'object_states' })
@Index('idx_object_states_map', ['mapId'])
export class ObjectStateEntity {
  /**
   * A composite key of the Map and the object within it.
   *
   * Object ids are unique within a document, not across a Space: two rooms can
   * each hold a `whiteboard-1`, and a key of the object alone would merge two
   * teams' work onto one surface.
   */
  @PrimaryColumn({ name: 'map_id', type: 'uuid' })
  mapId!: string;

  @PrimaryColumn({ name: 'object_id', type: 'varchar', length: 64 })
  objectId!: string;

  @ManyToOne(() => MapEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'map_id' })
  map?: MapEntity;

  /** `Y.encodeStateAsUpdate`. Opaque by design — see the header. */
  @Column({ type: 'bytea' })
  state!: Buffer;

  /** What it is, so a reader can tell a whiteboard from a note without decoding
   *  the CRDT. Diagnostic only; nothing branches on it. */
  @Column({ name: 'content_type', type: 'varchar', length: 16 })
  contentType!: string;

  @Column({ type: 'int', default: 0 })
  bytes!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
