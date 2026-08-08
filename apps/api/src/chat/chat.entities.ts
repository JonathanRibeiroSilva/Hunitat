/**
 * `messages` and `read_state` — ADR 0008, docs/architecture.md.
 *
 * The first durable tables in the project. Everything before Phase 5 was
 * deliberately transient: `FR-1.7` requires guest identity to be ephemeral, and
 * a world instance dies with the process (ADR 0009). Chat is the first thing a
 * person expects to still be there tomorrow.
 *
 * Decorated classes rather than a schema builder, as ADR 0008 chose, so the
 * shape lives beside the code that reads it.
 *
 * ── Identity, before there is any ───────────────────────────────────────────
 *
 * `senderSessionId` and `readState.identity` hold a **session id** today, which
 * lasts exactly as long as a connection. That is the Phase 5 Rule — "for guests
 * this lasts only as long as the session; durable DMs depend on accounts (Phase
 * 6)" — expressed in a column rather than in a comment. Phase 6 changes what
 * goes in these columns, not their shape.
 */

import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  type ValueTransformer,
} from 'typeorm';
import type { ChatMentionDto } from '@hubitat/protocol';

/**
 * `bigint` arrives from `pg` as a string, because 2^63 does not fit a JS number.
 * Sequence numbers do — this counter would need to reach 9 quadrillion messages
 * to lose precision — so they are narrowed once, here, rather than every call
 * site remembering that one field is a string.
 */
const bigintAsNumber: ValueTransformer = {
  to: (value: number | undefined) => value,
  from: (value: string | number | null) => (value === null ? 0 : Number(value)),
};

@Entity({ name: 'messages' })
@Index('idx_messages_channel_seq', ['channelKey', 'seq'])
export class MessageEntity {
  /**
   * `FR-5.7` — the ordering, and `BIGSERIAL` is what assigns it.
   *
   * The database decides, not the sender: "stable order per channel under
   * concurrent sends" is a property two clients cannot negotiate, and a client
   * timestamp would let a skewed clock post into last Tuesday. Globally
   * monotonic rather than per-channel, which is a valid ordering within every
   * channel and one fewer counter to keep consistent.
   *
   * Typed `string`, unlike `lastSeq` below, because TypeORM's numeric primary-key
   * options carry no `transformer` — the narrowing happens at the two read sites
   * in postgres-history.store.ts instead of being hidden here.
   */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  seq!: string;

  /** The message's own id, stable across the wire and the table. */
  @Column({ name: 'message_id', type: 'uuid', unique: true })
  messageId!: string;

  /** `room`, or `dm:<a>|<b>` with the ids sorted — see `directConversationKey`. */
  @Column({ name: 'channel_key', type: 'varchar', length: 255 })
  channelKey!: string;

  @Column({ type: 'varchar', length: 16 })
  scope!: string;

  @Column({ name: 'sender_session_id', type: 'varchar', length: 64 })
  senderSessionId!: string;

  /**
   * Denormalised on purpose.
   *
   * A guest's display name exists only for the life of their session, so there
   * is nothing to join to when the history is read back tomorrow. `FR-5.7`
   * requires the sender's name to be shown; storing it is the only way that
   * survives the sender leaving. Phase 6 gains a `profiles` row to join to and
   * this stays as the fallback for guests.
   */
  @Column({ name: 'sender_name', type: 'varchar', length: 64 })
  senderName!: string;

  @Column({ type: 'text' })
  body!: string;

  /** Server clock. `timestamptz`, because "90 days" must not mean something
   *  different after a deployment moves timezone. */
  @Index('idx_messages_created_at')
  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** `FR-5.15`. `jsonb` rather than a join table: mentions are read only with
   *  their message and never queried across messages. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  mentions!: ChatMentionDto[];
}

/** `DC-5.4 Read State` — `FR-5.16`. One row per (identity, channel). */
@Entity({ name: 'read_state' })
export class ReadStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  identity!: string;

  @PrimaryColumn({ name: 'channel_key', type: 'varchar', length: 255 })
  channelKey!: string;

  /** The highest `seq` this identity has seen in this channel. */
  @Column({ name: 'last_seq', type: 'bigint', transformer: bigintAsNumber })
  lastSeq!: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
