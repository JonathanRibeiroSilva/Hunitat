/**
 * The first migration in the project — `messages` and `read_state` (`DC-5.2`,
 * `DC-5.4`).
 *
 * ADR 0008: **versioned migrations, never `synchronize`.** `synchronize: true`
 * is convenient in development and destroys data in production, so it is off in
 * every environment including this one — the migration path is exercised from
 * the first table rather than discovered during the first deployment.
 *
 * Hand-written rather than generated. ADR 0008 notes that TypeORM's generator
 * drifts from hand-written entities on anything complex; two tables is not
 * complex, and reviewing generated SQL costs more than writing it.
 */

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ChatMessages1754000000000 implements MigrationInterface {
  name = 'ChatMessages1754000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "seq"               BIGSERIAL      PRIMARY KEY,
        "message_id"        UUID           NOT NULL UNIQUE,
        "channel_key"       VARCHAR(255)   NOT NULL,
        "scope"             VARCHAR(16)    NOT NULL,
        "sender_session_id" VARCHAR(64)    NOT NULL,
        "sender_name"       VARCHAR(64)    NOT NULL,
        "body"              TEXT           NOT NULL,
        "created_at"        TIMESTAMPTZ    NOT NULL,
        "mentions"          JSONB          NOT NULL DEFAULT '[]'::jsonb
      )
    `);

    // The only query shape this table serves: the newest N in one channel,
    // optionally before a sequence number. Descending so paging backwards — the
    // direction people actually scroll — reads the index forwards.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_channel_seq"
        ON "messages" ("channel_key", "seq" DESC)
    `);

    // Retention (FR-5.11) sweeps by age across every channel, which the
    // composite index above cannot serve.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_created_at"
        ON "messages" ("created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "read_state" (
        "identity"    VARCHAR(128) NOT NULL,
        "channel_key" VARCHAR(255) NOT NULL,
        "last_seq"    BIGINT       NOT NULL DEFAULT 0,
        "updated_at"  TIMESTAMPTZ  NOT NULL,
        PRIMARY KEY ("identity", "channel_key")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "read_state"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_channel_seq"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messages"`);
  }
}
