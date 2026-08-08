/**
 * `DC-9.3 Asset` and `DC-9.4 Asset Library` — phase 9.
 *
 * ── Metadata here, bytes in object storage ──────────────────────────────────
 *
 * The row is everything that can be queried: what it is called, whether it is
 * usable, how big it is, how many triangles it costs, and where its variants
 * live. The bytes are in MinIO and reach it without passing through `api`
 * (`FR-9.11`, presigned PUT) — a 20 Hz world tick has no business buffering a
 * 40 MB model.
 *
 * ── The status column is the job state ──────────────────────────────────────
 *
 * `DC-9.3` asks for a "validation status", and it is not a separate concept from
 * the pipeline: an upload is finished when the worker has parsed it, decided it
 * is usable and written its level-of-detail variants (`FR-9.13`). So `status`
 * moves pending → processing → ready | rejected, and the editor shows exactly
 * that rather than pretending an asset is usable the moment its bytes land.
 *
 * ── There is no foreign key from a Map to an Asset ──────────────────────────
 *
 * A Map references an asset from inside a `jsonb` document, which Postgres
 * cannot see. So `FR-9.14`'s "removed (with safeguards if in use)" is an
 * explicit scan across `map_versions`, and it is the standing cost of storing
 * the document as a blob (ADR 0008) — the same cost `MapRegistry.portalsTargeting`
 * pays for portals.
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
import type { AssetKind, AssetLodDto, AssetStatus } from '@hubitat/protocol';
import { SpaceEntity } from '../auth/auth.entities.js';

@Entity({ name: 'assets' })
@Index('idx_assets_space', ['spaceId'])
@Unique('uq_assets_space_slug', ['spaceId', 'slug'])
export class AssetEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'space_id', type: 'uuid' })
  spaceId!: string;

  @ManyToOne(() => SpaceEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: SpaceEntity;

  @Column({ type: 'varchar', length: 16 })
  kind!: AssetKind;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /**
   * Stable, unique within the Space, and what a Map Document's `assetId`
   * references.
   *
   * A slug rather than the uuid for the reason a Map's slug is one: a document
   * is read, copied and hand-edited by people, and a uuid in it is an act of
   * copy-paste archaeology. Derived from the name and de-duplicated on write.
   */
  @Column({ type: 'varchar', length: 140 })
  slug!: string;

  /** `DC-9.3` — the validation status, which is the pipeline's job state. */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: AssetStatus;

  /** Where the original upload landed. The variants derive their keys from it. */
  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 128 })
  contentType!: string;

  @Column({ type: 'bigint', default: 0 })
  bytes!: string;

  @Column({ type: 'int', default: 0 })
  triangles!: number;

  /** `FR-9.12` — why it was rejected, specifically. Null unless `rejected`. */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** `FR-9.13` — the simplified variants, written by the worker. `jsonb` because
   *  it is read whole with the row and never queried across assets. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  lods!: AssetLodDto[];

  @Column({ name: 'thumbnail_key', type: 'text', nullable: true })
  thumbnailKey!: string | null;

  /**
   * `FR-9.15` — shipped with the product rather than uploaded.
   *
   * A column rather than a null `created_by`, because the two mean different
   * things and only one of them is a reason to refuse a delete: a built-in is
   * what guarantees a Space can always be built in, and an asset uploaded by
   * somebody who has since closed their account is an ordinary asset.
   */
  @Column({ name: 'built_in', type: 'boolean', default: false })
  builtIn!: boolean;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
