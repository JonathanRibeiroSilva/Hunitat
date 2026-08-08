/**
 * JSON frame schemas. See specs/protocol/wire-protocol.md.
 *
 * Every JSON payload is validated against its schema on receipt. A payload that
 * fails produces an ERROR frame and is discarded — nothing unvalidated reaches
 * application logic (NFR-31).
 */

import { z } from 'zod';
import {
  AVATAR_ACCESSORIES,
  AVATAR_BASE_MODELS,
  BOTTOM_COLORS,
  HAIR_COLORS,
  SKIN_COLORS,
  TOP_COLORS,
} from './avatar.js';
import { chatScopeSchema } from './chat.js';
import { TUNING } from './constants.js';
import { identityKindSchema } from './identity.js';
import {
  NO_MODERATION,
  capabilitySchema,
  participantModerationSchema,
  roleSchema,
} from './moderation.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

export const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
});

export const presenceStatusSchema = z.enum(['available', 'away', 'do-not-disturb']);
export const activityStatusSchema = z.enum(['active', 'idle']);

/**
 * `DC-5.1 Channel` as the client is told about it — `FR-5.5`.
 *
 * Up here with the other shared shapes because it rides on two frames: `JOINED`
 * seeds the set and `PARTICIPANT_UPDATE` revises it as the participant walks in
 * and out of chat-enabled zones. The server sends the whole available set
 * whenever it changes, so "the zone channel appears only while in a chat-enabled
 * zone" is a fact the client is *given* rather than one it derives. Deriving it
 * would mean the client deciding which zone it is standing in, and that decision
 * belongs to the server: it is the same occupancy that governs who hears you.
 */
export const chatChannelSchema = z.object({
  /** `room` · `nearby` · `zone:<id>` · `direct:<sessionId>` (see chat.ts). */
  id: z.string().min(1),
  scope: chatScopeSchema,
  /** What to show on the tab. Authored zone ids are not display copy. */
  label: z.string(),
  /** `FR-5.11` — whether this channel's history is retained. Advertised so the
   *  interface can say so, because "was this recorded" is not a detail a person
   *  should have to infer from whether scrolling up happens to work. */
  persistent: z.boolean(),
  zoneId: z.string().optional(),
});

export type PresenceStatus = z.infer<typeof presenceStatusSchema>;
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

/**
 * `DC-4.1 Avatar Appearance`.
 *
 * Palette **indices**, not colours: the catalogue in avatar.ts is shared by
 * client, server and bots, so an index is unambiguous, two bytes on the wire,
 * and — unlike a free-form hex string — cannot be used to render an invisible
 * avatar. Out-of-range values are clamped at render time rather than rejected
 * here, so a client from a newer build degrades instead of failing to join.
 */
