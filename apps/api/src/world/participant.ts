import type { WebSocket } from 'ws';
import {
  accountIdentity,
  guestIdentity,
  type ActivityStatus,
  type AvatarAppearance,
  type ParticipantModeration,
  type PresenceStatus,
  type Role,
  type Transform,
} from '@hubitat/protocol';

/**
 * A participant present in a world instance (DC-1.2).
 *
 * Transient by design: Phase 1 persists nothing, because FR-1.7 requires guest
 * identity to be ephemeral. This object dies with the process, and clients
 * rebuild on reconnect (NFR-25).
 */
export interface Participant {
  readonly sessionId: string;
  /** Instance-local index used on the binary hot path, so a 36-character UUID
   *  is not sent twenty times a second. */
  readonly localId: number;
  displayName: string;

  /**
   * `FR-8.4` — the one Map Instance this participant is in, as `<mapId>#<index>`.
   *
   * Exactly one, always, and never empty after `join` returns. Everything
   * spatial about this person — which zones they can be in, who can hear them,
   * which LiveKit room their voice is on — follows from this field, so a
   * participant without one would be somebody the world has no place for.
   *
   * On the Participant rather than the Connection, like `appearance` and
   * `identity` and for the same reason: a resume rebinds the socket and keeps the
   * person, and reconnecting must put them back in the room they were in rather
   * than at the front door.
   */
  instanceId: string;

  /**
   * `FR-8.6` — true while a map transfer is in flight.
   *
   * The window is short and entirely inside `WorldInstanceService.transfer`: it
   * spans the LiveKit token mint, which is the one step that talks to another
   * process. Three things read it, and each one is a bug that would otherwise be
   * hard to find:
   *
   *   a second transfer is refused, so a portal firing from the tick and a
   *   `NAVIGATE` arriving on the socket cannot both move the same person;
   *
   *   inbound transforms are dropped, because a position reported mid-move
   *   describes the map being left and would place them at those coordinates in
   *   the destination for one tick;
   *
   *   the tick skips them for zones, interest and audience, so they are not
   *   briefly settled against the zones of a room they are leaving.
   */
  transferring: boolean;

  transform: Transform;
  flags: number;
  status: PresenceStatus;
  activity: ActivityStatus;
  lastInputAt: number;
  readonly joinedAt: number;

  /** Rotated on every successful resume; the previous value is consumed. */
  resumeToken: string;
  /**
   * Set when the socket drops. The participant is retained for
   * RESUME_TOKEN_TTL_MS so FR-1.5 can restore them, but is removed from
   * everyone else's view immediately — leaving a ghost standing for a minute
   * would violate FR-1.4's promptness.
   */
  disconnectedAt: number | null;

  /**
   * Zone ids occupied as of the last tick (DC-3.2).
   *
   * On the Participant rather than the Connection because it is a fact about
   * where the person is standing, not about the socket. A resume rebinds the
   * socket and keeps the position, so keeping occupancy here means reconnecting
   * inside a private zone does not re-announce entering it.
   */
  zones: Set<string>;

  /**
   * Epoch ms before which portals are ignored for this participant.
   *
   * The safety net for the re-trigger rule; `PORTAL_EXIT_CLEARANCE_M` is the
   * primary mechanism. Needed when two portals are placed close enough that the
   * arrival clearance of one lands inside the other.
   */
  portalCooldownUntil: number;

  /**
   * What this participant looks like (DC-4.1, FR-4.8).
   *
   * On the Participant, not the Connection, which is what makes "persists with
   * their identity" true across a resume: the socket dies, the person does not,
   * and reconnecting must not put them back in the default outfit. Phase 6 moves
   * this to `profiles.avatar_appearance` and changes nothing else.
   */
  appearance: AvatarAppearance;

  /**
   * When the last emote was accepted, for the `EMOTE_MIN_INTERVAL_MS` throttle.
   *
   * Server-side because anti-spam is a guarantee (Phase 4 Rules). A client is
   * free to grey out its own button; that is a courtesy, and courtesies are not
   * what stops a modified client flooding the room.
   */
  lastEmoteAt: number;

  /**
   * Send times inside the last minute, for `CHAT_RATE_LIMIT_PER_MIN` (phase 5).
   *
   * On the Participant for the same reason `lastEmoteAt` is: a resume rebinds
   * the socket and keeps the person, so a window hanging off the Connection
   * would hand a flooder a clean slate for the cost of a reload.
   */
  chatSendTimes: number[];

  /** The last typing state sent, and when — the courtesy throttle that stops a
   *  client reporting on every keystroke fanning out sixty frames a second to
   *  say nothing new. Never persisted, at any layer (`FR-5.13` in spirit,
   *  `FR-5.10` in fact). */
  lastTypingAt: number;
  lastTypingKey: string;

  /**
   * Who this participant durably is — phase 6, `FR-6.11`, `FR-6.18`.
   *
   * Mutable, and there is exactly one thing that mutates it: a guest upgrading
   * to an account mid-session (`FR-6.7`). Everything else about identity is
   * settled during the handshake, before the participant exists.
   *
   * On the Participant rather than the Connection, like `appearance` and
   * `chatSendTimes` and for the same reason: a resume rebinds the socket and
   * keeps the person. Putting it on the socket would make a reconnecting account
   * holder come back as a guest until they signed in again — with a different
   * durable identity, so their direct-message history would fork.
   */
  identity: ParticipantIdentityState;

