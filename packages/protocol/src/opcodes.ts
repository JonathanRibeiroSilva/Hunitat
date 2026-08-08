/**
 * Frame opcodes. See specs/protocol/wire-protocol.md.
 *
 * The first byte of every WebSocket message is one of these.
 * Below 0x80 → binary payload. At or above 0x80 → UTF-8 JSON payload.
 * A receiver dispatches on the first byte and never has to guess.
 *
 * Opcodes are STABLE. New frames take new numbers; existing ones are never
 * reassigned. Binary layouts are never changed in place — a changed layout
 * gets a new opcode.
 */

export const Op = {
  // ── Binary, client → server ───────────────────────────────────────────────
  TRANSFORM: 0x01,

  // ── Binary, server → client ───────────────────────────────────────────────
  TRANSFORM_BATCH: 0x02,

  // ── JSON, client → server ─────────────────────────────────────────────────
  JOIN: 0x80,
  LEAVE: 0x81,
  SET_STATUS: 0x82,
  EMOTE: 0x83,
  CHAT_SEND: 0x84,
  TYPING: 0x85,
  /**
   * Phase 4. A separate frame rather than a field on `SET_STATUS`, because the
   * two answer different questions — "am I available" changes many times an
   * hour, "what do I look like" a few times ever — and because `FR-4.7` requires
   * a change to take effect without leaving the world, which means it cannot
   * ride on `JOIN`.
   */
  SET_APPEARANCE: 0x86,
  /**
   * Phase 5. Ask for a persistent channel's recent history (`FR-5.12`).
   *
   * A request rather than an unsolicited push for every channel, because the
   * direct channels a participant might open are one per person in the world and
   * pushing all of them at join would send a roster's worth of conversations
   * nobody asked to read.
   */
  CHAT_HISTORY: 0x87,
  /** Phase 5. Move the last-seen marker for a channel (`FR-5.16`). */
  CHAT_READ: 0x88,
  /**
   * Phase 7 — one moderation act on one live participant (`FR-7.5`–`FR-7.9`).
   *
   * On the socket rather than over HTTP because every one of these is about a
   * *session*: the target is somebody standing in the room, and `FR-7.10`
   * requires the effect now rather than on their next join.
   *
   * It is also the frame the Phase 7 implementation notes warn about by name.
   * An unguarded handler here is a complete bypass of every role check in the
   * product, which is why `NFR-34` names the WebSocket path explicitly.
   */
  MODERATE: 0x89,
  /** Phase 7, `FR-7.16` / `FR-7.18` — a personal block. Its own frame because it
   *  needs no capability and belongs in nobody's audit log. */
  BLOCK: 0x8a,
  /** Phase 7, `FR-7.17` — file a report. The context (`DC-7.6`) is captured on
   *  the server, so this carries only who and why. */
  REPORT: 0x8b,
  /**
   * Phase 8, `FR-8.13` / `FR-8.14` — take me somewhere else in this Space.
   *
   * On the socket rather than over HTTP, for the reason `MODERATE` is: the
   * subject is a *session*, the effect is immediate, and the answer is a
   * `MAP_TRANSFER` written to this same connection. A REST call would have to
   * find the world from a controller and would arrive without the connection
   * that proves who is asking.
   *
   * The client names a destination; it never names the instance it will get.
   * Capacity and grouping (`FR-8.8`, `FR-8.9`) are the server's decision, and a
   * client that could choose would be a client that could defeat a capacity
   * limit by asking.
   */
  NAVIGATE: 0x8c,
  /** Phase 8, `FR-8.12` — ask for the Space directory now rather than waiting
   *  for the next push. Sent when a client opens the panel. */
  DIRECTORY: 0x8d,

  // ── JSON, server → client ─────────────────────────────────────────────────
  JOINED: 0x90,
  SNAPSHOT: 0x91,
  PARTICIPANT_ADD: 0x92,
  PARTICIPANT_REMOVE: 0x93,
  PARTICIPANT_UPDATE: 0x94,
  FORCE_TRANSFORM: 0x95,
  ERROR: 0x96,
  EMOTE_PLAY: 0x97,
  CHAT_MESSAGE: 0x98,
  TYPING_STATE: 0x99,
  AUDIENCE: 0x9a,
  ZONE_EVENT: 0x9b,
  /** Phase 5. The reply to `CHAT_HISTORY`, and the only frame that carries more
   *  than one message. */
  CHAT_HISTORY_RESULT: 0x9c,
  /**
   * Phase 5, `FR-5.8` — a send that will never be delivered.
   *
   * Its own frame rather than an `ERROR` code, because it must name the
   * `tempId` it refers to. The sender has an optimistic message on screen; a
   * generic error cannot say *which* one failed, and a client that guessed
   * would mark the wrong one — or, worse, leave a message looking sent that
   * nobody received.
   */
  CHAT_REJECT: 0x9d,
  /**
   * Phase 6, `FR-6.7` / `FR-6.18` — who the server now believes this session is.
   *
   * Sent unprompted, and only when the answer *changes* mid-connection, which
   * happens exactly once: a guest upgrades to an account over HTTP while their
   * socket stays open. `JOINED` already states the identity a connection starts
   * with, so this frame is not a duplicate of it — it is the one thing `JOINED`
   * cannot express, because `JOINED` has already been sent.
   *
   * Its own frame rather than a field on `PARTICIPANT_UPDATE` for the reason
   * `chatChannels` is restricted there: this is about the viewer, never about
   * somebody they can see, and a field that is only ever valid for self on a
   * frame that is usually about others is a leak waiting for a refactor.
   */
  IDENTITY: 0x9e,
  /**
   * Phase 7, `FR-7.5` — what a moderated participant is told about themself.
   *
   * Sent only to the connection it describes. Observers learn *that* somebody is
   * muted from `PARTICIPANT_UPDATE`; only the person it was done to is told who
   * did it and why, because publishing that to the room turns every mute into an
   * announcement.
   *
   * Same reasoning as `IDENTITY` and `chatChannels`: a field that is only ever
   * valid for self, on a frame that is usually about others, is a leak waiting
   * for a refactor.
   */
  MODERATION_STATE: 0x9f,
  /**
   * Phase 8, `FR-8.6` — you are now in a different Map.
   *
   * The only frame in the protocol that re-establishes a whole world without a
   * reconnect. It is written once, at the end of one orchestrated server-side
   * method, and by the time a client reads it the move has already happened in
   * full: instance membership, LiveKit room, transform and area of interest have
   * all changed together. The Phase 8 notes name a partial move as the phase's
   * sharpest edge — a participant present in two places or in none — and one
   * frame at the end is what makes that unrepresentable rather than merely
   * avoided.
   *
   * Followed immediately by `SNAPSHOT`, exactly as `JOINED` is.
   */
  MAP_TRANSFER: 0xa0,
  /** Phase 8, `FR-8.12` / `DC-8.5` — which Maps exist, how busy each one is,
   *  and (for members) who is where. Pushed on change, and on request. */
  SPACE_DIRECTORY: 0xa1,
  /**
   * Phase 9, `FR-9.20` — the Map you are standing in has been republished.
   *
   * A notification, deliberately, and not a command. The requirement is that
   * publishing "handles participants currently in the Map gracefully… not a hard
   * break", and a client that tore the world down mid-sentence would be exactly
   * that. The running instance keeps the document it was allocated with; the
   * next one reads the new version; the participant is offered a reload they
   * choose to take.
   */
  MAP_UPDATED: 0xa2,
} as const;

export type Opcode = (typeof Op)[keyof typeof Op];

/** Opcodes at or above this threshold carry JSON; below it, packed binary. */
export const JSON_OPCODE_THRESHOLD = 0x80;

export function isJsonOpcode(op: number): boolean {
  return op >= JSON_OPCODE_THRESHOLD;
}

/** WebSocket subprotocol. A mismatch is refused at handshake with a clear reason,
 *  rather than failing later as a mysterious decode error. */
export const PROTOCOL_VERSION = 'hubitat.v1';