const colorIndexSchema = (paletteLength: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(paletteLength - 1)
    .catch(0);

export const avatarAppearanceSchema = z.object({
  baseModel: z.enum(AVATAR_BASE_MODELS).catch('standard'),
  colors: z.object({
    skin: colorIndexSchema(SKIN_COLORS.length),
    hair: colorIndexSchema(HAIR_COLORS.length),
    top: colorIndexSchema(TOP_COLORS.length),
    bottom: colorIndexSchema(BOTTOM_COLORS.length),
  }),
  /**
   * Bounded by the catalogue, and de-duplicated on the server: a list of the
   * same hat forty times is a well-formed frame that costs everyone a render.
   *
   * Unknown ids are FILTERED OUT rather than rejected, which is the same
   * forward-compatibility the `.catch()` above buys for the other fields — and
   * it has to be, because `JOIN` carries this. A bare `z.enum` would fail the
   * whole `joinSchema`, and the gateway answers a failed join with a fatal
   * `bad-frame` and closes the socket: one accessory a build has never heard of
   * would make a newer client unable to enter the world at all, which is exactly
   * what wire-protocol.md's versioning rule forbids. It would also wipe a
   * stored outfit on the client, for the same reason.
   */
  accessories: z
    .array(z.string().max(32))
    .max(16)
    .catch([])
    .transform((list) =>
      list.filter((id): id is (typeof AVATAR_ACCESSORIES)[number] =>
        (AVATAR_ACCESSORIES as readonly string[]).includes(id),
      ),
    ),
});

/**
 * Phase 6 — `FR-6.13`, "the system distinguishes members from guests".
 *
 * Two fields rather than one, because they answer different questions and a
 * combined enum would collapse a real state. `kind` is whether the identity is
 * durable (`FR-6.11`); `member` is whether it belongs to this Space (`DC-6.4`).
 * A logged-in account that has never redeemed an invite is `account` + not a
 * member, and in a Space that allows guests they are a legitimate visitor who
 * simply owns their name — not a guest, and not a member.
 *
 * Deliberately carries **no account id**. The presence list needs to say "guest"
 * next to a name; it has no use for a durable identifier for a stranger, and
 * publishing one to everyone in range would hand out a stable cross-session
 * handle that nothing in this phase asks for.
 */
export const participantIdentitySchema = z.object({
  kind: identityKindSchema,
  member: z.boolean(),
});

export type ParticipantIdentity = z.infer<typeof participantIdentitySchema>;

export const participantSchema = z.object({
  id: z.number().int().min(0).max(0xffff),
  sessionId: z.string(),
  displayName: z.string(),
  status: presenceStatusSchema,
  activity: activityStatusSchema,
  transform: transformSchema,
  /**
   * Phase 4. Carried on `SNAPSHOT` and `PARTICIPANT_ADD` — which is the whole
   * mechanism behind the rule that someone walking up after a customization
   * change sees the current look, rather than the default until the next change.
   */
  appearance: avatarAppearanceSchema,
  /**
   * Phase 6. Defaulted rather than required, so a frame produced before this
   * field existed — or by a server running without a database, where nobody can
   * be anything else — still parses as what it actually is.
   */
  identity: participantIdentitySchema.default({ kind: 'guest', member: false }),
  /**
   * Phase 7, `FR-7.1` — every participant has a role.
   *
   * Published to observers because a presence list that cannot show who
   * moderates makes "ask an admin" advice nobody can follow. It is not a
   * *permission* — nothing a client does with this value is trusted, and every
   * action it enables is re-checked on the server (`NFR-34`).
   */
  role: roleSchema.default('guest'),
  /**
   * Phase 7, `FR-7.5` / `FR-7.6` — that somebody is force-muted, and no more.
   *
   * Observers get the fact; the target gets the actor and the reason, on the
   * self-only `MODERATION_STATE` frame. Published at all because a room where
   * one person has gone silent needs to distinguish "muted by a moderator" from
   * "microphone broken", and only the server knows which.
   */
  moderation: participantModerationSchema.default(NO_MODERATION),
  /**
   * Phase 7, `FR-7.16` — whether **the recipient of this frame** has blocked
   * them.
   *
   * The one field on a participant frame that describes the observer rather than
   * the participant, and it is safe here for a mechanical reason: `SNAPSHOT` and
   * `PARTICIPANT_ADD` are already addressed per connection, so each copy is
   * built for the person receiving it. A block change afterwards is announced
   * with a `PARTICIPANT_UPDATE` sent only to the blocker.
   *
   * The blocked party is told nothing. The Rules require a block not to imply
   * the blocker is offline, and telling somebody they have been blocked is the
   * other half of the same mistake.
   */
  blocked: z.boolean().default(false),
});

export type ParticipantDto = z.infer<typeof participantSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Client → server
// ─────────────────────────────────────────────────────────────────────────────

export const joinSchema = z.object({
  displayName: z.string().trim().max(TUNING.MAX_DISPLAY_NAME_CHARS).optional(),
  resumeToken: z.string().max(128).optional(),
  worldId: z.string().max(64).default('default'),
  /**
   * Phase 4, `FR-4.8`.
   *
   * Absent, the server derives a distinct-looking one from the local id, so a
   * room of people who never opened the customizer is still a room of
   * distinguishable people. Present, it is what the client remembered from last
   * time — which is all "persists with their identity" can mean before accounts
   * exist (phase 6). A resume ignores it: the retained participant already
   * carries the appearance it was wearing.
   */
  appearance: avatarAppearanceSchema.optional(),
  /**
   * Phase 6, `FR-6.18` — the access token, resolved to an identity **before**
   * the connection joins a world.
   *
   * On `JOIN` rather than in the HTTP upgrade request, and that is a real
   * choice. The browser `WebSocket` constructor cannot set an `Authorization`
   * header, which leaves a query parameter as the only header-free alternative —
   * and a query parameter lands in every access log and proxy trace along the
   * way. A token in the first frame is written to nothing.
   *
   * Absent means a guest, which is a supported state (`FR-6.6`) unless the Space
   * requires accounts (`FR-6.8`). Present but invalid is refused rather than
   * silently downgraded: somebody who believes they are signed in must not
   * quietly become a guest, because everything they do afterwards — their
   * profile, their direct messages — would land on an identity that vanishes.
   */
  accessToken: z.string().max(4096).optional(),
  /**
   * Phase 7, `FR-7.12` — the Space password, when one is required.
   *
   * On `JOIN` and not on an HTTP call, because it gates *entry to the world* and
   * the world is entered here. Sending it anywhere else would mean a client that
   * passed the check over REST and then joined without one, which is a second
   * door into the same room.
   *
   * A client cannot know in advance whether it is needed: `GET /auth/config`
   * says whether the Space requires one, and a join without it is answered with
   * `password-required` rather than a generic refusal, so the entry screen can
   * ask for it and retry.
   */
  spacePassword: z.string().max(200).optional(),
  /**
   * Phase 7 — a stable per-browser value, for guest bans only (`FR-7.8`).
   *
   * The Phase 7 notes are explicit that this is weak and that the weakness is
   * documented rather than solved: clearing site data defeats it, a different
   * browser defeats it, and shared corporate NAT means the address it is paired
   * with can catch bystanders. It is here because the alternative for a guest is
   * no ban at all, and the real remedy — requiring accounts (`FR-6.8`) — is one
   * checkbox away and named in the interface at the moment a guest is banned.
   *
   * Never used for anything but ban matching. It is not an identity: nothing
   * reads it to decide who somebody is, and it is not published to anybody.
   */
  clientFingerprint: z.string().max(128).optional(),
});

export const leaveSchema = z.object({});

export const setStatusSchema = z.object({
  // `idle` is deliberately absent: it is server-derived from input activity
  // (FR-1.22) and clients must not be able to claim it.
  status: presenceStatusSchema,
});

/**
 * `0x86 SET_APPEARANCE` — phase 4, `FR-4.5`/`FR-4.7`.
 *
 * The whole appearance, never a patch. A patch would need the sender and the
 * server to agree on what the current value is, and they demonstrably do not
 * during the tick a previous change is still in flight.
 */
export const setAppearanceSchema = z.object({
  appearance: avatarAppearanceSchema,
});

/**
 * `0x83 EMOTE`.
 *
 * A free string rather than an enum of the catalogue, deliberately: an emote id
 * this build has never heard of is a newer client talking to an older server,
 * and the versioning rule in wire-protocol.md says to ignore it, not to answer
 * with `bad-frame`. The server resolves the id against `EMOTES` and drops what
 * it cannot resolve.
 */
export const emoteSchema = z.object({
  emote: z.string().min(1).max(32),
});

/**
 * `0x84 CHAT_SEND` — phase 5, `FR-5.1`–`FR-5.4`.
 *
 * `targetId` carries two different things depending on scope, which is the one
 * overload in this protocol worth having: it is the recipient's **session id**
 * for `direct` and the **zone id** for `zone`, and unused otherwise. A field per
 * scope would be three fields of which two are always null, and the wire
 * protocol document already spells it this way.
 *
 * The client never sends a channel id. Channel identity for `direct` depends on
 * who is reading (see chat.ts), so a client-supplied one would have to be
 * rewritten by the server for every recipient anyway.
 */
export const chatSendSchema = z.object({
  scope: chatScopeSchema,
  body: z.string().trim().min(1).max(TUNING.CHAT_MAX_MESSAGE_CHARS),
  targetId: z.string().max(128).optional(),
  /**
   * `FR-5.8` — the sender's own id for the message it has already drawn.
   *
   * Echoed on the server's copy so the client can reconcile rather than
   * duplicate, and named on `CHAT_REJECT` so a failure marks the right message.
   * Optional: a bot that does not render anything has nothing to reconcile.
   */
  tempId: z.string().max(64).optional(),
});

/** `0x85 TYPING` — phase 5, `FR-5.10`. Never persisted, at any layer. */
export const typingSchema = z.object({
  scope: chatScopeSchema,
  typing: z.boolean(),
  targetId: z.string().max(128).optional(),
});

/** `0x87 CHAT_HISTORY` — phase 5, `FR-5.12`. */
export const chatHistoryRequestSchema = z.object({
  channelId: z.string().min(1).max(128),
  /**
   * Page backwards from this sequence number, exclusive. Absent means the most
   * recent page. Paging on `seq` rather than an offset because the channel is
   * still receiving while someone scrolls, and an offset would slide.
   */
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(TUNING.CHAT_HISTORY_LIMIT).optional(),
});

/** `0x88 CHAT_READ` — phase 5, `FR-5.16`. */
export const chatReadSchema = z.object({
  channelId: z.string().min(1).max(128),
  /** The highest `seq` the participant has now seen in that channel. */
  seq: z.number().int().nonnegative(),
});

export type JoinPayload = z.infer<typeof joinSchema>;
export type SetStatusPayload = z.infer<typeof setStatusSchema>;
export type SetAppearancePayload = z.infer<typeof setAppearanceSchema>;
export type AvatarAppearanceDto = z.infer<typeof avatarAppearanceSchema>;
export type EmotePayload = z.infer<typeof emoteSchema>;
export type ChatSendPayload = z.infer<typeof chatSendSchema>;
export type TypingPayload = z.infer<typeof typingSchema>;
export type ChatHistoryRequestPayload = z.infer<typeof chatHistoryRequestSchema>;
export type ChatReadPayload = z.infer<typeof chatReadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Server → client
// ─────────────────────────────────────────────────────────────────────────────

export const clientTuningSchema = z.object({
  tickRateHz: z.number(),
  clientSendRateHz: z.number(),
  interpolationBufferMs: z.number(),
  aoiEnterRadiusM: z.number(),
  aoiExitRadiusM: z.number(),
  idleTimeoutMs: z.number(),
  walkSpeedMps: z.number(),
  runSpeedMps: z.number(),
  accelerationMps2: z.number(),
  jumpHeightM: z.number(),
  gravityMps2: z.number(),
  characterStepOffsetM: z.number(),
  characterSlopeLimitDeg: z.number(),
  characterSnapToGroundM: z.number(),
  avatarHeightM: z.number(),
  avatarRadiusM: z.number(),
  maxAudibleDistanceM: z.number(),
  maxVisibleDistanceM: z.number(),
  audioRefDistanceM: z.number(),
  audioRolloffFactor: z.number(),
  // ── Avatars (phase 4) ──────────────────────────────────────────────────────
  animationCrossfadeMs: z.number(),
  runAnimationThresholdMps: z.number(),
  nameplateFadeStartM: z.number(),
  nameplateHideM: z.number(),
  emoteMinIntervalMs: z.number(),
  emoteMaxDurationMs: z.number(),
  // ── Chat (phase 5) ─────────────────────────────────────────────────────────
  chatNearbyRadiusM: z.number(),
  chatMaxMessageChars: z.number(),
  chatHistoryLimit: z.number(),
  typingIndicatorTtlMs: z.number(),
  chatRateLimitPerMin: z.number(),
});

/**
 * Everything the client needs to reach the SFU (phase 2).
 *
 * Delivered inside `JOINED` rather than fetched from a REST endpoint. The socket
 * has already been authenticated by the time this is written to it, so there is
 * no second credential to invent and nothing to hand out over an unauthenticated
 * route in a phase that has no accounts (phase 6). A resume issues a fresh
 * `JOINED`, which is exactly when a fresh token is wanted.
 *
 * **Null when the server has no LiveKit credentials configured.** Phase 1's
 * development flow runs without Docker, so media has to be absent rather than
 * broken: the client shows an unavailable state and presence carries on, which
 * is what the FR-2.5 rule about not breaking presence asks for.
 */
export const mediaGrantSchema = z.object({
  /** The LiveKit server the client connects to, e.g. `ws://localhost:7880`. */
  url: z.string().min(1),
  /** Signed JWT. Room and identity are baked in; see ADR 0006. */
  token: z.string().min(1),
  /** One World Instance = one Room. */
  room: z.string().min(1),
  /** The participant identity encoded in the token — the session id, so remote
   *  LiveKit participants can be matched to world participants. */
  identity: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});

/**
 * `0x9e IDENTITY`, and the `identity` field on `JOINED` — phase 6.
 *
 * One shape for both, because they answer the same question at two moments: what
 * this connection's identity is now. `JOINED` states it at the handshake
 * (`FR-6.18`); the standalone frame states it again when a guest upgrades
 * mid-session without dropping the socket (`FR-6.7`).
 *
 * Sent **only to the connection it describes** — it names an account id, which
 * is a durable handle for a person and belongs to nobody else. What observers
 * get is `participantIdentitySchema`, which says "guest" or "member" and stops.
 */
export const identityStateSchema = z.object({
  kind: identityKindSchema,
  /** Present only for `account`. The durable id `FR-6.11` refers to. */
  accountId: z.string().optional(),
  /** `DC-6.4` — of the Space this world instance belongs to. */
  member: z.boolean(),
  /**
   * The name and look now in force, which after an upgrade is what the guest was
   * already wearing (`FR-6.7`) and after a sign-in is what the profile holds
   * (`FR-6.9`). Restated here so the client never has to work out which of the
   * two won.
   */
  displayName: z.string(),
  appearance: avatarAppearanceSchema,
  /**
   * Phase 7, `FR-7.1` / `FR-7.2` — what this connection may do.
   *
   * Both fields, and not just the role: the role is what the interface *shows*
   * ("admin" beside a name), the capability list is what it *acts on*. Sending
   * only the role would make every client carry its own copy of the matrix and
   * re-derive it, which is the second implementation `CAPABILITIES` exists to
   * prevent.
   *
   * Advisory in exactly one direction. It can hide a button that would fail; it
   * cannot enable one that would not, because every action is re-checked on the
   * server against the same matrix (`NFR-34`).
   */
  role: roleSchema.default('guest'),
  capabilities: z.array(capabilitySchema).default([]),
});

export type IdentityStatePayload = z.infer<typeof identityStateSchema>;

export const joinedSchema = z.object({
  sessionId: z.string(),
  localId: z.number().int(),
  displayName: z.string(),
  resumeToken: z.string(),
  resumeTokenTtlMs: z.number(),
  spawn: transformSchema,
  mapUrl: z.string(),
  mapDocumentUrl: z.string(),
  /**
   * Phase 8 — which Map, and which instance of it, this connection landed in
   * (`FR-8.4`, `FR-8.7`).
   *
   * Defaulted rather than required, because a server running without a database
   * has one Map and no Space table to name it from, and a client that refused to
   * parse the frame would be unable to enter a world that works perfectly well.
   * The defaults describe exactly that server: one map, instance zero, one
   * instance.
   *
   * `instanceLabel` is `FR-8.10`'s user-interface half, produced on the server so
   * every client says the same thing.
   */
  mapId: z.string().default('default'),
  mapName: z.string().default(''),
  instanceId: z.string().default('default#0'),
  instanceIndex: z.number().int().nonnegative().default(0),
  instanceLabel: z.string().default(''),
  instanceCount: z.number().int().positive().default(1),
  spaceName: z.string().default(''),
  /**
   * Phase 4 — where the avatar model lives.
   *
   * Told rather than assumed, for the same reason `mapUrl` is: the server owns
   * asset locations, and phase 9 moves them to object storage on a different
   * origin. A client with the path baked in would have to be rebuilt to follow.
   */
  avatarModelUrl: z.string(),
  /** The appearance the server actually gave this participant — generated when
   *  the client offered none, so the customizer opens on what is being worn
   *  rather than on a default nobody is wearing. */
  appearance: avatarAppearanceSchema,
  tuning: clientTuningSchema,
  /**
   * Phase 5, `FR-5.5` — the channels available at the moment of joining.
   *
   * Seeded here and revised by `PARTICIPANT_UPDATE`. A client that started with
   * an empty set and waited for the first update would show no chat at all to
   * someone who joins and stands still, which is most people's first ten
   * seconds.
   */
  chatChannels: z.array(chatChannelSchema).default([]),
  /** Phase 2 SFU credentials, or null when media is not configured. */
  media: mediaGrantSchema.nullable(),
  /** True when a resume token was accepted and the existing participant was
   *  rebound to this socket rather than a new one being created (FR-1.5). */
  resumed: z.boolean(),
  /**
   * Phase 6, `FR-6.18` — who the server decided this connection is.
   *
   * Stated on the frame rather than inferred by the client from whether it sent
   * a token. The two can disagree, and when they do the server is right: a token
   * that expired between the last refresh and this handshake is refused, and a
   * client that assumed success would render an account session on top of a
   * guest one.
   */
  identity: identityStateSchema,
});

export const snapshotSchema = z.object({
  participants: z.array(participantSchema),
  totalInInstance: z.number().int(),
});

export const participantAddSchema = participantSchema;

export const participantRemoveSchema = z.object({
  id: z.number().int(),
  /**
   * `out-of-range` means drop the remote representation but keep them in the
   * instance count; `left` means they are actually gone. Conflating the two
   * makes the presence list wrong.
   */
  reason: z.enum([
    'left',
    'out-of-range',
    'timeout',
    /** Phase 7, `FR-7.7`. Distinct from `banned` so a client can say which
     *  happened — one of them can be undone by walking back in. */
    'kicked',
    /** Phase 7, `FR-7.8`. */
    'banned',
  ]),
});

export const participantUpdateSchema = z.object({
  id: z.number().int(),
  displayName: z.string().optional(),
  status: presenceStatusSchema.optional(),
  activity: activityStatusSchema.optional(),
  totalInInstance: z.number().int().optional(),
  /** Phase 4, `FR-4.6`. Travels here rather than on the hot path: appearance
   *  changes a few times ever, and the transform batch is sized for what changes
   *  twenty times a second. */
  appearance: avatarAppearanceSchema.optional(),
  /**
   * Phase 5, `FR-5.5` — the participant's currently available chat channels.
   *
   * **Sent only to the participant it describes**, unlike every other field on
   * this frame. The set names the chat-enabled zone someone is standing in, and
   * broadcasting that to observers would publish a position the area of interest
   * exists to keep private — the same leak `ZONE_EVENT` is restricted for.
   */
  chatChannels: z.array(chatChannelSchema).optional(),
  /**
   * Phase 6, `FR-6.7` / `FR-6.13` — a guest became an account, live.
   *
   * Broadcast to observers, unlike `chatChannels` above, because it is the same
   * class of fact as `displayName`: what the presence list shows next to
   * somebody. It carries no account id — see `participantIdentitySchema`.
   */
  identity: participantIdentitySchema.optional(),
  /** Phase 7, `FR-7.1` — a role change reaching the room without a rejoin. */
  role: roleSchema.optional(),
  /** Phase 7, `FR-7.5` / `FR-7.6` / `FR-7.10` — a mute takes effect in the
   *  presence list at the same moment it takes effect on the SFU. */
  moderation: participantModerationSchema.optional(),
  /**
   * Phase 7, `FR-7.16` — a block was applied or lifted.
   *
   * Sent **only to the blocker**, like `chatChannels` and for a stronger reason:
   * the Rules require a block not to imply the blocker is offline, and telling
   * the blocked party would be a worse version of the same disclosure.
   */
  blocked: z.boolean().optional(),
});

export const forceTransformSchema = z.object({
  transform: transformSchema,
  /** Phase 8 adds `transfer`: the server placed them at a spawn in a *different*
   *  Map, and the `MAP_TRANSFER` frame that precedes it carries the rest. A
   *  client that treated it as a portal would keep the world it is no longer
   *  in. */
  reason: z.enum(['spawn', 'portal', 'moderation', 'transfer']),
});

export const errorSchema = z.object({
  code: z.enum([
    'bad-frame',
    'not-joined',
    'rate-limited',
    'world-full',
    'invalid-resume',
    'banned',
    'internal',
    /** A portal whose destination does not resolve. The participant stays put
     *  and is told — never a teleport into nowhere (Phase 3 Rules). */
    'portal-unresolved',
    /**
     * Phase 6, `FR-6.8` / `AC-6.5` — this Space requires an account.
     *
     * Distinct from `auth-required` below, which means "your token did not
     * work". This one means the join was well-formed and guests are simply not
     * admitted here, and the Rules require it to arrive with an invite path
     * rather than as a generic denial.
     */
    'guests-not-allowed',
    /**
     * A token was presented and did not resolve — expired, malformed, or signed
     * by a key this server does not have.
     *
     * Never a silent downgrade to guest. The client refreshes and retries; if
     * that fails too, the person is signed out deliberately rather than left
     * doing things under an identity they did not choose.
     */
    'auth-required',
    /**
     * Phase 7, `FR-7.4` — the action was understood and is not permitted.
     *
     * Never a silent no-op: the requirement says attempts "are refused", and a
     * moderation button that does nothing is indistinguishable from one that
     * worked. Non-fatal — the connection is fine, the request was not.
     */
    'forbidden',
    /** `FR-7.11` — the Space is locked and admits nobody new. People already
     *  inside are unaffected, which is what makes this different from a ban. */
    'space-locked',
    /** `FR-7.12` — a password is required and none was offered. The client's
     *  correct response is to ask for one and retry, which is why it is distinct
     *  from the refusal below. */
    'password-required',
    /** `FR-7.12` — one was offered and it was wrong. Distinct so the entry
     *  screen can say "that password is not right" rather than asking again as
     *  though nothing had been typed. */
    'password-incorrect',
    /** `FR-7.13` — the Space is allowlisted and this identity is not on it.
     *  Retrying will not help; asking whoever runs the Space will. */
    'not-allowlisted',
    /**
     * Phase 8, `FR-8.8` / `FR-8.13` — the destination could not take them.
     *
     * Distinct from `world-full`, which is the Space refusing entry at the door:
     * this one is somebody who is already inside and cannot get into *that room*.
     * They stay exactly where they are, which is the whole difference — a full
     * Map must never leave a participant nowhere.
     */
    'map-full',
    /**
     * Phase 8 — the named Map or instance does not exist, is archived, or is not
     * one this participant may enter (`FR-8.13`).
     *
     * Non-fatal, like `portal-unresolved` and for the same reason: the request
     * failed, the participant did not. A directory that has gone stale in
     * somebody's open panel is the ordinary cause.
     */
    'map-unavailable',
  ]),
  message: z.string(),
  fatal: z.boolean().default(false),
});

/**
 * `0x97 EMOTE_PLAY` — phase 4, `FR-4.15`/`FR-4.16`.
 *
 * Broadcast to everyone whose area of interest holds the emoter, plus the
 * emoter themself — third person means you watch your own gesture, and a local
 * preview the server never approved would show a throttled emote playing for
 * its author and nobody else.
 *
 * `durationMs` is the server's word on how long it runs, already clamped to
 * `EMOTE_MAX_DURATION_MS`. Time-bounding is a guarantee, so the bound is stated
 * by the party that enforces the throttle rather than trusted from the sender.
 */
export const emotePlaySchema = z.object({
  id: z.number().int(),
  emote: z.string(),
  durationMs: z.number(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat — phase 5
// ─────────────────────────────────────────────────────────────────────────────

/** `FR-5.15` — who a message mentions, resolved server-side *after* scoping. */
export const chatMentionSchema = z.object({
  id: z.number().int().min(0).max(0xffff),
  sessionId: z.string(),
  name: z.string(),
});

/**
 * `0x98 CHAT_MESSAGE` — one delivered message (`DC-5.2`).
 *
 * Addressed per recipient rather than broadcast verbatim: `channelId` for a
 * direct message names the *other* party, so each side files it under the thread
 * it will look for, and `mentions` carries only recipients eligible for this
 * copy. One frame shape, resolved once per addressee.
 *
 * `seq` is the server's ordering (`FR-5.7`) and `at` is the server's clock. The
 * client's own timestamp is never on the wire — clocks are not assumed to agree
 * (conventions/coordinates-and-units.md#time), and ordering by one would let a
 * skewed machine post into last Tuesday.
 */
export const chatMessageSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  scope: chatScopeSchema,
  seq: z.number().int().nonnegative(),
  senderId: z.number().int().min(0).max(0xffff),
  senderSessionId: z.string(),
  senderName: z.string(),
  body: z.string(),
  /** Server clock, epoch milliseconds. */
  at: z.number().int(),
  mentions: z.array(chatMentionSchema).default([]),
  /** Present only on the copy returned to the sender (`FR-5.8`). */
  tempId: z.string().optional(),
  zoneId: z.string().optional(),
});

/**
 * `0x99 TYPING_STATE` — `FR-5.10`.
 *
 * Carries `expiresInMs` rather than leaving the client to time it out from its
 * own constant: the indicator must clear even if the "stopped" frame is lost,
 * and the server owns `TYPING_INDICATOR_TTL_MS`. A client with a stale copy of
 * the TTL leaves someone shown as typing indefinitely, which reads as the
 * feature being broken rather than as a dropped frame.
 */
export const typingStateSchema = z.object({
  channelId: z.string().min(1),
  scope: chatScopeSchema,
  id: z.number().int().min(0).max(0xffff),
  sessionId: z.string(),
  displayName: z.string(),
  typing: z.boolean(),
  expiresInMs: z.number().int().nonnegative(),
});

/** `0x9C CHAT_HISTORY_RESULT` — the reply to `CHAT_HISTORY` (`FR-5.12`). */
export const chatHistoryResultSchema = z.object({
  channelId: z.string().min(1),
  scope: chatScopeSchema,
  /** Oldest first, so a client can append without reversing. */
  messages: z.array(chatMessageSchema),
  /**
   * True when the page reaches the beginning of what is retained — which is not
   * the same as the beginning of the conversation, and the interface should say
   * "nothing older is kept" rather than "this is where it started".
   */
  complete: z.boolean(),
  /** `FR-5.16` — the stored last-seen marker, so unread survives a reconnect. */
  lastReadSeq: z.number().int().nonnegative(),
});

/**
 * `0x9D CHAT_REJECT` — `FR-5.8`, the failure half.
 *
 * A message the sender has already drawn optimistically and that will never be
 * delivered. Never silent: the requirement is a *clear indication*, and a
 * message that quietly stays on screen looking sent is the failure mode this
 * frame exists to prevent.
 */
export const chatRejectSchema = z.object({
  tempId: z.string().optional(),
  channelId: z.string().optional(),
  code: z.enum([
    /** More than CHAT_RATE_LIMIT_PER_MIN in the last minute. */
    'rate-limited',
    /** `FR-5.5` — that scope is not available where the sender is standing. */
    'channel-unavailable',
    /** A direct message to somebody who is no longer in the instance. Guest DMs
     *  last only as long as the session (Phase 5 Rules). */
    'recipient-gone',
    'bad-frame',
  ]),
  message: z.string(),
});

export type ChatChannelDto = z.infer<typeof chatChannelSchema>;
export type ChatMentionDto = z.infer<typeof chatMentionSchema>;
export type ChatMessagePayload = z.infer<typeof chatMessageSchema>;
export type TypingStatePayload = z.infer<typeof typingStateSchema>;
export type ChatHistoryResultPayload = z.infer<typeof chatHistoryResultSchema>;
export type ChatRejectPayload = z.infer<typeof chatRejectSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Zones and audience — phase 3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0x9A AUDIENCE` — who this participant may hear and see, and how loudly.
 *
 * The full set every time, not a diff. It is bounded by the area of interest
 * (~15 entries), and a self-describing set cannot drift out of step with the
 * server the way an accumulated sequence of diffs can after one dropped frame.
 *
 * Sent only when the set changes. At 20 Hz an unchanged audience would be 1200
 * pointless frames a minute per participant.
 *
 * Phase 3 computed and shipped it before any media existed, which is what made
 * the zone precedence rules (FR-3.19, FR-3.20) observable and testable early.
 * Phase 2 is what makes it audible: the client turns each entry into a LiveKit
 * subscription and a Web Audio node.
 *
 * **Membership in this set is the subscription decision** (FR-2.11, FR-2.16).
 * Absence means the track is not consumed at all — gain reaching zero is not
 * enough, because silence still costs bandwidth (ADR 0007).
 */
export const audienceEntrySchema = z.object({
  /** Instance-local id, matching every other JSON frame. */
  id: z.number().int().min(0).max(0xffff),
  /**
   * Session id — the identity the same participant publishes under on the SFU.
   *
   * Carried even though `id` already names them, because the audience is NOT a
   * subset of the interest set: a spotlighted speaker reaches the whole map from
   * outside it (FR-3.12), and the client has no roster entry to look their
   * session id up in. Without this the one participant a spotlight exists to
   * deliver is the one the client cannot subscribe to.
   */
  sessionId: z.string().min(1),
  /** 0..1. Drives Web Audio gain in Phase 2 and chat scoping in Phase 5. */
  gain: z.number().min(0).max(1),
  /** Why they are audible. Diagnostic, and what makes an isolation bug legible
   *  in a log rather than inferred from a missing entry. */
  reason: z.enum(['proximity', 'private-zone', 'spotlight']),
  /**
   * Whether their *video* is also subscribed (FR-2.12, FR-2.13).
   *
   * A separate flag rather than a second list, because the visible set is
   * governed by the same zone rules and differs only in its distance threshold
   * (`MAX_VISIBLE_DISTANCE_M`, 8 m, against 12 m audible) and in the tighter cap
   * `FR-2.18` sheds video against. Two lists would let the zone logic drift
   * apart between them.
   */
  visible: z.boolean(),
  /**
   * Metres between listener and speaker at the tick this was computed.
   *
   * The client picks a simulcast layer from it (FR-2.18) rather than recomputing
   * a distance from interpolated positions that lag the server's by the
   * interpolation buffer.
   */
  distanceM: z.number().nonnegative(),
});

export const audienceSchema = z.object({
  targets: z.array(audienceEntrySchema),
});

/**
 * `0x9B ZONE_EVENT` — the participant's OWN zone transitions (FR-3.17).
 *
 * Own transitions only. Broadcasting everyone's would leak the position of
 * people outside the area of interest, which is the leak AOI exists to prevent.
 *
 * The requirement is about other *systems* consuming enter/exit, and the server
 * bus is that deliverable; this frame is one subscriber. It exists because the
 * client needs to know it is inside a private zone in order to say so (a person
 * whose audio just became private must be able to tell), and because it makes
 * AC-3.5 observable from outside the process.
 */
export const zoneEventSchema = z.object({
  id: z.number().int().min(0).max(0xffff),
  zoneId: z.string().min(1),
  zoneType: z.enum(['collision', 'spawn', 'private', 'spotlight', 'portal', 'trigger']),
  kind: z.enum(['enter', 'exit']),
  /** The authored `key` of a trigger zone, when it has one (DC-3.3). */
  key: z.string().optional(),
  /** Server clock, milliseconds. DC-3.3 calls for a timestamp. */
  at: z.number().int(),
});

export type JoinedPayload = z.infer<typeof joinedSchema>;
export type SnapshotPayload = z.infer<typeof snapshotSchema>;
export type ParticipantRemovePayload = z.infer<typeof participantRemoveSchema>;
export type ParticipantUpdatePayload = z.infer<typeof participantUpdateSchema>;
export type ForceTransformPayload = z.infer<typeof forceTransformSchema>;
export type ErrorPayload = z.infer<typeof errorSchema>;
export type EmotePlayPayload = z.infer<typeof emotePlaySchema>;
export type AudienceEntryPayload = z.infer<typeof audienceEntrySchema>;
export type AudiencePayload = z.infer<typeof audienceSchema>;
export type ZoneEventPayload = z.infer<typeof zoneEventSchema>;
export type MediaGrant = z.infer<typeof mediaGrantSchema>;
export type ClientTuningPayload = z.infer<typeof clientTuningSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// JSON frame encoding
//
// A JSON frame is [opcode byte][UTF-8 JSON]. Keeping this in one place means the
// opcode and the payload can never drift apart at a call site.
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJsonFrame(opcode: number, payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = opcode & 0xff;
  frame.set(json, 1);
  return frame;
}

/** Returns null if the payload is not valid JSON. Callers then validate the
 *  parsed value against the schema for that opcode. */
export function decodeJsonFrame(data: ArrayBuffer | ArrayBufferView): unknown | null {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  if (bytes.byteLength < 1) return null;
  try {
    return JSON.parse(decoder.decode(bytes.subarray(1)));
  } catch {
    return null;
  }
}
