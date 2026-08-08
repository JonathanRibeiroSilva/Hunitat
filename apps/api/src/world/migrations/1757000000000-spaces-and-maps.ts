/**
 * Spaces, Maps and Map Versions — `DC-8.1`, `DC-8.2`, and the storage half of
 * `DC-9.1`.
 *
 * The fourth migration. Phase 5's holds scrollback, phase 6's holds who
 * everybody is, phase 7's holds what they may do; this one holds **where they
 * are** — which Maps a Space contains, which one people land on, and the
 * documents those Maps are actually made of.
 *
 * ── Three ALTERs before any CREATE ──────────────────────────────────────────
 *
 * `spaces` gains an owner, a landing Map and an archive flag. All three are
 * nullable and all three default to the phase 7 behaviour, so a database that
 * existed before this migration keeps working unchanged: one Space, owned by
 * nobody in particular, landing on the only Map there is. The reasoning for each
 * is in `auth.entities.ts`.
 *
 * ── No foreign key from `spaces.default_map_id` ─────────────────────────────
 *
 * Deliberate, and the one constraint this migration declines to write. A Map can
 * be deleted (`FR-8.17`), and a Space that could not be *read* because its
 * landing Map had gone would be a Space nobody could enter in order to fix it —
 * `ON DELETE SET NULL` would avoid the crash but would still lose the
 * administrator's choice silently. `MapRegistry` resolves a dangling pointer to
 * the lowest-sorted live Map and says so in the log, which is what `FR-8.7`
 * actually asks for: arriving somewhere sensible, rather than a pointer being
 * intact.
 *
 * ── No seed rows ────────────────────────────────────────────────────────────
 *
 * Unlike phase 6's `spaces` row, which the migration inserts because the schema
 * is not valid without one. A Map row is not like that: it needs a *document*,
 * the documents live on disk beside their GLB, and a migration that hard-coded
 * one would be a second copy of a file the server already reads. `MapRegistry`
 * seeds the catalogue at boot from `assets/world/*.map.json`, idempotently, and
 * from that moment the database is authoritative.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SpacesAndMaps1757000000000 implements MigrationInterface {
  name = 'SpacesAndMaps1757000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── DC-8.1 Space ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "spaces"
        ADD COLUMN IF NOT EXISTS "owner_account_id" UUID        NULL,
        ADD COLUMN IF NOT EXISTS "default_map_id"   UUID        NULL,
        ADD COLUMN IF NOT EXISTS "archived_at"      TIMESTAMPTZ NULL
    `);

    // The owner *is* a real account, and this one gets a foreign key: deleting
    // an account that owns a Space must not leave the Space pointing at a person
    // who no longer exists. SET NULL rather than CASCADE — losing the owner is a
    // problem to solve, and losing the building because its owner closed their
    // account is not a solution.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "spaces"
          ADD CONSTRAINT "fk_spaces_owner"
          FOREIGN KEY ("owner_account_id") REFERENCES "accounts" ("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── DC-8.2 Map ───────────────────────────────────────────────────────────
    //
    // `current_version_id` has no foreign key for the same reason
    // `default_map_id` does not: the versions table cascades from the Map, so a
    // circular constraint pair would make deleting either one a two-statement
    // dance for no gain. The pointer is written by one service and read by one
    // service.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "maps" (
        "id"                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "space_id"           UUID         NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "slug"               VARCHAR(64)  NOT NULL,
        "name"               VARCHAR(128) NOT NULL,
        "capacity"           INT          NULL,
        "instancing"         VARCHAR(24)  NOT NULL DEFAULT 'fill-then-spill',
        "overflow"           VARCHAR(16)  NOT NULL DEFAULT 'instance',
        "current_version_id" UUID         NULL,
        "archived_at"        TIMESTAMPTZ  NULL,
        "sort_index"         INT          NOT NULL DEFAULT 0,
        "created_by"         UUID         NULL,
        "created_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_maps_space_slug" UNIQUE ("space_id", "slug")
      )
    `);

    // `FR-8.3` — "each Map belongs to exactly one Space and can be referenced as
    // a portal destination". The unique above is the first half; a portal names a
    // Map by slug, so two Maps in one Space cannot share one and a cross-map
    // portal has exactly one thing it can mean.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_maps_space" ON "maps" ("space_id")
    `);

    // Same shape as `chk_memberships_role`, and the same purpose: a value
    // outside the enum is a bad write, not a policy, and the constraint is what
    // lets `MapRegistry` read the column straight back into a union type.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "maps"
          ADD CONSTRAINT "chk_maps_instancing"
          CHECK ("instancing" IN ('fill-then-spill', 'least-loaded'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "maps"
          ADD CONSTRAINT "chk_maps_overflow"
          CHECK ("overflow" IN ('instance', 'refuse'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // One is not a capacity, it is a locked door — the same reasoning
    // `DEFAULT_MAP_CAPACITY` is validated against at boot, applied to the value
    // an administrator can set through the API.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "maps"
          ADD CONSTRAINT "chk_maps_capacity"
          CHECK ("capacity" IS NULL OR "capacity" >= 2);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── DC-9.1 Map Document, stored ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "map_versions" (
        "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "map_id"     UUID         NOT NULL REFERENCES "maps" ("id") ON DELETE CASCADE,
        "version"    INT          NOT NULL,
        "document"   JSONB        NOT NULL,
        "created_by" UUID         NULL,
        "notes"      VARCHAR(200) NULL,
        "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "uq_map_versions_map_version" UNIQUE ("map_id", "version")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_map_versions_map" ON "map_versions" ("map_id")
    `);

    /**
     * The index that makes "which portals point at the Map I am deleting"
     * answerable.
     *
     * The Phase 8 Rules require that deleting a Map must not leave dangling
     * portals, and `jsonb` gives no foreign key to lean on — so the check is an
     * explicit containment query over every document in the Space. A GIN index
     * with `jsonb_path_ops` is what keeps that from being a full scan of every
     * map ever authored; it is the price of storing the document as a blob, paid
     * once at write time instead of on every portal traversal.
     */
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_map_versions_document"
        ON "map_versions" USING GIN ("document" jsonb_path_ops)
    `);
  }

  /**
   * Reversible, and it drops real content.
   *
   * `map_versions` holds the only copy of anything phase 9 authored — the
   * documents that shipped on disk can be re-seeded, but an edit made in the
   * editor cannot. Nothing in the running server calls this; it exists because a
   * migration that cannot be undone is one somebody is afraid to apply.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "map_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "maps"`);
    await queryRunner.query(`ALTER TABLE "spaces" DROP CONSTRAINT IF EXISTS "fk_spaces_owner"`);
    await queryRunner.query(`
      ALTER TABLE "spaces"
        DROP COLUMN IF EXISTS "owner_account_id",
        DROP COLUMN IF EXISTS "default_map_id",
        DROP COLUMN IF EXISTS "archived_at"
    `);
  }
}
