/**
 * Accounts, spaces, memberships, invites and sessions — `DC-6.1`–`DC-6.6`.
 *
 * The second migration in the project, and the first one that matters to a
 * person: phase 5's tables could be rebuilt from an empty database with nothing
 * lost but chat scrollback. Losing this one loses who everybody is.
 *
 * Hand-written rather than generated, as ADR 0008 chose. Seven tables is more
 * than phase 5's two, and reviewing generated SQL for foreign keys and partial
 * indexes still costs more than writing it.
 *
 * ── The seed row ────────────────────────────────────────────────────────────
 *
 * A `spaces` row is inserted here rather than at boot. Every membership, every
 * invite and every guest check points at a Space, so "the Space exists" cannot
 * be a runtime condition that some code path forgets to establish — the schema
 * is not valid without one. `SpaceService` reconciles the name against
 * `SPACE_SLUG`/`SPACE_NAME` afterwards; `allow_guests` it deliberately leaves
 * alone, because the API can change it and a restart must not revert a policy.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Accounts1755000000000 implements MigrationInterface {
  name = 'Accounts1755000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // `gen_random_uuid()` lives in pgcrypto before PostgreSQL 13 and in core
    // from 13 onward. Compose pins 16, and the extension is created anyway so a
    // hand-rolled deployment on an older server does not fail at the first
    // default.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "spaces" (
        "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "slug"         VARCHAR(64)  NOT NULL UNIQUE,
        "name"         VARCHAR(128) NOT NULL,
        "allow_guests" BOOLEAN      NOT NULL DEFAULT TRUE,
        "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // The one Space phase 6 has. `ON CONFLICT DO NOTHING` so re-running against
    // a database that already has it is a no-op rather than a failed migration.
    await queryRunner.query(`
      INSERT INTO "spaces" ("slug", "name", "allow_guests")
      VALUES ('default', 'hubitat', TRUE)
      ON CONFLICT ("slug") DO NOTHING
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "accounts" (
        "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "email"         VARCHAR(320) NOT NULL UNIQUE,
        "password_hash" TEXT         NOT NULL,
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "profiles" (
        "account_id"        UUID        PRIMARY KEY
          REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "display_name"      VARCHAR(64) NOT NULL,
        "avatar_appearance" JSONB       NOT NULL,
        "status_preference" VARCHAR(16) NOT NULL DEFAULT 'available',
        "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // FR-6.15, FR-6.16 — the composite key IS the "recognised without
    // re-invitation" guarantee, and the reason redeeming an invite twice cannot
    // produce two memberships.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "memberships" (
        "account_id" UUID        NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "space_id"   UUID        NOT NULL REFERENCES "spaces"   ("id") ON DELETE CASCADE,
        "joined_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "invite_id"  UUID,
        PRIMARY KEY ("account_id", "space_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "invites" (
        "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "code"       VARCHAR(32) NOT NULL UNIQUE,
        "space_id"   UUID        NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "created_by" UUID        REFERENCES "accounts" ("id") ON DELETE SET NULL,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "max_uses"   INT,
        "uses"       INT         NOT NULL DEFAULT 0,
        "revoked_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Listing a Space's invites is the only query that is not by code, and the
    // unique constraint on `code` already serves redemption.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_invites_space" ON "invites" ("space_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "refresh_tokens" (
        "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "token_hash"  VARCHAR(64) NOT NULL UNIQUE,
        "account_id"  UUID        NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "family_id"   UUID        NOT NULL,
        "expires_at"  TIMESTAMPTZ NOT NULL,
        "consumed_at" TIMESTAMPTZ,
        "revoked_at"  TIMESTAMPTZ,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Reuse detection revokes a whole family in one statement, and logout does
    // the same for every family an account holds. Both are writes on a hot path
    // (every refresh rotates), so neither may be a sequential scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_family" ON "refresh_tokens" ("family_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_account" ON "refresh_tokens" ("account_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "password_resets" (
        "token_hash" VARCHAR(64) PRIMARY KEY,
        "account_id" UUID        NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "used_at"    TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_password_resets_account"
        ON "password_resets" ("account_id")
    `);
  }

  /**
   * Dropped children-first, because the foreign keys above are real.
   *
   * `spaces` and `accounts` go last: everything else references one or both, and
   * `CASCADE` on the constraint does not help a `DROP TABLE` whose dependents
   * still exist.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "password_resets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invites"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memberships"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "accounts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "spaces"`);
  }
}
