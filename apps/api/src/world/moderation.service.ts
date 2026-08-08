/**
 * Moderation, enforced — `FR-7.5`–`FR-7.10`, `FR-7.16`, `FR-7.17`.
 *
 * ── Why this lives in `WorldModule` and not in `ModerationModule` ───────────
 *
 * The same reason `ChatService` does, one phase later: it needs
 * `WorldInstanceService`, and `WorldGateway` needs it. A module of its own would
 * make those two imports a cycle. `ModerationModule` next door holds everything
 * with no opinion about the world — the records, the policy, the guard — and this
 * is the half that acts on live sessions.
 *
 * ── The authorization rule, in one place ────────────────────────────────────
 *
 * `NFR-34` requires authorization on both transports, and the Phase 7
 * implementation notes name the unguarded WebSocket handler as the single most
 * likely way this phase ships broken. `authorize` below is the WebSocket half.
 * It asks `hasCapability` and `outranks` from `@hubitat/protocol` — the same two
 * functions `RolesGuard` asks on the HTTP path — so there is one matrix and one
 * ranking rule, not two that drift.
 *
 * Every refusal is answered. `FR-7.4` says an attempt a role does not permit "is
 * refused", and a moderation button that silently does nothing is
 * indistinguishable from one that worked.
 *
 * ── Order of operations for a mute ──────────────────────────────────────────
 *
 *   1. World flags, and the frames that follow from them. Immediate, local, and
 *      cannot fail.
 *   2. LiveKit — `mutePublishedTrack` **and** `updateParticipant`, both, always.
 *   3. The audit row.
 *
 * World first because the SFU can be slow, unreachable, or absent entirely
 * (phase 1's development flow has no LiveKit at all), and none of those may leave
 * a participant showing as unmuted while the moderator watches. Audit last
 * because it records what happened, and a row written before the fact would be
 * recording an intention.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  Op,
  hasCapability,
  outranks,
  type BlockPayload,
  type Capability,
  type ModeratePayload,
  type ReportPayload,
} from '@hubitat/protocol';
import { AccessPolicyService } from '../moderation/access-policy.service.js';
import { AuditService, type AuditAction } from '../moderation/audit.service.js';
import { BlockService } from '../moderation/block.service.js';
import { ReportService } from '../moderation/report.service.js';
import { MediaService } from '../media/media.service.js';
import { WorldInstanceService } from './world-instance.service.js';
import { identityOf, type Participant } from './participant.js';

/** What the gateway does with the answer: nothing on success, one `ERROR` frame
 *  on refusal, one notice on a result worth confirming. */
export interface ModerationOutcome {
  ok: boolean;
  /** Present on a refusal. `forbidden` is the `FR-7.4` code; the others are
   *  ordinary "that did not apply" cases. */
  code?: 'forbidden' | 'bad-frame' | 'internal';
  message?: string;
}

