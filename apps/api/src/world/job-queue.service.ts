/**
 * The job queue — pg-boss, in the database that is already there (ADR 0009).
 *
 * ── Why a queue at all ──────────────────────────────────────────────────────
 *
 * `FR-9.13` is tens of seconds of synchronous CPU for a large model: parse it,
 * weld it, simplify it three times, write it back. This process also runs the
 * **20 Hz world tick**. Run inline, asset optimization blocks the event loop and
 * freezes everybody walking around the 3D world — the upload is not slow, the
 * world stutters, and nobody connects the two.
 *
 * So the api only ever *enqueues*. `apps/worker` runs the job in its own
 * container: a separate process rather than a worker thread, because a thread
 * would free the event loop but would not survive an out-of-memory kill while
 * decompressing a large model — and an OOM in `api` drops every WebSocket
 * connection at once.
 *
 * ── Why pg-boss and not Redis ───────────────────────────────────────────────
 *
 * ADR 0009 declined Redis. There is exactly one durable store in this
 * deployment, the jobs are few and small, and a second piece of infrastructure
 * to operate — with its own persistence question — buys nothing here.
 *
 * ── Absence is a supported state ────────────────────────────────────────────
 *
 * With no database, or with `ASSET_PIPELINE=off`, nothing is queued and an
 * uploaded model is usable exactly as it arrived: no level-of-detail variants,
 * which is honest and is what a development machine with no worker container
 * has. The asset's status says so rather than sitting at `pending` forever.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import PgBoss from 'pg-boss';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';

/** The one job this phase defines. Named as a constant because the worker
 *  subscribes to the same string, and a typo would be a job nobody runs and no
 *  error anywhere. */
export const ASSET_OPTIMIZE_JOB = 'asset.optimize';

export interface AssetOptimizeJob {
  assetId: string;
  spaceId: string;
  storageKey: string;
  kind: string;
}

@Injectable()
export class JobQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly config: RuntimeConfig = loadConfig();
  private boss: PgBoss | null = null;

  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource | null) {}

  get enabled(): boolean {
    return this.boss !== null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.dataSource || this.config.assetPipeline === 'off') {
      this.logger.log(
        this.config.assetPipeline === 'off'
          ? 'ASSET_PIPELINE=off — uploads are usable as they arrive, with no level-of-detail ' +
              'variants (FR-9.13).'
          : 'No database — the asset pipeline is unavailable. Uploads need one to queue against.',
      );
      return;
    }

    try {
      const boss = new PgBoss({
        host: this.config.postgresHost,
        port: this.config.postgresPort,
        user: this.config.postgresUser,
        password: this.config.postgresPassword,
        database: this.config.postgresDb,
        // Its own schema, so pg-boss's tables never collide with a migration of
        // ours and `docker compose down -v` remains the only way to lose either.
        schema: 'pgboss',
        // A queue that grows without bound is a table that grows without bound.
        // Jobs here are idempotent by construction — re-optimizing an asset
        // produces the same variants — so keeping a fortnight is generous.
        archiveCompletedAfterSeconds: 60 * 60 * 24,
      });

      boss.on('error', (error) => this.logger.error(`pg-boss: ${error.message}`));
      await boss.start();
      // v10 requires a queue to exist before anything is sent to it, and both
      // sides create it: whichever process boots first wins, and the other one
      // is a no-op.
      await boss.createQueue(ASSET_OPTIMIZE_JOB);

      this.boss = boss;
      this.logger.log(`Job queue ready — "${ASSET_OPTIMIZE_JOB}" (FR-9.13).`);
    } catch (error) {
      // Not fatal. The pipeline is an optimization; an upload without it is a
      // usable asset with no variants, and refusing to boot over it would take
      // the world down for a feature nobody is using yet.
      this.logger.warn(
        `Could not start the job queue: ${(error as Error).message}. Uploads will be usable ` +
          `as they arrive, without level-of-detail variants.`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true }).catch(() => undefined);
    this.boss = null;
  }

  /** Returns whether it was queued. False means the caller should mark the
   *  asset usable as-is rather than leaving it `pending` forever. */
  async enqueueOptimize(job: AssetOptimizeJob): Promise<boolean> {
    if (!this.boss) return false;
    try {
      await this.boss.send(ASSET_OPTIMIZE_JOB, job, {
        // Three attempts with backoff. The failure this covers is a transient
        // one — object storage briefly unreachable — and a malformed model
        // fails deterministically and is *rejected* rather than retried.
        retryLimit: 3,
        retryDelay: 10,
        retryBackoff: true,
        expireInMinutes: 15,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not queue optimization for ${job.assetId}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
