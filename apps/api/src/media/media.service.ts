/**
 * LiveKit access tokens (ADR 0006).
 *
 * The SFU relays media; it does not decide who may publish or who may hear whom.
 * Both of those are ours: publish permissions are baked into the token here, and
 * subscription is driven by the AUDIENCE frame the world tick produces.
 *
 * ── Why the token travels inside JOINED ─────────────────────────────────────
 *
 * The alternative is a REST endpoint the client calls after joining. That needs
 * a credential to authenticate, and until Phase 6 there is none — the only thing
 * proving who a client is *is* the WebSocket the server itself handed a session
 * to. Minting the token on that socket removes the question entirely, and a
 * resume issues a fresh JOINED, which is exactly when a fresh token is wanted.
 *
 * ── Why absence is a supported state ────────────────────────────────────────
 *
 * Phase 1's development flow runs without Docker, so there is no LiveKit to talk
 * to. `grant()` returns null rather than throwing, the JOINED payload carries
 * null, and the client shows media as unavailable while presence carries on.
 * FR-2.5 requires a device failure not to break presence; a missing SFU deserves
 * the same treatment for the same reason.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { MediaGrant } from '@hubitat/protocol';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';

/**
 * `FR-7.5` / `FR-7.6` — what a participant is currently permitted to publish.
 *
 * Two independent flags rather than one "moderated" boolean, because the two
 * requirements are separate: a moderator can silence somebody's microphone and
 * leave their camera alone, and the reverse. Camera and screen share are one
 * flag because they are one permission on the SFU and because "you may show your
 * face but not your desktop" is not a distinction the phase asks for.
 */
export interface PublishPermission {
  micMuted: boolean;
  cameraDisabled: boolean;
}