const REFUSED = (message: string): ModerationOutcome => ({
  ok: false,
  code: 'forbidden',
  message,
});

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly world: WorldInstanceService,
    private readonly media: MediaService,
    private readonly access: AccessPolicyService,
    private readonly audit: AuditService,
    private readonly blocks: BlockService,
    private readonly reports: ReportService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.5 – FR-7.9 — acting on a live participant
  // ───────────────────────────────────────────────────────────────────────────

  async moderate(actorSessionId: string, payload: ModeratePayload): Promise<ModerationOutcome> {
    const actor = this.world.getParticipant(actorSessionId);
    if (!actor) return { ok: false, code: 'internal', message: 'You are not in this world.' };

    const target = this.world.getParticipant(payload.targetSessionId);
    if (!target) {
      return { ok: false, code: 'bad-frame', message: 'That person is no longer here.' };
    }

    const refusal = this.authorize(actor, target, payload.action === 'ban' ? 'ban' : 'moderate');
    if (refusal) return refusal;

    switch (payload.action) {
      case 'mute':
      case 'unmute':
        return this.setPublish(actor, target, { micMuted: payload.action === 'mute' }, payload);

      case 'disable-video':
      case 'enable-video':
        return this.setPublish(
          actor,
          target,
          { cameraDisabled: payload.action === 'disable-video' },
          payload,
        );

      case 'respawn':
        this.world.respawn(target.sessionId);
        await this.record(actor, target, 'respawn', {});
        return { ok: true };

      case 'kick':
        return this.removeParticipant(actor, target, payload, false);

      case 'ban':
        return this.removeParticipant(actor, target, payload, true);
    }
  }

  /**
   * `FR-7.5` / `FR-7.6` — the two-call pattern, with the world in front of it.
   *
   * A partial patch rather than a whole `ParticipantModeration`: muting a
   * microphone must not silently re-enable a camera that another moderator
   * disabled a minute ago, and the only way to be sure of that is to merge
   * against the current state rather than replace it.
   */
  private async setPublish(
    actor: Participant,
    target: Participant,
    patch: { micMuted?: boolean; cameraDisabled?: boolean },
    payload: ModeratePayload,
  ): Promise<ModerationOutcome> {
    const next = { ...target.moderation, ...patch };

    const changed = this.world.setModeration(
      target.sessionId,
      next,
      // Only an action that *takes something away* names its author to the
      // target. Restoring a permission needs no explanation, and attaching one
      // would make "you were unmuted by Ana" read like a second sanction.
      patch.micMuted === false || patch.cameraDisabled === false
        ? null
        : { name: actor.displayName, ...(payload.reason ? { reason: payload.reason } : {}) },
    );

    if (!changed) {
      // Already in that state. Not an error and not a refusal — two moderators
      // reaching for the same person is ordinary — but it writes no audit row,
      // because a log full of no-ops is a log nobody reads.
      return { ok: true };
    }

    // Phase 8 — the room the target is actually in. A mute applied against the
    // base room name would silence nobody in a Space with more than one Map, and
    // would do it without an error: LiveKit would simply report no such
    // participant in a room they were never in.
    await this.media.applyPublishPermission(target.sessionId, next, this.roomOf(target));

    const action: AuditAction =
      patch.micMuted !== undefined
        ? patch.micMuted
          ? 'mute'
          : 'unmute'
        : patch.cameraDisabled
          ? 'disable-video'
          : 'enable-video';

    await this.record(actor, target, action, {
      ...(payload.reason ? { reason: payload.reason } : {}),
    });
    return { ok: true };
  }

  /**
   * `FR-7.7` and `FR-7.8` — kick, or kick and record why they cannot come back.
   *
   * The ban row is written **before** the socket closes. The reverse order has a
   * window in which the target's client has already begun reconnecting and the
   * row that would refuse it does not exist yet — a race whose whole prize is
   * defeating the moderation that just happened.
   */
  private async removeParticipant(
    actor: Participant,
    target: Participant,
    payload: ModeratePayload,
    ban: boolean,
  ): Promise<ModerationOutcome> {
    const targetIdentity = identityOf(target);
    let message = payload.reason
      ? `You were removed from this space. Reason: ${payload.reason}`
      : 'You were removed from this space.';
    let guestBan = false;

    if (ban) {
      const row = await this.access.ban({
        accountId: target.identity.accountId,
        fingerprint: target.fingerprint,
        ip: target.ip,
        displayName: target.displayName,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.durationMinutes !== undefined
          ? { durationMinutes: payload.durationMinutes }
          : {}),
        createdBy: identityOf(actor),
        createdByName: actor.displayName,
      });

      if (!row) {
        // Nothing to key the ban on, or no database. Refusing outright is the
        // honest answer: a "ban" that silently degraded to a kick would leave a
        // moderator believing somebody cannot come back.
        return {
          ok: false,
          code: 'internal',
          message: target.identity.accountId
            ? 'Bans need a database, and this server is running without one.'
            : 'This guest offered nothing to identify them by, so a ban would not hold. ' +
              'Kick them, and consider requiring accounts for this space.',
        };
      }

      guestBan = row.kind === 'guest';
      message = row.expiresAt
        ? `You have been banned until ${row.expiresAt.toLocaleString('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}.${payload.reason ? ` Reason: ${payload.reason}` : ''}`
        : `You have been banned from this space.${payload.reason ? ` Reason: ${payload.reason}` : ''}`;
    }

    // Every live session under this identity, not only the one that was named.
    // Somebody with two tabs open who was banned in one of them has not been
    // banned.
    const sessions = ban ? this.world.sessionsOf(targetIdentity) : [target];
    for (const session of sessions) {
      // Read before the kick, not after: `kick` removes the participant, and
      // with them the instance membership this room name is derived from.
      const room = this.roomOf(session);
      await this.media.removeFromRoom(session.sessionId, room);
      this.world.kick(session.sessionId, message, ban);
    }

    await this.record(actor, target, ban ? 'ban' : 'kick', {
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.durationMinutes ? { durationMinutes: payload.durationMinutes } : {}),
      sessions: sessions.length,
      ...(guestBan ? { guestBan: true } : {}),
    });

    // The Phase 7 notes ask for this to be said at the moment it matters rather
    // than left in documentation: a guest ban keys on a cookie and an address,
    // and the real remedy is `FR-6.8`.
    if (guestBan) {
      const connection = this.world.getConnection(actor.sessionId);
      if (connection) {
        this.world.send(connection, Op.ERROR, {
          code: 'forbidden',
          message:
            'Guest bans are weak: clearing site data or using another browser defeats them, ' +
            'and an address can be shared by a whole office. To keep them out for good, ' +
            'require accounts for this space.',
          fatal: false,
        });
      }
    }

    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.16 — blocking
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Personal, and needing nobody's permission beyond being here.
   *
   * `block` is in the matrix at `guest` level, so the capability check is
   * uniform with everything else rather than an exception — but it never refuses
   * anybody who is in the world. The one thing it does refuse is blocking
   * yourself, which is a client bug rather than a request.
   */
  async block(actorSessionId: string, payload: BlockPayload): Promise<ModerationOutcome> {
    const actor = this.world.getParticipant(actorSessionId);
    if (!actor) return { ok: false, code: 'internal', message: 'You are not in this world.' };

    if (!hasCapability(actor.role, 'block')) {
      return REFUSED('You cannot block people here.');
    }

    const target = this.world.getParticipant(payload.targetSessionId);
    if (!target) {
      return { ok: false, code: 'bad-frame', message: 'That person is no longer here.' };
    }
    if (target.sessionId === actor.sessionId) {
      return { ok: false, code: 'bad-frame', message: 'You cannot block yourself.' };
    }

    const actorIdentity = identityOf(actor);
    await this.blocks.set(actorIdentity, identityOf(target), target.displayName, payload.blocked);

    // Projected onto the live world immediately: `FR-7.16` is about media and
    // chat stopping, and the next tick is 50 ms away.
    this.world.applyBlocks(actorSessionId, this.blocks.blockedBy(actorIdentity));

    // Deliberately **not** audited. A block is a personal decision between two
    // people and belongs in nobody's moderation record — `FR-7.19` lists the
    // actions that are recorded, and this is not one of them.
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-7.17 — reporting
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * File a report, with the context captured here rather than sent by the
   * reporter.
   *
   * `DC-7.6` asks for where it happened, and the reporter is the one party with
   * a motive to misstate a fact about the person they are complaining about. The
   * position, the map and the zones all come from the world's own view of the
   * target at this instant.
   */
  async report(actorSessionId: string, payload: ReportPayload): Promise<ModerationOutcome> {
    const actor = this.world.getParticipant(actorSessionId);
    if (!actor) return { ok: false, code: 'internal', message: 'You are not in this world.' };

    if (!hasCapability(actor.role, 'report')) {
      return REFUSED('You cannot file reports here.');
    }

    const target = this.world.getParticipant(payload.targetSessionId);
    if (!target) {
      return { ok: false, code: 'bad-frame', message: 'That person is no longer here.' };
    }
    if (target.sessionId === actor.sessionId) {
      return { ok: false, code: 'bad-frame', message: 'You cannot report yourself.' };
    }

    const filed = await this.reports.file({
      reporterIdentity: identityOf(actor),
      reporterName: actor.displayName,
      targetIdentity: identityOf(target),
      targetName: target.displayName,
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      context: {
        // `DC-7.6` asks for where it happened, and from phase 8 that is a real
        // question: a Space has several Maps, and "in the atrium" is the part of
        // a report a moderator acts on.
        mapId: this.world.mapIdOf(target),
        x: Number(target.transform.x.toFixed(2)),
        y: Number(target.transform.y.toFixed(2)),
        z: Number(target.transform.z.toFixed(2)),
        zoneIds: [...target.zones],
      },
    });

    if (!filed) {
      return {
        ok: false,
        code: 'internal',
        message:
          'This server has no database, so there is nowhere to record a report. ' +
          'Tell whoever runs the space directly.',
      };
    }

    // No audit row, and not because it was forgotten: `FR-7.19` records what
    // *moderators* did, and filing a report is what a user did. The report table
    // is its own record, and marking one reviewed — which is a moderator acting
    // — is what reaches the log.
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-7.4` and `FR-7.3` in one function — the WebSocket half of `NFR-34`.
   *
   * Two questions, and both have to be asked:
   *
   *   **Capability.** Does this role permit the action at all? Read from the one
   *   matrix in `@hubitat/protocol`, the same one `RolesGuard` reads.
   *
   *   **Rank.** May they do it *to this person*? `outranks` is strict, which is
   *   `FR-7.3`'s "admins cannot remove the owner" plus the thing the requirement
   *   does not say and every deployment needs: two admins cannot moderate each
   *   other, and nobody can moderate themselves.
   *
   * A capability check without the rank check is the interesting bug here. It
   * looks correct — the actor really is an admin — and it lets one admin kick
   * every other admin and the owner.
   */
  private authorize(
    actor: Participant,
    target: Participant,
    capability: Capability,
  ): ModerationOutcome | null {
    if (!hasCapability(actor.role, capability)) {
      return REFUSED(
        actor.role === 'guest'
          ? 'Only admins can moderate, and you are not a member of this space.'
          : `Only admins can moderate. You are a ${actor.role} here.`,
      );
    }

    if (actor.sessionId === target.sessionId) {
      return REFUSED('You cannot moderate yourself.');
    }

    if (!outranks(actor.role, target.role)) {
      return REFUSED(
        target.role === 'owner'
          ? 'The owner of this space cannot be moderated.'
          : `You cannot moderate another ${target.role}.`,
      );
    }

    return null;
  }

  /** The LiveKit room one participant is publishing into — phase 8,
   *  `FR-8.10`. Falls back to the base room for somebody the world can no longer
   *  place, which is the pre-phase-8 answer and the only sensible one. */
  private roomOf(participant: Participant): string {
    const instance = this.world.instanceOf(participant.sessionId);
    return instance ? instance.mediaRoom(this.media.room) : this.media.room;
  }

  /** `FR-7.19` — actor, target, action, time and scope, after the fact. */
  private record(
    actor: Participant,
    target: Participant,
    action: AuditAction,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorIdentity: identityOf(actor),
      actorName: actor.displayName,
      action,
      targetIdentity: identityOf(target),
      targetName: target.displayName,
      detail: {
        ...detail,
        // The account id would be redundant with the identity string, but the
        // *role* at the time is not recoverable afterwards: roles change, and a
        // log that cannot say "an admin did this, to a member" loses the part
        // that makes it reviewable.
        actorRole: actor.role,
        targetRole: target.role,
      },
    });
  }
}
