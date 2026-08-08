/**
 * `DC-8.2 Map` and its versions — phase 8.
 *
 * ── Why the Map is a row and the document is a blob ─────────────────────────
 *
 * A Map has two halves and they change for different reasons and at different
 * rates. Its *management* metadata — what it is called, how many people it
 * admits, how it instances, whether it has been archived — is read on every join
 * and every directory refresh, is queried across Maps, and is edited by an
 * administrator a handful of times ever. Its *contents* — geometry, zones,
 * spawns, objects — are read whole, written whole, never queried across Maps,
 * and from phase 9 are edited by whoever is holding the editor open.
 *
 * So the first half is columns on `maps` and the second is `map_versions.
 * document jsonb`, exactly as ADR 0008 and the Phase 8 notes describe. The cost
 * of the blob is that Postgres cannot enforce a foreign key from a portal target
 * to the Map it names — which is why `MapRegistry.brokenPortals` exists and why
 * deleting a Map runs an explicit scan rather than trusting a constraint.
 *
 * ── Why versions at all, in a phase with no editor ──────────────────────────
 *
 * Because phase 9 is the editor and it needs somewhere to put a draft that is
 * not the document the running world is reading. Introducing the table now costs
 * one join on a path that already does several, and introducing it later would
 * mean migrating live worlds off a column. `maps.current_version_id` is what a
 * running instance reads; publishing is moving that pointer.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { InstancingPolicy, MapDocument, OverflowRule } from '@hubitat/protocol';
import { SpaceEntity } from '../auth/auth.entities.js';

/**
 * `DC-8.2 Map (managed unit)`.
 *
 * A Map belongs to exactly one Space (`FR-8.3`) and is addressable as a portal
 * destination. Both facts are the composite unique below: a portal names a Map
 * by slug within a Space, so two Maps in one Space cannot share one, and two
 * Spaces can each have an `atrium` without either of them meaning the other.
 */
