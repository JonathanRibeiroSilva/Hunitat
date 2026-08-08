/**
 * The storage layer, with no opinion about the world.
 *
 * ── The shape, and why it is this shape ─────────────────────────────────────
 *
 * `ChatService` is consumed by `WorldGateway`, which lives in `WorldModule`, so
 * `WorldModule` would have to import a chat module — and a chat module needs
 * `WorldInstanceService` back, which is a cycle. Phase 5 broke it by exporting
 * only the *store*: the part with no opinion about participants, which both
 * sides can depend on.
 *
 * Phase 6 keeps exactly that arrangement and adds the connection underneath it:
 *
 *   PersistenceModule ── the DataSource, and the chat history store built on it.
 *                        Knows nothing about the world.
 *   AuthModule        ── accounts, spaces, invites. Imports this one.
 *   WorldModule       ── imports both, and provides ChatService alongside the
 *                        gateway that uses it.
 *
 * Global, unlike its phase-5 self, because three modules now need the same
 * connection and threading `imports: [PersistenceModule]` through each of them
 * buys nothing when there is exactly one instance of it either way.
 */

import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { loadConfig } from '../config/tuning.config.js';
import { CHAT_HISTORY_STORE, type ChatHistoryStore } from '../chat/chat-history.store.js';
import { createChatHistoryStore } from '../chat/postgres-history.store.js';
import { DATA_SOURCE, openDatabase } from './database.js';

/**
 * Opened once, at boot, and allowed to fail.
 *
 * `null` is a supported value and every consumer handles it — see
 * `openDatabase`. Nest resolves this before anything that injects it, so no
 * service ever sees a connection that is still opening.
 */
const dataSource: Provider = {
  provide: DATA_SOURCE,
  useFactory: (): Promise<DataSource | null> => openDatabase(loadConfig()),
};

/** Derived from the connection rather than opening its own — phase 5's
 *  `CHAT_PERSISTENCE` behaviour is unchanged, it just no longer owns a pool. */
const historyStore: Provider = {
  provide: CHAT_HISTORY_STORE,
  inject: [DATA_SOURCE],
  useFactory: (source: DataSource | null): ChatHistoryStore =>
    createChatHistoryStore(loadConfig(), source),
};

@Global()
@Module({
  providers: [dataSource, historyStore],
  exports: [DATA_SOURCE, CHAT_HISTORY_STORE],
})
export class PersistenceModule implements OnApplicationShutdown {
  private readonly logger = new Logger(PersistenceModule.name);

  constructor(@Inject(DATA_SOURCE) private readonly source: DataSource | null) {}

  /**
   * The connection is closed here and nowhere else.
   *
   * It is shared by the chat store and every account service, so whichever of
   * them shut down first would otherwise take the pool out from under the
   * others mid-request. Nest runs module shutdown hooks after the providers
   * that depend on them, which is the ordering this relies on.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.source?.isInitialized) return;
    await this.source.destroy();
    this.logger.log('Database connection closed.');
  }
}