  /**
   * `DC-7.1` — what this participant may do here (phase 7, `FR-7.1`).
   *
   * Resolved from `memberships` during the handshake and re-resolved when it
   * changes, rather than carried on the access token: a token lives fifteen
   * minutes, and a role baked into one would keep working for fifteen minutes
   * after it was revoked. `FR-7.3` is not a suggestion.
   *
   * On the Participant, like `identity` and for the same reason: a resume
   * rebinds the socket and keeps the person.
   */
  role: Role;

  /**
   * `FR-7.5`, `FR-7.6` — what a moderator has taken away.
   *
   * The server's copy, and the authoritative one. The SFU holds the same state
   * as a publish permission, but the SFU can be unreachable and the LiveKit
   * token can be reissued; this is what every server-side decision reads, what
   * observers are told, and what the next media grant is built from — which is
   * how `FR-7.5`'s "until unmuted" survives a reconnect.
   */
  moderation: ParticipantModeration;
  /** Who applied it and why, for the self-only `MODERATION_STATE` frame. Kept
   *  beside the flags rather than derived from the audit log: the log is a
   *  database, and this is read on a socket. */
  moderatedBy: string | null;
  moderationReason: string | null;
  moderatedAt: number;

  /**
   * `FR-7.16` — the session ids this participant has blocked, right now.
   *
   * Session ids, not identities, because `resolveAudience` works in the ids the
   * world uses and re-deriving an identity per candidate per tick would put a
   * string concatenation inside the hot loop. The durable set lives in
   * `BlockService`, keyed by identity; this is that set projected onto the people
   * who are currently here, rebuilt when either side of it changes.
   */
  blockedSessions: Set<string>;

  /**
   * `FR-7.8`, the guest half — the signals a guest ban can key on.
   *
   * Weak by nature and documented as such: a fingerprint is a cookie the client
   * volunteers and an address is shared by everybody behind one NAT. Kept on the
   * participant so a ban issued against somebody standing in the room has
   * something to write down, and read for nothing else — neither is an identity
   * and neither is published to anybody.
   */
  fingerprint: string | null;
  ip: string | null;
}

/**
 * The identity a live participant is acting under.
 *
 * `accountId` is null for a guest and the durable id otherwise; `member` is
 * membership of this world instance's Space (`DC-6.4`). Two fields rather than
 * one enum because a signed-in non-member is a real state — somebody who owns
 * their name in a Space that admits visitors.
 */
export interface ParticipantIdentityState {
  kind: 'guest' | 'account';
  accountId: string | null;
  member: boolean;
}

/** The identity every other phase stores. `FR-6.11` in one function: durable for
 *  accounts, session-scoped for guests. */
export function identityOf(participant: {
  sessionId: string;
  identity: ParticipantIdentityState;
}): string {
  return participant.identity.accountId
    ? accountIdentity(participant.identity.accountId)
    : guestIdentity(participant.sessionId);
}

/** Per-connection state. Separate from Participant because a participant can
 *  outlive its socket during the resume window. */
export interface Connection {
  readonly socket: WebSocket;
  sessionId: string | null;
  /** Set once JOIN has been accepted. No other frame is processed before it. */
  joined: boolean;
  /** ws ping/pong liveness (FR-1.6). */
  isAlive: boolean;
  /** The observer's interest set from the last tick — what makes the AOI
   *  hysteresis work. */
  aoi: Set<string>;
  rateWindowStart: number;
  rateCount: number;
  handshakeTimer: NodeJS.Timeout | null;

  /**
   * Signature of the last AUDIENCE frame written to this socket, so an unchanged
   * audience is not re-sent twenty times a second.
   *
   * Per-connection, and cleared on resume: the client rebuilds from nothing after
   * a reconnect, so a signature carried across would suppress the one frame the
   * new socket actually needs.
   */
  audienceSignature: string;

  /**
   * Who this listener could hear and see last tick — the AUDIENCE hysteresis
   * band (`AUDIO_HYSTERESIS_M`).
   *
   * Same shape and same reason as `aoi` above: membership at a threshold has to
   * depend on whether you were already in, or someone standing at exactly 12 m
   * subscribes and unsubscribes a WebRTC track on every tick. The Phase 2 Rules
   * forbid exactly that.
   *
   * Cleared on resume with the signature, for the same reason.
   */
  audible: Set<string>;
  visible: Set<string>;

  /**
   * The client's address, captured at the upgrade — phase 7, `FR-7.8`.
   *
   * On the Connection and not on the Participant, because it is a property of
   * the socket rather than of the person: the same person reconnecting from a
   * café has a different one, and a resume copies the new value over the old.
   * Null when it cannot be determined, which every path treats as "no address to
   * ban on" rather than as an empty string that would match every other one.
   *
   * Read for exactly one purpose. It is not an identity, nothing decides who
   * somebody is from it, and it is never published to anybody.
   */
  ip: string | null;
}

export function generateDisplayName(): string {
  return `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
}
