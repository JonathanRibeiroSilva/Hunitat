/**
 * Roles, access policy, bans, blocks, reports and the audit log — `DC-7.1`–`DC-7.7`.
 *
 * The third migration. Phase 5's could be lost for the price of chat scrollback
 * and phase 6's holds who everybody is; this one holds **what everybody is
 * allowed to do**, and losing it silently opens a Space to everyone who ever had
 * an account in it.
 *
 * ── Two ALTERs before any CREATE ────────────────────────────────────────────
 *
 * `memberships.role` and the `spaces` access columns are additions to rows phase
 * 6 already writes, not tables of their own. The reasoning is in
 * `auth.entities.ts`; the consequence here is that both default to the phase 6
 * behaviour — `member`, unlocked, no password, no allowlist, no capacity
 * override — so an existing database keeps working exactly as it did until
 * somebody changes something on purpose.
 *
 * ── The audit log is append-only twice ──────────────────────────────────────
 *
 * `FR-7.20` asks for a log "tamper-evident enough to be trusted", and the Phase 7
 * notes name the failure directly: without enforcement, append-only is a comment.
 * So there are two mechanisms, and they cover different attackers:
 *
 *   **The REVOKE** stops the application. It is the one that matters for the bug
 *   this is actually defending against — a future endpoint, or a stray
 *   `manager.update`, quietly rewriting history because nothing said no.
 *
 *   **The trigger** stops a superuser. It is not decoration: `docker-compose.yml`
 *   connects as `POSTGRES_USER`, which owns the database and in the default
 *   Compose setup is a superuser — and superusers bypass grants entirely. Without
 *   the trigger the REVOKE would be a no-op in precisely the deployment this
 *   project ships.
 *
 * Neither stops somebody with a `psql` prompt and the will to `DROP TRIGGER`.
 * That is the honest limit of "tamper-evident enough": the log defends against
 * accident and against the application, and a database administrator is outside
 * its threat model — as they are for every table here.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Moderation1756000000000 implements MigrationInterface {
  name = 'Moderation1756000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── DC-7.1 Role ──────────────────────────────────────────────────────────
    //
    // `member` for every existing row, which is what they all were.
    await queryRunner.query(`
      ALTER TABLE "memberships"
        ADD COLUMN IF NOT EXISTS "role" VARCHAR(16) NOT NULL DEFAULT 'member'
    `);

    // A role outside the matrix is not a role somebody chose; it is a bad write.
    // The constraint is what makes `RolesService` able to read the column back
    // into a union type without validating it a second time.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "memberships"
          ADD CONSTRAINT "chk_memberships_role"
          CHECK ("role" IN ('owner', 'admin', 'member'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // Listing a Space's owners and admins is the roles screen's only query that
    // is not by account, and it runs on every moderation overview.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_memberships_space_role"
        ON "memberships" ("space_id", "role")
    `);

    // ── DC-7.4 Access Policy ─────────────────────────────────────────────────
    //
    // Every default is the phase 6 behaviour, so this migration changes nothing
    // about who can enter until an administrator decides it should.
    await queryRunner.query(`
      ALTER TABLE "spaces"
        ADD COLUMN IF NOT EXISTS "locked"               BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS "access_password_hash" TEXT,
        ADD COLUMN IF NOT EXISTS "allowlist_enabled"    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS "capacity"             INT
    `);

    // `FR-7.13`. Composite primary key: one address appears on one Space's list
    // once, and adding it twice is a no-op rather than a duplicate to reconcile.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "space_allowlist" (
        "space_id"   UUID         NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "email"      VARCHAR(320) NOT NULL,
        "added_by"   VARCHAR(64)  NOT NULL,
        "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
        PRIMARY KEY ("space_id", "email")
      )
    `);

    // ── DC-7.3 Ban ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bans" (
        "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "space_id"        UUID        NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "kind"            VARCHAR(16) NOT NULL,
        "account_id"      UUID        REFERENCES "accounts" ("id") ON DELETE CASCADE,
        "fingerprint"     VARCHAR(128),
        "ip"              VARCHAR(64),
        "display_name"    VARCHAR(64) NOT NULL,
        "reason"          TEXT,
        "created_by"      VARCHAR(128) NOT NULL,
        "created_by_name" VARCHAR(64)  NOT NULL,
        "expires_at"      TIMESTAMPTZ,
        "lifted_at"       TIMESTAMPTZ,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_bans_kind" CHECK ("kind" IN ('account', 'guest')),
        -- A ban that identifies nobody is a row that refuses everybody or
        -- nobody depending on how the join check happens to be written. The
        -- constraint makes that unrepresentable rather than a bug to find later.
        CONSTRAINT "chk_bans_subject" CHECK (
          ("kind" = 'account' AND "account_id" IS NOT NULL) OR
          ("kind" = 'guest'   AND ("fingerprint" IS NOT NULL OR "ip" IS NOT NULL))
        )
      )
    `);

    // The join path asks "is this person banned" on every entry, by account and
    // by fingerprint. Both must be index lookups: this runs before anybody is
    // admitted, so a sequential scan here is latency on the one request a user
    // is already waiting on.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bans_space" ON "bans" ("space_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bans_account" ON "bans" ("account_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bans_fingerprint" ON "bans" ("fingerprint")
    `);

    // ── DC-7.5 Block ─────────────────────────────────────────────────────────
    //
    // No foreign key, and that is deliberate. Both sides hold a phase 6 identity
    // string — `acct:<uuid>` or `guest:<session>` — and a guest identity refers
    // to nothing that exists in any table. A constraint would make blocking a
    // guest impossible, which is most of what blocking is for in a Space that
    // admits them.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "blocks" (
        "blocker_identity" VARCHAR(128) NOT NULL,
        "blocked_identity" VARCHAR(128) NOT NULL,
        "blocked_name"     VARCHAR(64)  NOT NULL,
        "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        PRIMARY KEY ("blocker_identity", "blocked_identity")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_blocks_blocker" ON "blocks" ("blocker_identity")
    `);

    // ── DC-7.6 Report ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports" (
        "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        "space_id"          UUID         NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "reporter_identity" VARCHAR(128) NOT NULL,
        "reporter_name"     VARCHAR(64)  NOT NULL,
        "target_identity"   VARCHAR(128) NOT NULL,
        "target_name"       VARCHAR(64)  NOT NULL,
        "reason"            TEXT,
        "context"           JSONB        NOT NULL,
        "reviewed_at"       TIMESTAMPTZ,
        "reviewed_by"       VARCHAR(64),
        "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reports_space" ON "reports" ("space_id")
    `);

    // ── DC-7.7 Audit Log ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id"              BIGSERIAL    PRIMARY KEY,
        "space_id"        UUID         NOT NULL REFERENCES "spaces" ("id") ON DELETE CASCADE,
        "actor_identity"  VARCHAR(128) NOT NULL,
        "actor_name"      VARCHAR(64)  NOT NULL,
        "action"          VARCHAR(32)  NOT NULL,
        "target_identity" VARCHAR(128),
        "target_name"     VARCHAR(64),
        "detail"          JSONB        NOT NULL DEFAULT '{}'::jsonb,
        "at"              TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    // Reading is always "this Space, newest first" (`FR-7.20`).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_space_at" ON "audit_log" ("space_id", "at" DESC)
    `);

    // Mechanism one: the grant. Stops the application, and any future endpoint
    // that forgets this table is not supposed to be writable twice.
    //
    // Wrapped, because a deployment where the application connects as a role
    // that does not own the table cannot revoke on it — and a migration that
    // fails there would take down a server for a hardening step. The NOTICE says
    // what did not happen, and the trigger below still holds.
    await queryRunner.query(`
      DO $$
      BEGIN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM %I',
                       current_user);
        REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM PUBLIC;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'audit_log: could not revoke write privileges (%). The append-only trigger still applies.',
                     SQLERRM;
      END $$
    `);

    // Mechanism two: the trigger. Stops a superuser, which the grant cannot —
    // and the default Compose deployment connects as one.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION
          'audit_log is append-only (FR-7.20): % is not permitted on this table', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_audit_log_append_only" ON "audit_log"`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_log_append_only"
        BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_log"
        FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"()
    `);
  }

  /**
   * Dropped children-first, and the trigger before the table it guards.
   *
   * `DROP TABLE` on `audit_log` would otherwise fire the statement trigger and
   * fail — the append-only rule catching the one operation it was never meant to
   * stop. A migration that cannot be rolled back is a migration nobody can test.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_audit_log_append_only" ON "audit_log"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "audit_log_append_only"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reports"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "blocks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "space_allowlist"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_memberships_space_role"`);
    await queryRunner.query(`
      ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "chk_memberships_role"
    `);
    await queryRunner.query(`ALTER TABLE "memberships" DROP COLUMN IF EXISTS "role"`);
    await queryRunner.query(`
      ALTER TABLE "spaces"
        DROP COLUMN IF EXISTS "locked",
        DROP COLUMN IF EXISTS "access_password_hash",
        DROP COLUMN IF EXISTS "allowlist_enabled",
        DROP COLUMN IF EXISTS "capacity"
    `);
  }
}
