/**
 * Chat history on PostgreSQL — ADR 0008.
 *
 * ── Where the connection comes from ─────────────────────────────────────────
 *
 * Phase 5 opened its own `DataSource` here, because chat was the only thing with
 * anything to store. Phase 6 added accounts, so the connection moved to
 * `persistence/database.ts` and is lent to this store — see the header there for
 * why two pools against one Postgres was not an option, and why none of this
 * goes through `TypeOrmModule.forRoot`.
 *
 * What did **not** change is the behaviour `CHAT_PERSISTENCE` describes: `auto`
 * degrades to memory when there is no database, `postgres` refuses to boot, and
 * `memory` never looks. `createChatHistoryStore` below still owns that decision;
 * it now reads the connection instead of making one.
 */

import { Logger } from '@nestjs/common';
import { LessThan, type DataSource, type Repository } from 'typeorm';
import type { ChatMentionDto, ChatScope } from '@hubitat/protocol';
import type { RuntimeConfig } from '../config/tuning.config.js';
import {
  MemoryChatHistoryStore,
  type AppendChatMessage,
  type ChatHistoryPage,
  type ChatHistoryStore,
  type StoredChatMessage,
} from './chat-history.store.js';
import { MessageEntity, ReadStateEntity } from './chat.entities.js';

const logger = new Logger('ChatHistory');

export class PostgresChatHistoryStore implements ChatHistoryStore {
  readonly kind = 'postgres' as const;

  private readonly messages: Repository<MessageEntity>;
  private readonly readState: Repository<ReadStateEntity>;

  constructor(private readonly dataSource: DataSource) {
    this.messages = dataSource.getRepository(MessageEntity);
    this.readState = dataSource.getRepository(ReadStateEntity);
  }

  async append(message: AppendChatMessage): Promise<number> {
    const row = this.messages.create({
      messageId: message.id,
      channelKey: message.channelKey,
      scope: message.scope,
      senderSessionId: message.senderSessionId,
      senderName: message.senderName,
      body: message.body,
      createdAt: new Date(message.at),
      mentions: message.mentions,
    });
    const saved = await this.messages.save(row);
    // `bigint` arrives as a string, because 2^63 does not fit a JS number. A
    // sequence number does — this counter would need 9 quadrillion messages to
    // lose precision — so it is narrowed here rather than leaking a string into
    // the wire schema, where it would compare wrong in every client that sorts.
    return Number(saved.seq);
  }

  async page(
    channelKey: string,
    options: { beforeSeq?: number; limit: number },
  ): Promise<ChatHistoryPage> {
    // One extra row, purely to answer `complete` without a second COUNT: if the
    // limit+1 row exists there is older history, and it is discarded.
    const rows = await this.messages.find({
      where: {
        channelKey,
        ...(options.beforeSeq === undefined ? {} : { seq: LessThan(String(options.beforeSeq)) }),
      },
      order: { seq: 'DESC' },
      take: options.limit + 1,
    });

    const complete = rows.length <= options.limit;
    const page = complete ? rows : rows.slice(0, options.limit);

    // Read newest-first so the index serves the query; handed back oldest-first
    // so a client can append without reversing.
    return { messages: page.reverse().map(toStored), complete };
  }

  async lastRead(identity: string, channelKey: string): Promise<number> {
    const row = await this.readState.findOne({
      where: { identity, channelKey },
    });
    return row?.lastSeq ?? 0;
  }

  /**
   * Upsert, with the marker pinned monotonic **in SQL**.
   *
   * `GREATEST` rather than a read-then-write: two tabs of the same session can
   * report different positions in the same instant, and a last-write-wins upsert
   * would let the one that is further behind resurrect messages the person has
   * already read.
   */
  async markRead(identity: string, channelKey: string, seq: number): Promise<void> {
    await this.readState.query(
      `INSERT INTO "read_state" ("identity", "channel_key", "last_seq", "updated_at")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("identity", "channel_key") DO UPDATE
         SET "last_seq"   = GREATEST("read_state"."last_seq", EXCLUDED."last_seq"),
             "updated_at" = now()`,
      [identity, channelKey, seq],
    );
  }

  async prune(before: Date): Promise<number> {
    const result = await this.messages.delete({ createdAt: LessThan(before) });
    return result.affected ?? 0;
  }

  /**
   * Nothing to close.
   *
   * The connection is borrowed, not owned (phase 6), and destroying a shared
   * `DataSource` from whichever consumer happens to shut down first would take
   * the account services down with it mid-request. `PersistenceModule` owns the
   * lifecycle; the method stays because the port declares it and the memory
   * store genuinely has state to drop.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function toStored(row: MessageEntity): StoredChatMessage {
  return {
    id: row.messageId,
    channelKey: row.channelKey,
    scope: row.scope as ChatScope,
    seq: Number(row.seq),
    senderSessionId: row.senderSessionId,
    senderName: row.senderName,
    body: row.body,
    at: row.createdAt.getTime(),
    mentions: (row.mentions ?? []) as ChatMentionDto[],
  };
}

/**
 * Pick a history store — the whole of `CHAT_PERSISTENCE`'s behaviour.
 *
 * `memory` never looks at the connection even when one exists, which is what
 * makes it a promise rather than a preference. Otherwise the store follows the
 * database: present means durable, absent means memory. The *refusal* case —
 * `CHAT_PERSISTENCE=postgres` with no database — is enforced one layer down in
 * `openDatabase`, because by the time this function runs the decision to carry
 * on without a connection has already been made and logged.
 */
export function createChatHistoryStore(
  config: RuntimeConfig,
  dataSource: DataSource | null,
): ChatHistoryStore {
  if (config.chatPersistence === 'memory') {
    logger.log('CHAT_PERSISTENCE=memory — room and direct history lives in this process only.');
    return new MemoryChatHistoryStore(config.chatHistoryLimit);
  }

  if (!dataSource) {
    logger.warn(
      'No database — room and direct history lives in this process and empties on restart.',
    );
    return new MemoryChatHistoryStore(config.chatHistoryLimit);
  }

  return new PostgresChatHistoryStore(dataSource);
}
