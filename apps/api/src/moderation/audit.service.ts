/**
 * `DC-7.7 Audit Log` — `FR-7.19`, `FR-7.20`.
 *
 * ── Why this is a service and not an interceptor ────────────────────────────
 *
 * The Phase 7 implementation notes suggest "a NestJS interceptor on moderation
 * endpoints", and half of that is unbuildable here: the moderation actions
 * `FR-7.19` names — mute, kick, ban, respawn — arrive as **WebSocket frames**, and
 * an HTTP interceptor never sees them. An interceptor covering only the REST half
 * would produce a log that is silent about exactly the actions people care about,
 * which is worse than no log because it looks complete.
 *
 * So it is an explicit call, made by the two places that perform moderation —
 * `ModerationService` for the socket and `ModerationController` for HTTP — and it
 * is made **after** the action succeeds. An interceptor logs the request; this
 * logs the outcome, and "tried to ban and was refused" is not the same row as
 * "banned".
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 *
 * Writing an audit row must never undo the moderation it records. A kick that
 * threw because the log was unavailable would leave a disruptive participant in
 * the room, which is the wrong way round: the point of the log is
 * accountability, and refusing to act unaccountably means not acting at all.
 * So a failed write is logged at `error` — loudly, because a silent gap in an
 * append-only record is the one failure it cannot survive — and the action
 * stands.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { TUNING, type AuditEntryDto } from '@hubitat/protocol';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { SpaceService } from '../auth/space.service.js';
import { AuditEntity } from './moderation.entities.js';

/** The verbs. A closed set so the reader can render a sentence per action rather
 *  than storing one — a wording change must not require rewriting rows that
 *  cannot be rewritten. */
export type AuditAction =
  | 'mute'
  | 'unmute'
  | 'disable-video'
  | 'enable-video'
  | 'kick'
  | 'ban'
  | 'unban'
  | 'respawn'
  | 'role'
  | 'ownership-transfer'
  | 'access'
  | 'allowlist'
  | 'report-reviewed'
  // ── Phase 8, `FR-8.15`–`FR-8.17` ───────────────────────────────────────────
  //
  // Lifecycle acts on the Space itself. They belong in the same log as a ban for
  // the same reason: archiving a room moves people out of it, and deleting one
  // destroys what was authored in it. "Where did the atrium go" is exactly the
  // question `FR-7.20` exists to answer, and it would be unanswerable if only
  // moderation of *people* were recorded.
  | 'map-created'
  | 'map-updated'
  | 'map-archived'
  | 'map-deleted'
  | 'space-created'
  | 'space-updated'
  | 'space-deleted';

export interface AuditInput {
  actorIdentity: string;
  actorName: string;
  action: AuditAction;
  targetIdentity?: string | null;
  targetName?: string | null;
  detail?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly entries: Repository<AuditEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly spaces: SpaceService,
  ) {
    this.entries = dataSource ? dataSource.getRepository(AuditEntity) : null;
  }

  get enabled(): boolean {
    return this.entries !== null;
  }

  /**
   * `FR-7.19` — actor, target, action, time and scope.
   *
   * Time is the column default rather than a value passed in: `now()` is the
   * database's clock, and an append-only log timestamped by whichever process
   * happened to write it would order two actions by the drift between two
   * machines. Scope is `space_id`, which is the only scope that exists until
   * phase 8 makes more.
   */
  async record(input: AuditInput): Promise<void> {
    if (!this.entries) return;

    try {
      const space = await this.spaces.current();
      if (!space) return;

      // `save` on a constructed row rather than `insert` with an object literal:
      // `detail` is deliberately free-form `jsonb`, and TypeORM's insert types
      // map over the entity's keys, which an index signature does not survive.
      // The row is identical either way.
      const entry = new AuditEntity();
      entry.spaceId = space.id;
      entry.actorIdentity = input.actorIdentity;
      entry.actorName = input.actorName;
      entry.action = input.action;
      entry.targetIdentity = input.targetIdentity ?? null;
      entry.targetName = input.targetName ?? null;
      entry.detail = input.detail ?? {};
      await this.entries.save(entry);
    } catch (error) {
      // Never rethrown — see the file header. Logged at `error` and not `warn`
      // because a gap in an append-only record is not a degraded feature, it is
      // the feature failing.
      this.logger.error(
        `Could not write an audit entry for "${input.action}" by ${input.actorName}: ` +
          `${(error as Error).message}. The action itself succeeded.`,
      );
    }
  }

  /**
   * `FR-7.20` — what a permitted role reads back.
   *
   * Newest first and capped at `MODERATION_PAGE_SIZE`. Review is the requirement,
   * not archaeology, and an unbounded read of a table that only ever grows is a
   * scan that gets slower for the life of the deployment.
   */
  async recent(limit = TUNING.MODERATION_PAGE_SIZE): Promise<AuditEntryDto[]> {
    if (!this.entries) return [];
    const space = await this.spaces.current();
    if (!space) return [];

    const rows = await this.entries.find({
      where: { spaceId: space.id },
      order: { at: 'DESC', id: 'DESC' },
      take: Math.min(limit, TUNING.MODERATION_PAGE_SIZE),
    });

    return rows.map((row) => ({
      id: String(row.id),
      at: row.at.toISOString(),
      actorName: row.actorName,
      actorIdentity: row.actorIdentity,
      action: row.action,
      targetName: row.targetName,
      targetIdentity: row.targetIdentity,
      detail: row.detail ?? {},
    }));
  }
}
