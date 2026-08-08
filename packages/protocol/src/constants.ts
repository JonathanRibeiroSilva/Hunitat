/**
 * Tuning defaults — the single source for every value the phase specs call
 * "configurable" and never quantify.
 *
 * Mirrors specs/conventions/tuning-defaults.md. The server overrides these from
 * environment variables; nothing may hard-code them at a call site, because
 * several phases require adjustment without code changes to feature logic
 * (Phase 1 Rules, FR-2.7, Phase 5 Rules, NFR-39).
 */

export const TUNING = {
  // ── Realtime & replication (phase 1) ──────────────────────────────────────
  TICK_RATE_HZ: 20,
  CLIENT_SEND_RATE_HZ: 20,
  INTERPOLATION_BUFFER_MS: 100,

  /**
   * Enter and exit radii are a PAIR. The gap between them is the hysteresis that
   * prevents the boundary flapping FR-1.17 and the Phase 1 Rules forbid.
   * Setting them equal reintroduces the bug.
   */
  AOI_ENTER_RADIUS_M: 25,
  AOI_EXIT_RADIUS_M: 30,
  AOI_CELL_SIZE_M: 25,

  PING_INTERVAL_MS: 10_000,
  /**
   * Must exceed 2 x PING_INTERVAL_MS, or one dropped pong evicts a healthy
   * session. The heartbeat terminates a socket that misses a full ping cycle,
   * so worst-case detection is 2 x the interval; this is the documented outer
   * bound, with headroom.
   */
  STALE_SESSION_TIMEOUT_MS: 30_000,
  IDLE_TIMEOUT_MS: 60_000,
  RESUME_TOKEN_TTL_MS: 60_000,
  MAX_BUFFERED_BYTES: 65_536,

  // ── Movement (phases 1, 4) ────────────────────────────────────────────────
  WALK_SPEED_MPS: 3.0,
  RUN_SPEED_MPS: 6.0,
  ACCELERATION_MPS2: 25.0,
  JUMP_HEIGHT_M: 0.9,
  GRAVITY_MPS2: -9.81,
  CHARACTER_STEP_OFFSET_M: 0.35,
  CHARACTER_SLOPE_LIMIT_DEG: 45,
  CHARACTER_SNAP_TO_GROUND_M: 0.2,

  // ── Avatar & camera (see specs/conventions/coordinates-and-units.md) ──────
  AVATAR_HEIGHT_M: 1.7,
  AVATAR_RADIUS_M: 0.3,
  CAMERA_TARGET_HEIGHT_M: 1.6,
  CAMERA_DISTANCE_M: 4.0,
  CAMERA_MIN_DISTANCE_M: 1.5,
  CAMERA_MAX_DISTANCE_M: 8.0,
  CAMERA_FOV_DEG: 60,
  CAMERA_PITCH_MIN_DEG: -5,
  CAMERA_PITCH_MAX_DEG: 60,
  CAMERA_PITCH_DEFAULT_DEG: 15,
  CAMERA_NEAR_M: 0.1,
  CAMERA_FAR_M: 500,

  // ── Spatial media (phase 2) ───────────────────────────────────────────────
  MAX_AUDIBLE_DISTANCE_M: 12,
  MAX_VISIBLE_DISTANCE_M: 8,
  AUDIO_HYSTERESIS_M: 2,
  AUDIO_REF_DISTANCE_M: 1.0,
  AUDIO_ROLLOFF_FACTOR: 1.2,
  MAX_CONCURRENT_AUDIO: 12,
  MAX_CONCURRENT_VIDEO: 6,

  // ── Zones (phase 3) ───────────────────────────────────────────────────────
  ZONE_HYSTERESIS_M: 0.3,
  PORTAL_COOLDOWN_MS: 1_500,
  PORTAL_EXIT_CLEARANCE_M: 1.5,
  /**
   * Inside a private zone or a spotlight, distance stops attenuating: the whole
   * point of both is that they defeat proximity. 1.0 means "as if standing next
   * to them" — lower it only to keep a broadcast from overpowering local
   * conversation (FR-3.12, FR-3.8).
   */
  SPOTLIGHT_GAIN: 1.0,
  PRIVATE_ZONE_GAIN: 1.0,

  // ── Avatars (phase 4) ─────────────────────────────────────────────────────
  EMOTE_MIN_INTERVAL_MS: 2_000,
  EMOTE_MAX_DURATION_MS: 5_000,
  ANIMATION_CROSSFADE_MS: 200,
  RUN_ANIMATION_THRESHOLD_MPS: 4.0,
  NAMEPLATE_FADE_START_M: 15,
  NAMEPLATE_HIDE_M: 25,

  // ── Chat (phase 5) ────────────────────────────────────────────────────────
  /**
   * Defaults to MAX_AUDIBLE_DISTANCE_M and should track it. The Phase 5 Rules
   * require "people I can talk to" to match "people my local chat reaches".
   */
  CHAT_NEARBY_RADIUS_M: 12,
  CHAT_MAX_MESSAGE_CHARS: 2_000,
  TYPING_INDICATOR_TTL_MS: 5_000,
  /** FR-5.12 — how far back a persistent channel can be scrolled. */
  CHAT_HISTORY_LIMIT: 200,
  /** FR-5.11 — how long stored history is kept before it is swept. */
  CHAT_HISTORY_RETENTION_DAYS: 90,
  /**
   * Server-side send ceiling. Separate from MAX_INBOUND_MSGS_PER_SEC because
   * that one protects the socket and this one protects the room: sixty frames a
   * second is a fine transform rate and an intolerable chat rate.
   */
  CHAT_RATE_LIMIT_PER_MIN: 30,

  // ── Accounts and sessions (phase 6) ───────────────────────────────────────
  /**
   * `FR-6.17`. Short on purpose — the access token is a bearer credential with
   * no revocation list, so its lifetime *is* the revocation window. Fifteen
   * minutes is the ADR 0011 figure; anything much longer makes a Phase 7 ban
   * take effect at the sitter's convenience rather than the moderator's.
   *
   * The cost is that it expires mid-meeting, which is why the client has a
   * refresh-and-retry wrapper covering both HTTP and the WebSocket rejoin.
   */
  ACCESS_TOKEN_TTL_MIN: 15,
  /** `FR-6.17` — "stay logged in". The refresh token is rotated on every use,
   *  so this is how long *inactivity* is tolerated, not how long a stolen token
   *  stays useful. */
  REFRESH_TOKEN_TTL_DAYS: 30,
  /**
   * `FR-6.3`. A length floor and nothing else: no character-class rules, which
   * NIST 800-63B has recommended against since 2017 because they push people
   * towards `Password1!` and away from length.
   */
  PASSWORD_MIN_LENGTH: 12,
  /**
   * argon2id at the OWASP-recommended floor (ADR 0011). Lowering any of the
   * three weakens `FR-6.3`; raising memory is the most effective change if the
   * hardware allows it.
   */
  ARGON2_MEMORY_KIB: 19_456,
  ARGON2_ITERATIONS: 2,
  ARGON2_PARALLELISM: 1,
  /** `FR-6.14` — one week. Applied when an invite is created without an explicit
   *  expiry, because "no bound at all" is the one thing the requirement rules
   *  out. */
  INVITE_DEFAULT_TTL_HOURS: 168,
  /** `FR-6.5` — a reset link is a password equivalent in an inbox. Thirty
   *  minutes is long enough to walk to another machine and short enough that a
   *  forwarded mail is usually already dead. */
  RESET_TOKEN_TTL_MIN: 30,
  /**
   * How long after a refresh token is spent a second presentation is read as a
   * client racing itself rather than as theft.
   *
   * **The one value here with no environment variable**, deliberately. Every
   * other number in this file is a tuning knob; this is a security trade-off
   * with one defensible answer, and an operator who widened it to an hour would
   * have switched off reuse detection without meaning to.
   *
   * It exists because two browser tabs restored at the same instant read the
   * same cookie out of the shared jar and both refresh, and the second arrives
   * before the first one's `Set-Cookie` has been stored. Without leeway that is
   * indistinguishable from a stolen token, and opening two tabs signs you out of
   * both. See `TokenService.rotate` for the full reasoning.
   */
  REFRESH_REUSE_LEEWAY_MS: 10_000,

  // ── Capacity, permissions and moderation (phase 7) ────────────────────────
  /**
   * `FR-7.14` — how many participants one map admits.
   *
   * 50 is the figure `NFR-1` was designed and verified against; above it nothing
   * has been measured. `FR-7.14` allows "refuse **or** route to overflow", and
   * the Phase 7 Rules require that choice to agree with `FR-8.8` rather than be
   * made twice. There is one instance until phase 8 builds more, so refusing is
   * the only honest implementation of it here — and the refusal names capacity,
   * so it does not read as a fault.
   */
  DEFAULT_MAP_CAPACITY: 50,
  /**
   * `FR-7.8` for a guest, who has no durable identity to key on.
   *
   * How long the fingerprint cookie a guest ban keys on survives. Long, because a
   * ban that outlives its own identifier is not a ban — and weak either way,
   * which the Phase 7 notes require to be documented rather than solved: clearing
   * cookies defeats it, a different browser defeats it, and the real remedy for a
   * disruptive guest is requiring accounts (`FR-6.8`).
   */
  GUEST_FINGERPRINT_TTL_DAYS: 365,
  /**
   * How many audit rows and reports a moderation screen is handed at once.
   *
   * A cap rather than a page size, because `FR-7.20` asks for review rather than
   * for archaeology, and an unbounded read of an append-only table is a table
   * scan that grows for the life of the deployment.
   */
  MODERATION_PAGE_SIZE: 100,

  // ── Spaces, maps and instancing (phase 8) ─────────────────────────────────
  /**
   * `FR-8.11` — how long an instance stays empty before it is reclaimed.
   *
   * Two minutes, and the delay is the mechanism rather than a detail of it. An
   * instance that momentarily empties as the last two people walk through a
   * portal must not be torn down and immediately recreated by the third person
   * arriving a second later: instance ids are stable and are quoted in the
   * directory, so a reap-and-recreate cycle hands the same id to a different set
   * of people while somebody is looking at the old one.
   *
   * Instance 0 is never reaped at all, which is what keeps a Map's identity
   * stable across a quiet night.
   */
  INSTANCE_REAP_AFTER_MS: 120_000,
  /**
   * `FR-8.8` — the ceiling on how far one Map may spill.
   *
   * Eight copies of a room at `DEFAULT_MAP_CAPACITY` each is 400 people in one
   * Map, which is well past anything `NFR-1` was verified against; the number is
   * a backstop against an unbounded allocation loop rather than a target. Past
   * it, entry is refused with the capacity message — an eleventh copy of a room
   * is a room nobody can find anybody in.
   */
  MAX_INSTANCES_PER_MAP: 8,
  /**
   * How often the Space directory is recomputed and pushed (`FR-8.12`).
   *
   * Not on the tick. Per-map occupancy changes when somebody joins, leaves or
   * transfers — a few times a minute — and recomputing a document that lists
   * every Map twenty times a second to send it none of those times is work spent
   * to produce an unchanged string. One second is faster than anybody can act on
   * a count, and the frame is still suppressed when its signature is unchanged.
   */
  DIRECTORY_REFRESH_MS: 1_000,

  // ── Editor and asset pipeline (phase 9) ───────────────────────────────────
  /**
   * `FR-9.12` — the largest upload accepted, in bytes.
   *
   * Checked twice and refused early both times: the presign call refuses a
   * declared size over this, and object storage refuses a body over it. 64 MB is
   * generous for a room's worth of geometry and small enough that a mistaken
   * upload of a video file is answered in milliseconds rather than minutes.
   */
  ASSET_MAX_BYTES: 100 * 1024 * 1024,
  /**
   * `FR-9.12`, `FR-9.13` — the triangle ceiling for one uploaded model.
   *
   * `NFR-11` budgets the whole scene; this is the per-asset share of it, and it
   * is what stops one photogrammetry scan from making a Map unenterable on a
   * laptop. Enforced in the worker, because it is only knowable after parsing.
   */
  ASSET_MAX_TRIANGLES: 500_000,
  /** `FR-9.12` — a texture larger than this is rejected rather than downscaled:
   *  a 8192² PNG in a room is a GPU memory problem, and silently resizing
   *  somebody's artwork is a surprise. */
  ASSET_MAX_TEXTURE_PX: 2_048,
  /**
   * `FR-9.13` — the level-of-detail ladder, as fractions of the original
   * triangle count.
   *
   * The first entry is `1.0`: level 0 *is* the original, so the array describes
   * the whole ladder rather than only the extra rungs. The pipeline skips any
   * ratio at or above one, which is what makes "three levels" and "two files
   * produced" the same statement.
   *
   * Three levels rather than five: each costs storage and pipeline time, and the
   * returns past a sixth are small next to the cost of getting the switching
   * distances wrong.
   */
  ASSET_LOD_RATIOS: [1.0, 0.5, 0.15] as readonly number[],
  /**
   * `FR-9.22` — how long an editor lock survives without a heartbeat.
   *
   * Short, because the failure it guards against is an author who closed their
   * laptop, and a lock that outlived them would need an administrator. The
   * editor beats at `EDITOR_LOCK_HEARTBEAT_MS`, a third of this, so two missed
   * beats are survivable.
   */
  EDITOR_LOCK_TTL_MS: 60_000,
  EDITOR_LOCK_HEARTBEAT_MS: 20_000,
  /** `FR-9.19` — how far back the version list goes. Review, not archaeology:
   *  the same reasoning `MODERATION_PAGE_SIZE` gives for the audit log. */
  MAP_VERSIONS_RETAINED: 50,
  /**
   * The document size at which the editor starts saying so.
   *
   * A `jsonb` Map Document is read on every instance allocation and sent to every
   * client; past a megabyte that stops being free. A warning rather than a
   * refusal, because a legitimately large map is a decision somebody may have
   * made on purpose — but one nobody should make by accident.
   */
  MAP_DOCUMENT_WARN_BYTES: 512 * 1024,

  // ── Interactive objects (phase 10) ────────────────────────────────────────
  /**
   * `FR-10.2` — how close you have to be for an object to offer itself.
   *
   * 2.5 m is arm's length plus a step: close enough that the prompt is
   * unambiguous about *which* object it belongs to in a room of posters, far
   * enough that you do not have to stand inside a whiteboard to write on it. An
   * object can override it (`interactionRangeM`), which is what a cinema screen
   * wants and a sticky note does not.
   */
  INTERACT_RANGE_M: 2.5,
  /**
   * `FR-10.16` — how long shared state is allowed to settle before it is
   * written down.
   *
   * A whiteboard produces an update per stroke segment; persisting each one
   * would be a `bytea` write per mouse-move. Five seconds is far below what
   * anybody would notice losing in a crash and far above the rate a pen
   * generates — and the last participant leaving flushes immediately, so the
   * window only ever applies while somebody is still drawing.
   */
  YJS_PERSIST_DEBOUNCE_MS: 5_000,
  /**
   * `FR-10.10` — how far a shared video may drift before a client seeks.
   *
   * Below this, correcting is worse than the drift: a seek is an audible,
   * visible jump, and half a second apart in a room watching together is not
   * something anybody notices. Above it, people are watching different moments
   * and reacting to them out loud.
   */
  VIDEO_SYNC_DRIFT_TOLERANCE_MS: 500,
  /**
   * The ceiling on one shared object's persisted snapshot.
   *
   * Sharp edge nº1 in the phase notes: a CRDT retains history, so a long-lived
   * whiteboard's snapshot grows without bound and nothing fixes it by itself.
   * This is the size at which the server compacts — re-encoding the document
   * into a fresh one, which discards the history and keeps the content.
   */
  YJS_COMPACT_ABOVE_BYTES: 512 * 1024,

  // ── Limits & safety (all phases) ──────────────────────────────────────────
  MAX_MESSAGE_BYTES: 4_096,
  MAX_INBOUND_MSGS_PER_SEC: 60,
  MAX_DISPLAY_NAME_CHARS: 32,
  WS_HANDSHAKE_TIMEOUT_MS: 10_000,
} as const;

