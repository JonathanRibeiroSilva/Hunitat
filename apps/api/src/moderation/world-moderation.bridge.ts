/**
 * The one link from administration to the live world — phase 7.
 *
 * The same shape and the same reason as `IdentityBridge` in phase 6:
 * `WorldModule` imports `ModerationModule` so the gateway can evaluate access
 * policy during a handshake, and moderation needs a handful of things back. An
 * import in that direction would be a cycle, so the world registers an
 * implementation here at bootstrap and the HTTP controllers call it.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * `FR-7.10` — "moderation actions take effect promptly and reliably across the
 * target's session" — is the whole of it. Every operation here exists because a
 * durable change has a live consequence that must not wait for a rejoin:
 *
 *   a ban issued from the panel     → the target is removed now, not next time
 *   a role change                   → their capabilities change now
 *   an access policy that locks     → nothing, deliberately (`FR-7.11` is a door)
 *
 * Unregistered is a normal state, not an error. The controllers can be reached
 * by an HTTP request that arrives before the gateway has finished booting, and a
 * ban on somebody who is not connected has no session to reach either way.
 */

import { Injectable } from '@nestjs/common';
import type { Role } from '@hubitat/protocol';

/** One live participant, as an administrative caller needs to see them. */
export interface LiveParticipantView {
  sessionId: string;
  displayName: string;
  identity: string;
  accountId: string | null;
  fingerprint: string | null;
  ip: string | null;
}

export interface WorldModerationPort {
  /** Every live session acting under a durable identity. Usually zero or one;
   *  more than one is somebody with two tabs open, and a ban has to reach both. */
  sessionsOf(identity: string): LiveParticipantView[];

  /** Everyone connected. The moderation panel marks members who are here, so an
   *  admin can tell "kick" from "ban" without guessing. */
  connected(): LiveParticipantView[];

  /** `FR-7.7`, `FR-7.8` — remove from the instance now. */
  kick(sessionId: string, reason: string, banned: boolean): void;

  /** `FR-7.1` — a role change reaching a session that is already in the world,
   *  so the panel and the presence list stop disagreeing about who moderates. */
  refreshRole(accountId: string, role: Role): void;

  /** `FR-7.14` — how many are connected, for the capacity check at the door. */
  occupancy(): number;
}

@Injectable()
export class WorldModerationBridge {
  private port: WorldModerationPort | null = null;

  /** Called once, by the gateway, at application bootstrap. */
  register(port: WorldModerationPort): void {
    this.port = port;
  }

  sessionsOf(identity: string): LiveParticipantView[] {
    return this.port?.sessionsOf(identity) ?? [];
  }

  connected(): LiveParticipantView[] {
    return this.port?.connected() ?? [];
  }

  kick(sessionId: string, reason: string, banned: boolean): void {
    this.port?.kick(sessionId, reason, banned);
  }

  refreshRole(accountId: string, role: Role): void {
    this.port?.refreshRole(accountId, role);
  }

  occupancy(): number {
    return this.port?.occupancy() ?? 0;
  }
}
