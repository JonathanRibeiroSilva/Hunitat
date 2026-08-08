/**
 * The map editor and the asset library — `DC-9.3`, `DC-9.4`, and the draft half
 * of `DC-9.1`.
 *
 * The fifth migration, and the first one whose loss would destroy work somebody
 * *made*. Everything before it holds records of what happened; this holds
 * unpublished rooms and the library they are built from.
 *
 * ── Drafts are columns, versions are rows ───────────────────────────────────
 *
 * `map_versions` already exists from phase 8 and stays immutable: one row per
 * published version, which is `FR-9.19`'s "retained so an author can review and
 * revert". The **draft** is columns on `maps`, because an author saves every few
 * seconds and a version per save would fill the history with keystrokes — the
 * list `FR-9.19` asks somebody to read would be unreadable within an afternoon.
 *
 * The consequence is the property `FR-9.4` asks for: participants read
 * `maps.current_version_id`, and no amount of editing touches it.
 *
 * ── No foreign key from a Map to an Asset ───────────────────────────────────
 *
 * There cannot be one: a Map references an asset from inside a `jsonb`
 * document. So `FR-9.14`'s "removed (with safeguards if in use)" is an explicit
 * containment query, and the GIN index phase 8 created for the portal scan is
 * what keeps it from being a full scan of every version ever published.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Editor1758000000000 implements MigrationInterface {
  name = 'Editor1758000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── The draft, and the two locks that protect it ─────────────────────────
    //
    // Every column is nullable and every default is the phase 8 behaviour, so a
    // Map that existed before this migration keeps working exactly as it did:
    // no draft, no lock, published version unchanged.
    await queryRunner.query(`
      ALTER TABLE "maps"
        ADD COLUMN IF NOT EXISTS "draft_document"   JSONB       NULL,
        ADD COLUMN IF NOT EXISTS "draft_revision"   INT         NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "draft_updated_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "draft_updated_by" VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS "locked_by"        UUID        NULL,
        ADD COLUMN IF NOT EXISTS "locked_by_name"   VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS "lock_expires_at"  TIMESTAMPTZ NULL
    `);

    // ── DC-9.3 Asset · DC-9.4 Asset Library ──────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assets" (
        "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "space_id"      UUID         NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "kind"          VARCHAR(16)  NOT NULL,
        "name"          VARCHAR(120) NOT NULL,
        "slug"          VARCHAR(140) NOT NULL,
        "status"        VARCHAR(16)  NOT NULL DEFAULT 'pending',
        "storage_key"   TEXT         NOT NULL,
        "content_type"  VARCHAR(128) NOT NULL,
        "bytes"         BIGINT       NOT NULL DEFAULT 0,
        "triangles"     INT          NOT NULL DEFAULT 0,
        "error"         TEXT         NULL,
        "lods"          JSONB        NOT NULL DEFAULT '[]'::jsonb,
        "thumbnail_key" TEXT         NULL,
        "built_in"      BOOLEAN      NOT NULL DEFAULT FALSE,
        "created_by"    UUID         NULL,
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_assets_space_slug" UNIQUE ("space_id", "slug")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assets_space" ON "assets" ("space_id")
    `);

    // Same shape and same purpose as the `maps` constraints phase 8 wrote: a
    // value outside the enum is a bad write, not a state, and the constraint is
    // what lets the service read the column straight back into a union type.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "assets"
          ADD CONSTRAINT "chk_assets_kind"
          CHECK ("kind" IN ('model', 'texture', 'thumbnail'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "assets"
          ADD CONSTRAINT "chk_assets_status"
          CHECK ("status" IN ('pending', 'processing', 'ready', 'rejected'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // A rejected asset without a reason is `FR-9.12` unmet — "rejected with a
    // clear reason" — and the one place that can be guaranteed rather than
    // remembered is here.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "assets"
          ADD CONSTRAINT "chk_assets_rejection_has_reason"
          CHECK ("status" <> 'rejected' OR "error" IS NOT NULL);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    /**
     * `FR-9.14` — "in use" as a query.
     *
     * The draft has to be scanned as well as the published versions: an asset
     * placed in a draft and then deleted from the library would leave the author
     * with a room that fails to publish, which is the same broken outcome
     * `FR-9.14` blocks for a published Map. The GIN index phase 8 created covers
     * `map_versions`; this one covers the draft.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_maps_draft_document"
        ON "maps" USING GIN ("draft_document" jsonb_path_ops)
    `);
  }

  /**
   * Reversible, and it drops real work.
   *
   * Every unpublished draft and the whole asset library go with it. Nothing in
   * the running server calls this; it exists because a migration that cannot be
   * undone is one somebody is afraid to apply.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_maps_draft_document"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "assets"`);
    await queryRunner.query(`
      ALTER TABLE "maps"
        DROP COLUMN IF EXISTS "draft_document",
        DROP COLUMN IF EXISTS "draft_revision",
        DROP COLUMN IF EXISTS "draft_updated_at",
        DROP COLUMN IF EXISTS "draft_updated_by",
        DROP COLUMN IF EXISTS "locked_by",
        DROP COLUMN IF EXISTS "locked_by_name",
        DROP COLUMN IF EXISTS "lock_expires_at"
    `);
  }
}