export type Tuning = typeof TUNING;
export type TuningKey = keyof Tuning;

/** Values pushed to the client at join, so it never hard-codes what the server owns. */
export interface ClientTuning {
  tickRateHz: number;
  clientSendRateHz: number;
  interpolationBufferMs: number;
  aoiEnterRadiusM: number;
  aoiExitRadiusM: number;
  idleTimeoutMs: number;
  walkSpeedMps: number;
  runSpeedMps: number;
  accelerationMps2: number;
  jumpHeightM: number;
  gravityMps2: number;
  characterStepOffsetM: number;
  characterSlopeLimitDeg: number;
  characterSnapToGroundM: number;
  avatarHeightM: number;
  avatarRadiusM: number;

  /**
   * Spatial media (phase 2).
   *
   * The falloff parameters are pushed rather than imported because the client's
   * `PannerNode` and the server's advertised gain must use the *same* numbers —
   * ADR 0007 keeps the formulae identical so what the server says a listener
   * hears and what they actually hear agree. Two copies of a constant that must
   * match is one copy too many.
   */
  maxAudibleDistanceM: number;
  maxVisibleDistanceM: number;
  audioRefDistanceM: number;
  audioRolloffFactor: number;

  /**
   * Avatars (phase 4).
   *
   * Pushed rather than imported for the reason NFR-39 gives: these are tunable
   * without a rebuild, and a client reading its own copy of `TUNING` would keep
   * playing walk animations at the old threshold after an operator changed it.
   *
   * `emoteMinIntervalMs` is here so the client can grey out the emote bar while
   * a send would be dropped. That is a courtesy — the throttle itself lives on
   * the server, because an anti-spam rule enforced in the client is not a rule.
   */
  animationCrossfadeMs: number;
  runAnimationThresholdMps: number;
  nameplateFadeStartM: number;
  nameplateHideM: number;
  emoteMinIntervalMs: number;
  emoteMaxDurationMs: number;

  /**
   * Chat (phase 5).
   *
   * `chatNearbyRadiusM` is pushed rather than imported for a reason the other
   * values only share by analogy: the client draws the reach of a `nearby`
   * message from it, and the server decides who actually receives one. A client
   * with its own copy would tell someone their message reached the far side of
   * the room after an operator narrowed the radius — the Phase 5 consistency
   * rule, broken in the one place a user would notice it.
   *
   * `chatRateLimitPerMin` lets the composer say why a send was refused. The
   * limit itself is enforced on the server, like every other anti-spam rule
   * here (`FR-4.16` set the precedent).
   */
  chatNearbyRadiusM: number;
  chatMaxMessageChars: number;
  chatHistoryLimit: number;
  typingIndicatorTtlMs: number;
  chatRateLimitPerMin: number;
}

/**
 * Where a phase-6 client is sent to change its account.
 *
 * A constant rather than a literal in the router, because the invite link the
 * server writes into `InviteDto.url` and the route the client parses have to be
 * the same string, and they are produced on opposite sides of the network.
 */
export const INVITE_QUERY_PARAM = 'invite';
export const RESET_QUERY_PARAM = 'reset';
