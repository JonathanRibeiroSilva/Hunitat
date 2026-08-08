/**
 * The one database connection — ADR 0008.
 *
 * ── Why this moved out of `chat/` in phase 6 ────────────────────────────────
 *
 * Phase 5 opened a `DataSource` inside the chat history store, because chat was
 * the only thing that had anything to store. Phase 6 adds accounts, and two
 * independently-opened pools against the same Postgres would be two connection
 * limits to size, two migration runners racing each other on first boot, and two
 * different answers to "is the database up". So the connection is owned here and
 * lent to both; the chat store keeps its own *behaviour* and loses only its
 * plumbing.
 *
 * ── Why not `TypeOrmModule.forRoot` ─────────────────────────────────────────
 *
 * The same reason phase 5 gave, now with a second beneficiary. `forRoot` treats
 * an unreachable database as a fatal boot error in every configuration, and both
 * features need it to be a *choice*: chat degrades to memory under
 * `CHAT_PERSISTENCE=auto`, accounts turn themselves off under `ACCOUNTS=auto`,
 * and either can be made a refusal instead. None of those three states are
 * expressible through `forRoot`.
 *
 * What ADR 0008 actually chose is preserved in full: TypeORM, decorated entity
 * classes, versioned migrations, and `synchronize` off in every environment.
 */

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { RuntimeConfig } from '../config/tuning.config.js';
import { MessageEntity, ReadStateEntity } from '../chat/chat.entities.js';
import { ChatMessages1754000000000 } from '../chat/migrations/1754000000000-chat-messages.js';
import {
  AccountEntity,
  InviteEntity,
  MembershipEntity,
  PasswordResetEntity,
  ProfileEntity,
  RefreshTokenEntity,
  SpaceEntity,
} from '../auth/auth.entities.js';
import { Accounts1755000000000 } from '../auth/migrations/1755000000000-accounts.js';
import {
  AllowlistEntity,
  AuditEntity,
  BanEntity,
  BlockEntity,
  ReportEntity,
} from '../moderation/moderation.entities.js';
import { Moderation1756000000000 } from '../moderation/migrations/1756000000000-moderation.js';
import { MapEntity, MapVersionEntity } from '../world/map.entities.js';
import { AssetEntity } from '../world/asset.entities.js';
import { ObjectStateEntity } from '../world/object-state.entities.js';
import { SpacesAndMaps1757000000000 } from '../world/migrations/1757000000000-spaces-and-maps.js';
import { Editor1758000000000 } from '../world/migrations/1758000000000-editor.js';
import { ObjectStates1759000000000 } from '../world/migrations/1759000000000-object-states.js';

const logger = new Logger('Database');

/**
 * How long to wait before deciding the database is not there.
 *
 * Short, because this runs on the boot path and both `auto` modes have somewhere
 * to fall back to. A long timeout here is five seconds added to every
 * `npm run dev` on a machine with no Docker running.
 */
const CONNECT_TIMEOUT_MS = 5_000;

/** Nest injection token. The value is `DataSource | null` — see `openDatabase`. */
export const DATA_SOURCE = Symbol('DATA_SOURCE');

/**
 * Every entity and every migration, in one list each.
 *
 * Exported so the TypeORM CLI and any future migration tooling read the same
 * arrays the running server does. A migration that exists on disk and is missing
 * from this list does not run, and the failure is a missing column at the first
 * query rather than anything at boot.
 */
export const ENTITIES = [
  MessageEntity,
  ReadStateEntity,
  SpaceEntity,
  AccountEntity,
  ProfileEntity,
  MembershipEntity,
  InviteEntity,
  RefreshTokenEntity,
  PasswordResetEntity,
  BanEntity,
  BlockEntity,
  ReportEntity,
  AuditEntity,
  AllowlistEntity,
  MapEntity,
  MapVersionEntity,
  AssetEntity,
  ObjectStateEntity,
];

export const MIGRATIONS = [
  ChatMessages1754000000000,
  Accounts1755000000000,
  Moderation1756000000000,
  SpacesAndMaps1757000000000,
  Editor1758000000000,
  ObjectStates1759000000000,
];

/**
 * Open the connection, or decide — out loud — to run without one.
 *
 * Returns `null` when there is no database and neither feature insisted on one.
 * Every caller has to handle that: the chat store falls back to memory, and the
 * account services report themselves unavailable so the client never offers a
 * sign-in form that cannot succeed.
 */
export async function openDatabase(config: RuntimeConfig): Promise<DataSource | null> {
  const chatWants = config.chatPersistence !== 'memory';
  const accountsWant = config.accounts !== 'off';

  if (!chatWants && !accountsWant) {
    logger.log(
      'CHAT_PERSISTENCE=memory and ACCOUNTS=off — no database connection is opened. ' +
        'Chat history lives in this process and everybody joins as a guest.',
    );
    return null;
  }

  try {
    const dataSource = await connect(config);
    logger.log(
      `PostgreSQL at ${config.postgresHost}:${config.postgresPort}/${config.postgresDb} ` +
        `(chat: ${chatWants ? 'durable' : 'memory'}, accounts: ${accountsWant ? 'on' : 'off'})`,
    );
    return dataSource;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // Both refusals, and they are separate messages on purpose: an operator who
    // set one of them knows which promise they made, and a combined "the
    // database is required" would not say which setting to look at.
    if (config.chatPersistence === 'postgres') {
      throw new Error(
        `CHAT_PERSISTENCE=postgres but the database could not be reached: ${reason}. ` +
          `Start it (docker compose up -d postgres), fix POSTGRES_*, or set ` +
          `CHAT_PERSISTENCE=memory to run without durable history.`,
      );
    }
    if (config.accounts === 'required') {
      throw new Error(
        `ACCOUNTS=required but the database could not be reached: ${reason}. ` +
          `Accounts cannot exist without one, and starting anyway would admit everybody ` +
          `as a guest — the inverse of what FR-6.8 was set to do. Start the database, ` +
          `or set ACCOUNTS=auto to allow a guest-only run.`,
      );
    }

    logger.warn(
      `PostgreSQL is not reachable (${reason}). Running without it: ` +
        `${chatWants ? 'chat history falls back to memory and empties on restart' : 'chat history is in memory'}, ` +
        `${accountsWant ? 'and accounts are unavailable — everybody joins as a guest' : 'and accounts are off'}. ` +
        `Set CHAT_PERSISTENCE=postgres or ACCOUNTS=required to make this a boot failure instead.`,
    );
    return null;
  }
}

async function connect(config: RuntimeConfig): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: config.postgresHost,
    port: config.postgresPort,
    username: config.postgresUser,
    password: config.postgresPassword,
    database: config.postgresDb,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    // ADR 0008 — disabled in EVERY environment, development included, so the
    // migration path is exercised from day one rather than discovered late.
    synchronize: false,
    migrationsRun: true,
    logging: ['error', 'warn', 'migration'],
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    // One attempt. TypeORM's retry loop exists for a database that is still
    // starting; here a failure has a defined meaning (fall back, or refuse) and
    // waiting 10 × 3 s to reach it would stall every boot without Postgres.
    extra: { max: 8 },
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`connection timed out after ${CONNECT_TIMEOUT_MS} ms`)),
      CONNECT_TIMEOUT_MS,
    ).unref(),
  );

  await Promise.race([dataSource.initialize(), timeout]);
  return dataSource;
}
