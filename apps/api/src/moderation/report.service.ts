/**
 * `DC-7.6 Report` — `FR-7.17`, and half of `AC-7.6`.
 *
 * Filing is deliberately easy and deliberately not moderation. A report changes
 * nothing about the person it names: it does not mute them, it does not warn
 * them, and it does not tell them it exists. It creates a record for a moderator
 * to read, which is exactly what the requirement asks for and exactly as much as
 * it asks for — anything more would make reporting a weapon.
 *
 * ── The context is the server's, not the reporter's ─────────────────────────
 *
 * `FR-7.17` asks for "context (who, where, optional reason)". The *where* is
 * captured here, from the world's own view of the target at the moment of
 * filing: their position, the map, and the zones they were standing in. A
 * client-supplied location would be a fact about the accused, supplied by the
 * accuser.
 *
 * Only `reason` comes from the reporter, because only they know it.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { TUNING, type ReportDto } from '@hubitat/protocol';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { SpaceService } from '../auth/space.service.js';
import { ReportEntity } from './moderation.entities.js';

export interface ReportInput {
  reporterIdentity: string;
  reporterName: string;
  targetIdentity: string;
  targetName: string;
  reason?: string;
  context: {
    mapId: string;
    x: number;
    y: number;
    z: number;
    zoneIds: string[];
  };
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly reports: Repository<ReportEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly spaces: SpaceService,
  ) {
    this.reports = dataSource ? dataSource.getRepository(ReportEntity) : null;
  }

  get enabled(): boolean {
    return this.reports !== null;
  }

  /**
   * `FR-7.17` — record it, and say whether it was recorded.
   *
   * The boolean matters. On a server with no database a report has nowhere to go,
   * and the person filing it has to be told that rather than watching a
   * confirmation for something that did not happen — the same honesty
   * `accountsEnabled` buys the sign-in form.
   */
  async file(input: ReportInput): Promise<boolean> {
    if (!this.reports) {
      this.logger.warn(
        `${input.reporterName} reported ${input.targetName}, and this server has no database ` +
          `to record it in. The reporter has been told.`,
      );
      return false;
    }

    const space = await this.spaces.current();
    if (!space) return false;

    await this.reports.insert({
      spaceId: space.id,
      reporterIdentity: input.reporterIdentity,
      reporterName: input.reporterName,
      targetIdentity: input.targetIdentity,
      targetName: input.targetName,
      reason: input.reason?.trim() || null,
      context: input.context,
      reviewedAt: null,
      reviewedBy: null,
    });

    // Logged as well as stored, because a moderation panel nobody has open is
    // not a notification. Deliberately without the reason text: it is a
    // complaint about a named person and it belongs in the table a moderator
    // reads, not in a log that gets shipped somewhere.
    this.logger.log(
      `Report filed by ${input.reporterName} about ${input.targetName} ` +
        `at (${input.context.x.toFixed(1)}, ${input.context.z.toFixed(1)}) on ${input.context.mapId}.`,
    );
    return true;
  }

  /** `AC-7.6` — what moderators see. Unreviewed first, then newest. */
  async recent(limit = TUNING.MODERATION_PAGE_SIZE): Promise<ReportDto[]> {
    if (!this.reports) return [];
    const space = await this.spaces.current();
    if (!space) return [];

    const rows = await this.reports.find({
      where: { spaceId: space.id },
      // `NULLS FIRST` is the whole ordering, and it has to be said: Postgres
      // sorts nulls **last** for `ASC` by default, so the obvious spelling puts
      // every handled report above the ones still waiting for somebody — which
      // is the queue in exactly the wrong order.
      order: { reviewedAt: { direction: 'ASC', nulls: 'FIRST' }, createdAt: 'DESC' },
      take: Math.min(limit, TUNING.MODERATION_PAGE_SIZE),
    });

    return rows.map((row) => ({
      id: row.id,
      reporterName: row.reporterName,
      targetName: row.targetName,
      targetIdentity: row.targetIdentity,
      reason: row.reason,
      context: row.context,
      createdAt: row.createdAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy,
    }));
  }

  /**
   * Mark one as dealt with.
   *
   * Reports are not append-only, unlike the audit log, and the difference is
   * deliberate: a report is a queue item and a queue that cannot be emptied is a
   * queue nobody works. The *acts* a moderator takes in response are what the
   * append-only log records, and marking a report reviewed is itself one of them.
   */
  async markReviewed(id: string, reviewerName: string): Promise<boolean> {
    if (!this.reports) return false;
    const space = await this.spaces.current();
    if (!space) return false;

    const result = await this.reports.update(
      { id, spaceId: space.id },
      { reviewedAt: new Date(), reviewedBy: reviewerName },
    );
    return (result.affected ?? 0) > 0;
  }

  async find(id: string): Promise<ReportEntity | null> {
    if (!this.reports) return null;
    return this.reports.findOne({ where: { id } });
  }
}