export const PUBLISH_ALL: PublishPermission = { micMuted: false, cameraDisabled: false };

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly config: RuntimeConfig = loadConfig();

  /**
   * The admin API, phase 7.
   *
   * Built lazily and cached: constructing it is cheap, but doing so at boot on a
   * server with no LiveKit configured would create a client pointed at an empty
   * URL that every later call would fail against — and phase 1's development
   * flow is exactly that server.
   */
  private rooms: RoomServiceClient | null = null;

  constructor() {
    if (this.enabled) {
      this.logger.log(
        `Media enabled — LiveKit at ${this.config.livekitUrl}, clients told ` +
          `${this.config.livekitPublicUrl}, room "${this.room}"`,
      );
    } else {
      this.logger.warn(
        'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are unset — voice and video are ' +
          'disabled. Presence and movement are unaffected.',
      );
    }
  }

  get enabled(): boolean {
    return Boolean(
      this.config.livekitUrl && this.config.livekitApiKey && this.config.livekitApiSecret,
    );
  }

  /**
   * The base room name — phase 8 makes it a prefix rather than the whole answer.
   *
   * `MapInstance.mediaRoom` derives one room per instance from it, because
   * `FR-8.10` requires two copies of a Map to be unable to hear each other and
   * separate rooms is what makes that structural rather than a subscription
   * filter somebody has to get right. Kept as the base so a deployment that set
   * `LIVEKIT_ROOM` still recognises its own traffic in LiveKit's logs.
   */
  get room(): string {
    return this.config.livekitRoom;
  }

  /**
   * A token for one participant, or null when media is not configured.
   *
   * Identity is the session id, not the display name: names are neither unique
   * nor stable (FR-1.8), and the client has to match LiveKit participants back
   * to world participants to position their audio. The session id is the only
   * value that is both.
   *
   * `canSubscribe` is granted unconditionally and is not the access control —
   * the client subscribes per track from the AUDIENCE frame, and a client that
   * ignored it could only reach people the server had already told it about.
   *
   * ── Phase 7: the token carries the moderation state ─────────────────────────
   *
   * `permission` is the participant's *current* force-mute state, and baking it
   * into the token is what makes `FR-7.5`'s "until unmuted" survive a reconnect.
   * Without it, a muted participant would drop their socket, be issued a fresh
   * token with `canPublish: true`, and be back — which turns a moderation action
   * into a suggestion with a ten-second workaround.
   */
  async grant(
    sessionId: string,
    displayName: string,
    permission: PublishPermission = PUBLISH_ALL,
    /**
     * Phase 8, `FR-8.10` — which room, because there is now more than one.
     *
     * A required-in-practice argument with a default, so every call site has to
     * have thought about it while nothing is broken for a caller that has not.
     * The Phase 8 notes name reusing a token across rooms as sharp edge nº2: a
     * LiveKit grant names a room, and carrying the old one into a new one fails
     * as what looks like a media bug rather than an auth bug. Every transfer
     * mints a fresh grant for the destination.
     */
    room: string = this.room,
  ): Promise<MediaGrant | null> {
    if (!this.enabled) return null;

    const ttl = this.config.livekitTokenTtlSeconds;

    const token = new AccessToken(this.config.livekitApiKey, this.config.livekitApiSecret, {
      identity: sessionId,
      name: displayName,
      ttl,
    });

    const sources = permittedSources(permission);

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: sources.length > 0,
      // An empty list means "every source", which is the unmoderated case; a
      // non-empty one is exhaustive, which is what makes a mic-only mute leave
      // the camera working.
      ...(sources.length > 0 && sources.length < ALL_SOURCES.length
        ? { canPublishSources: sources }
        : {}),
      canSubscribe: true,
      canPublishData: false,
    });

    try {
      return {
        // The browser's address for the SFU, which under Compose is not the
        // server's. See `livekitPublicUrl`.
        url: this.config.livekitPublicUrl,
        token: await token.toJwt(),
        room,
        identity: sessionId,
        expiresInSeconds: ttl,
      };
    } catch (error) {
      // A token that cannot be minted must not take the join down with it.
      // Losing voice is bad; losing the world because voice is misconfigured is
      // worse, and the log line says which one happened.
      this.logger.error(`Could not mint a LiveKit token: ${(error as Error).message}`);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Moderation — phase 7
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-7.5`, `FR-7.6` — force-mute, and make it stay.
   *
   * ── This needs two calls, and one of them alone is a bug ────────────────────
   *
   * The Phase 7 implementation notes name it directly, and it is worth restating
   * because the failure is invisible from the server:
   *
   *   `mutePublishedTrack` **stops it now**. It mutes the track that is currently
   *   published, and the target's client is told. On its own it lasts until the
   *   client calls `setMicrophoneEnabled(true)`, which is one button away and
   *   which the target is fairly likely to press, because from their side it
   *   looks like their microphone glitched.
   *
   *   `updateParticipant(..., { permission })` **stops it staying stopped**. It
   *   revokes the permission to publish that source at the SFU, so the client's
   *   own unmute is refused by something the client does not control. This is the
   *   half that makes `FR-7.5`'s "cannot transmit until unmuted or permitted"
   *   true rather than aspirational.
   *
   * Both, always, and in that order: permissions first would let a track already
   * in flight keep flowing until the client noticed.
   *
   * Returns whether the SFU was actually told. False means media is not
   * configured — the world-side flags still apply, so the participant is muted in
   * everybody's presence list and in every server-side decision, and the only
   * thing missing is the half that needs an SFU to exist.
   */
  async applyPublishPermission(
    sessionId: string,
    permission: PublishPermission,
    /** Phase 8 — the room they are actually in. A mute applied to the base room
     *  name would silence nobody in a Space with more than one Map, and would do
     *  it without an error. */
    room: string = this.room,
  ): Promise<boolean> {
    const rooms = this.admin();
    if (!rooms) return false;

    try {
      // 1 — stop what is being published right now.
      const participant = await rooms.getParticipant(room, sessionId).catch(() => null);
      if (participant) {
        for (const track of participant.tracks) {
          const stop =
            (permission.micMuted && track.source === TrackSource.MICROPHONE) ||
            (permission.cameraDisabled &&
              (track.source === TrackSource.CAMERA ||
                track.source === TrackSource.SCREEN_SHARE ||
                track.source === TrackSource.SCREEN_SHARE_AUDIO));
          if (!stop || track.muted) continue;
          await rooms.mutePublishedTrack(room, sessionId, track.sid, true);
        }
      }

      // 2 — stop it coming back. Unmuting the track is deliberately *not* done
      // here on the lifting path: restoring the permission is the moderator's
      // act, and turning somebody's microphone back on for them is not. The
      // client re-enables it when its owner chooses to.
      const sources = permittedSources(permission);
      await rooms.updateParticipant(room, sessionId, {
        permission: {
          canPublish: sources.length > 0,
          canPublishSources: sources.length < ALL_SOURCES.length ? sources : [],
          canSubscribe: true,
          canPublishData: false,
          hidden: false,
          recorder: false,
          canUpdateMetadata: false,
          agent: false,
          canSubscribeMetrics: false,
        },
      });
      return true;
    } catch (error) {
      // A participant who has not connected to the SFU — nobody has unmuted yet,
      // or media is down — is not an error worth failing the moderation over.
      // The world-side flags have already been applied by the caller and the
      // token they are issued on their next join carries the same state, so the
      // mute holds either way.
      this.logger.warn(
        `Could not apply publish permissions for ${sessionId}: ${(error as Error).message}. ` +
          `The world-side mute still applies and their next token will carry it.`,
      );
      return false;
    }
  }

  /**
   * `FR-7.7` — remove them from the SFU as well as from the world.
   *
   * Both halves are needed and neither is sufficient. Closing the WebSocket ends
   * their presence; it does not end an audio track that is already flowing
   * through the SFU, and a kicked participant who can still be heard has not been
   * kicked. Removing them from the room without closing the socket leaves an
   * avatar standing there in silence.
   */
  async removeFromRoom(sessionId: string, room: string = this.room): Promise<void> {
    const rooms = this.admin();
    if (!rooms) return;
    try {
      await rooms.removeParticipant(room, sessionId);
    } catch (error) {
      // Almost always "participant not found", which is the ordinary case:
      // somebody who never turned their microphone on was never in the LiveKit
      // room to begin with.
      this.logger.debug(`removeParticipant(${sessionId}): ${(error as Error).message}`);
    }
  }

  /** Built on first use rather than at boot — see the field. */
  private admin(): RoomServiceClient | null {
    if (!this.enabled) return null;
    if (!this.rooms) {
      // The server's own address for the SFU, not the browser's: this is a
      // server-to-server call, and under Compose `LIVEKIT_PUBLIC_URL` names a
      // published port that the api container cannot necessarily reach.
      const host = this.config.livekitUrl.replace(/^ws/, 'http');
      this.rooms = new RoomServiceClient(
        host,
        this.config.livekitApiKey,
        this.config.livekitApiSecret,
      );
    }
    return this.rooms;
  }
}

const ALL_SOURCES = [
  TrackSource.MICROPHONE,
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
] as const;

/**
 * Which track sources a participant may publish, given what has been taken away.
 *
 * `FR-7.5` and `FR-7.6` are separate requirements, so a mic mute must leave the
 * camera alone. LiveKit expresses that as an exhaustive list rather than as a
 * set of denials, which is why this is computed rather than subtracted at the
 * call site: an empty list means "all sources", and getting that backwards would
 * silently un-mute everybody it was applied to.
 */
function permittedSources(permission: PublishPermission): TrackSource[] {
  return ALL_SOURCES.filter((source) => {
    if (source === TrackSource.MICROPHONE) return !permission.micMuted;
    return !permission.cameraDisabled;
  });
}