@Entity({ name: 'maps' })
@Index('idx_maps_space', ['spaceId'])
@Unique('uq_maps_space_slug', ['spaceId', 'slug'])
export class MapEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  /**
   * Stable, human-readable, and what a portal target names.
   *
   * `portalTargetSchema.mapId` is a free string authored into a Map Document by
   * hand, so it has to be something a person can type and recognise — a uuid
   * would make every cross-map portal an act of copy-paste archaeology. The
   * resolver accepts either this or the uuid, and prefers this.
   */
  @Column({ type: 'varchar', length: 64 })
  slug!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  /**
   * `FR-8.8`, and the middle of three levels.
   *
   * Null means "the Space's capacity", which in turn falls back to
   * `DEFAULT_MAP_CAPACITY`. Three levels rather than two because the two things
   * they express are genuinely different: a Space caps *the deployment* (phase
   * 7, `FR-7.14`), and a Map caps *a room* — a four-person huddle inside a
   * fifty-person office is a normal thing to want and is not a smaller
   * deployment.
   */
  @Column({ type: 'int', nullable: true })
  capacity!: number | null;

  /** `DC-8.4` — `fill-then-spill` keeps colleagues together and is the default;
   *  `least-loaded` spreads arrivals. See `space.ts` for why "follow" is not one
   *  of these. */
  @Column({ type: 'varchar', length: 24, default: 'fill-then-spill' })
  instancing!: InstancingPolicy;

  /** `FR-8.8` — allocate another instance, or refuse. A room whose whole purpose
   *  is that everybody in it is together should refuse rather than silently
   *  split the group in two (`FR-8.10`). */
  @Column({ type: 'varchar', length: 16, default: 'instance' })
  overflow!: OverflowRule;

  /** What a running instance reads — the **published** version (`FR-9.18`). Null
   *  only in the window between creating a Map and writing its first version,
   *  which `MapRegistry` never leaves open. */
  @Column({ name: 'current_version_id', type: 'uuid', nullable: true })
  currentVersionId!: string | null;

  // ── The editor — phase 9 ───────────────────────────────────────────────────
  //
  // Drafts are mutable and live here; versions are immutable and live in
  // `map_versions`. That split is what makes `FR-9.4` — "editing is
  // non-destructive to the live published Map until explicitly published" —
  // structural rather than a rule somebody has to remember: participants read
  // `current_version_id`, and no amount of editing touches it.
  //
  // A column rather than a draft *row* in `map_versions`, deliberately. An
  // author saves every few seconds; a version per save would fill the history
  // with keystrokes and make `FR-9.19`'s "review and revert to a previous
  // version" a list nobody could read.

  /** `FR-9.4` — what is being edited. Null until somebody opens the editor, at
   *  which point it is seeded from the published document so nobody starts from
   *  an empty room they then have to rebuild. */
  @Column({ name: 'draft_document', type: 'jsonb', nullable: true })
  draftDocument!: MapDocument | null;

  /**
   * `FR-9.22`'s guarantee — the optimistic lock.
   *
   * Every save states the revision it was made against and is refused if the
   * draft has moved on. Not a merge: two authors moving the same wall have no
   * correct automatic resolution, and inventing one is how work disappears
   * silently, which is precisely what the requirement rules out.
   */
  @Column({ name: 'draft_revision', type: 'int', default: 0 })
  draftRevision!: number;

  @Column({ name: 'draft_updated_at', type: 'timestamptz', nullable: true })
  draftUpdatedAt!: Date | null;

  @Column({ name: 'draft_updated_by', type: 'varchar', length: 64, nullable: true })
  draftUpdatedBy!: string | null;

  /**
   * `FR-9.22`'s courtesy — the advisory editor lock.
   *
   * Advisory, and the word is load-bearing: the revision check above is what
   * *cannot* be bypassed. This is what stops two authors reaching it, by telling
   * the second one that somebody is already in there.
   *
   * It expires rather than being held, because the failure it guards against is
   * an author who closed their laptop — and a lock that outlived them would need
   * an administrator to clear.
   */
  @Column({ name: 'locked_by', type: 'uuid', nullable: true })
  lockedBy!: string | null;

  @Column({ name: 'locked_by_name', type: 'varchar', length: 64, nullable: true })
  lockedByName!: string | null;

  @Column({ name: 'lock_expires_at', type: 'timestamptz', nullable: true })
  lockExpiresAt!: Date | null;

  /** `FR-8.17` — inaccessible but retained. Set rather than deleted, so the
   *  history written in it, and the portals pointing at it, still resolve to
   *  something explicable. */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  /** Display order in the directory. An explicit column rather than sorting by
   *  name, because "reception first" is a decision somebody makes about their
   *  building and not one alphabetical order happens to get right. */
  @Column({ name: 'sort_index', type: 'int', default: 0 })
  sortIndex!: number;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * `DC-9.1 Map Document`, stored — one row per published version.
 *
 * Immutable by convention rather than by a trigger: nothing in the codebase
 * updates a row here, and publishing an edit inserts a new one and moves
 * `maps.current_version_id`. The audit log's REVOKE treatment would be
 * disproportionate — this is content, not a record of who did what — but the
 * shape is what lets phase 9 offer "revert to the version before that one"
 * without inventing a second store.
 */
@Entity({ name: 'map_versions' })
@Index('idx_map_versions_map', ['mapId'])
@Unique('uq_map_versions_map_version', ['mapId', 'version'])
export class MapVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'map_id', type: 'uuid' })
  mapId!: string;

  @ManyToOne(() => MapEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'map_id' })
  map?: MapEntity;

  /** Monotonic per Map, from 1. Human-facing: "version 4" is a thing somebody
   *  says out loud, and a uuid is not. */
  @Column({ type: 'int' })
  version!: number;

  /**
   * The Map Document (`specs/protocol/map-document.md`), whole.
   *
   * `jsonb` rather than columns per field, and rather than `json`: it is read
   * whole on every instance allocation, and the one query that does look inside
   * it — the scan for portals naming a Map about to be deleted — is a containment
   * test that `jsonb` can answer and `json` cannot.
   */
  @Column({ type: 'jsonb' })
  document!: MapDocument;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
