/**
 * The one link between accounts and the live world — `FR-6.7`, `FR-6.11`.
 *
 * ── Why this exists instead of an import ────────────────────────────────────
 *
 * `WorldModule` imports `AuthModule` so the gateway can resolve a token during
 * the handshake (`FR-6.18`). Auth needs one thing back: when a guest upgrades to
 * an account, the session they are *currently standing in* has to start
 * answering to the new identity — without dropping the socket, because the whole
 * point of `FR-6.7` is that they keep their place. An import in that direction
 * would be a cycle.
 *
 * So the world registers an implementation here at bootstrap and auth calls it.
 * The same shape as `WorldInstanceService.onZoneEvent`, and for the same reason:
 * the module that owns the state publishes a narrow port, and the module that
 * needs it never learns anything else about the world.
 *
 * Unregistered is a normal state, not an error — the account services are
 * exercised by HTTP requests that can arrive before the gateway has booted, and
 * a person who registers without a live session simply has no session to rebind.
 */

import { Injectable } from '@nestjs/common';
import type { AvatarAppearance, PresenceStatus, Role } from '@hubitat/protocol';

/** What a session is told it now is. Mirrors `identityStateSchema` on the wire. */
export interface SessionIdentity {
  kind: 'guest' | 'account';
  accountId?: string;
  /** `DC-6.4` — of the Space this world instance belongs to. */
  member: boolean;
  displayName: string;
  appearance: AvatarAppearance;
  statusPreference?: PresenceStatus;
  /**
   * Phase 7, `FR-7.1`. Optional because the two callers know it at different
   * times: a profile update does not change a role and has no reason to look one
   * up, while an upgrade that redeemed an invite has just created the membership
   * the role lives on. Absent, the world derives it from `member`, which is the
   * same answer for a row that has only just come into existence.
   */
  role?: Role;
}

/** What a guest was wearing at the moment they decided to become an account. */
export interface GuestSessionView {
  sessionId: string;
  displayName: string;
  appearance: AvatarAppearance;
}

export interface WorldIdentityPort {
  /**
   * Look a live guest up by their **resume token**, never by session id.
   *
   * A session id is broadcast to everyone in range on `PARTICIPANT_ADD`; the
   * resume token is held only by its owner. Accepting the former here would let
   * anybody in the room register an account carrying a stranger's name and look.
   */
  readGuestSession(resumeToken: string): GuestSessionView | null;

  /** Rebind one live session and tell it. Returns false if it has since gone. */
  bindSession(sessionId: string, identity: SessionIdentity): boolean;

  /** Push a profile change to every live session already bound to this account —
   *  `FR-6.10`, without waiting for "the next time the user appears". Returns
   *  how many were updated. */
  refreshAccountSessions(accountId: string, identity: SessionIdentity): number;
}

@Injectable()
export class IdentityBridge {
  private port: WorldIdentityPort | null = null;

  /** Called once, by the gateway, at application bootstrap. */
  register(port: WorldIdentityPort): void {
    this.port = port;
  }

  readGuestSession(resumeToken: string): GuestSessionView | null {
    return this.port?.readGuestSession(resumeToken) ?? null;
  }

  bindSession(sessionId: string, identity: SessionIdentity): boolean {
    return this.port?.bindSession(sessionId, identity) ?? false;
  }

  refreshAccountSessions(accountId: string, identity: SessionIdentity): number {
    return this.port?.refreshAccountSessions(accountId, identity) ?? 0;
  }
}
