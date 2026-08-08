/**
 * `DC-10.3 Shared Object State` — `FR-10.16`.
 *
 * The sixth and smallest migration, and the one whose loss is most obviously a
 * person's work: a whiteboard nobody photographed.
 *
 * ── One table, deliberately ─────────────────────────────────────────────────
 *
 * A whiteboard, a set of sticky notes and a shared text document are three
 * surfaces of one mechanism — a CRDT document per object — and three tables
 * would be three copies of the same two columns plus a discriminator nothing
 * reads. `content_type` is here for a human looking at the table, not for a
 * query.
 *
 * ── Cascade from the Map, not from the Space ────────────────────────────────
 *
 * Deleting a Map takes its object states with it, because the objects they
 * belong to went with it too. Nothing else cascades: reverting a Map *version*
 * must not touch this table at all, which is the Rules' "reverting a map version
 * must not silently erase a whiteboard" expressed as an absence.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ObjectStates1759000000000 implements MigrationInterface {
  name = 'ObjectStates1759000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "object_states" (
        "map_id"       UUID        NOT NULL REFERENCES "maps" ("id") ON DELETE CASCADE,
        "object_id"    VARCHAR(64) NOT NULL,
        "state"        BYTEA       NOT NULL,
        "content_type" VARCHAR(16) NOT NULL,
        "bytes"        INT         NOT NULL DEFAULT 0,
        "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("map_id", "object_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_object_states_map" ON "object_states" ("map_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "object_states"`);
  }
}
