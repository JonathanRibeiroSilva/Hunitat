/**
 * Roles, capabilities and moderation — phase 7.
 *
 * ── Why the capability matrix lives in the shared package ───────────────────
 *
 * `NFR-34` requires authorization on **both** the HTTP and the WebSocket path,
 * and the Phase 7 implementation notes name the unguarded gateway handler as the
 * single most likely way this phase ships broken. Two guards enforcing two copies
 * of a matrix is the same failure one refactor later, so there is one matrix and
 * both guards read it.
 *
 * The client imports it too, and that is a convenience rather than a control: it
 * decides which buttons to draw. Every one of those buttons is re-checked on the
 * server, because a capability hidden in the UI is not enforced (`NFR-34`, and
 * the Phase 7 Rules say it in so many words).
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * **No ban durations, no lock state, no passwords.** Those are Space *state*,
 * they live in the database, and a client that cached them would answer a
 * question only the server can answer. What a client is told about access policy
 * arrives as a refusal on `JOIN` with a code it can act on.
 */

import { z } from 'zod';
import { TUNING } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// DC-7.1 Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `FR-7.1` — every participant in a Space has one of these.
 *
 * Ordered weakest to strongest, and the order is load-bearing: `ROLE_RANK` below
 * is derived from this array rather than written out a second time.
 *
 * `guest` is a role and not merely the absence of one. Somebody with no account
 * still has to be governed by the matrix — they can block and report — and a
 * nullable role would mean every call site deciding for itself what `null`
 * permits.
 */
export const ROLES = ['guest', 'member', 'admin', 'owner'] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** Strictly ordered. `owner` is 3, `guest` is 0. */
export const ROLE_RANK: Record<Role, number> = Object.fromEntries(
  ROLES.map((role, index) => [role, index]),
) as Record<Role, number>;

// ─────────────────────────────────────────────────────────────────────────────
// DC-7.2 Capability Matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a role may do. One name per action a guard can be asked about.
 *
 * Split finer than "moderator": `ban` is separated from `moderate` and
 * `manage-roles` from `manage-access` because `FR-7.3` gives owners powers
 * admins do not have, and a single `moderate` flag could not express it.
 */
export const CAPABILITY_LIST = [
  /** `FR-7.16` — hide somebody from yourself. Personal, needs nobody's blessing. */
  'block',
  /** `FR-7.17` — file a report for moderators to read. */
  'report',
  /** `FR-6.12` — issue and withdraw invite links. Members and up, as phase 6 had it. */
  'manage-invites',
  /** `FR-7.5`, `FR-7.6`, `FR-7.7`, `FR-7.9` — force-mute, disable video, kick, respawn. */
  'moderate',
  /** `FR-7.8` — ban and lift a ban. Separated from `moderate` because it outlives
   *  the session it was issued in. */
  'ban',
  /** `FR-7.11`–`FR-7.15` — lock, password, allowlist, capacity, and whether guests
   *  are admitted at all. Phase 6 let any member change the last of those; from
   *  here it is an administrative act like the other four. */
  'manage-access',
  /** `FR-7.17`, `FR-7.20` — read what users filed and what moderators did. */
  'review',
  /**
   * `FR-8.15`, `FR-8.16` — add, configure and archive the Maps *within* a Space.
   *
   * Administrative rather than ownership-level, because it is the same class of
   * act as locking the Space or setting its capacity: it changes how the place
   * works without changing whose place it is. Archiving a Map moves people out
   * of it (`FR-8.18`), which is a moderator's kind of power and not an owner's.
   */
  'manage-maps',
  /**
   * `FR-8.15`, `FR-8.17` — create a Space, and archive or delete one.
   *
   * Owner-level and separate from `manage-maps`, because deleting a Space is
   * durable removal of everything inside it: every Map, every version, every
   * message written in it. `FR-8.17` asks for "appropriate confirmation and
   * permission checks", and an admin who may retire a meeting room is not
   * thereby somebody who may retire the building.
   */
  'manage-space',
  /** `FR-7.3` — assign and revoke roles. Owner only, and see `canAssignRole`. */
  'manage-roles',
  /** The Rules: "the owner role must not be removable by anyone but through an
   *  explicit ownership-transfer path". This is that path, and it is its own
   *  capability so a generic role change can never reach it. */
  'transfer-ownership',
] as const;

export const capabilitySchema = z.enum(CAPABILITY_LIST);
export type Capability = z.infer<typeof capabilitySchema>;

/**
 * What each role adds on top of the one below it.
 *
 * `FR-7.2` requires higher roles to include lower-role abilities, so the matrix
 * is *computed* as a running union rather than typed out four times. Written out,
 * the fourth list is where somebody eventually forgets to repeat an entry, and
 * the symptom is an owner who cannot do something an admin can.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  guest: ['block', 'report'],
  member: ['manage-invites'],
  admin: ['moderate', 'ban', 'manage-access', 'review', 'manage-maps'],
  owner: ['manage-roles', 'transfer-ownership', 'manage-space'],
};

/** `DC-7.2` — the whole matrix, supersetting upwards. */
export const CAPABILITIES: Record<Role, readonly Capability[]> = (() => {
  const matrix = {} as Record<Role, Capability[]>;
  const accumulated: Capability[] = [];
  for (const role of ROLES) {
    accumulated.push(...GRANTS[role]);
    matrix[role] = [...accumulated];
  }
  return matrix;
})();

/** `FR-7.4` — the question every guard asks, on both transports. */
export function hasCapability(role: Role, capability: Capability): boolean {
  return CAPABILITIES[role].includes(capability);
}

/**
 * Whether `actor` may act on `target` at all.
 *
 * **Strictly greater**, not greater-or-equal, and that is the whole of `FR-7.3`'s
 * "admins can moderate but cannot remove the owner" plus one thing the
 * requirement does not say and every deployment needs: two admins cannot kick
 * each other. Equal rank would make a disagreement between moderators a race,
 * decided by whoever clicked first, and there is no way to undo a ban from a
 * session you have just been banned from.
 *
 * Self is excluded by the same comparison, which is why there is no separate
 * check for it.
 */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/**
 * Which roles a holder may hand out.
 *
 * `owner` is absent from every answer on purpose. The Rules require the owner
 * role to move only "through an explicit ownership-transfer path", and a generic
 * role endpoint that happened to accept `owner` is exactly the accident that
 * leaves a Space with two owners or none.
 */
export function assignableRoles(actor: Role): readonly Role[] {
  if (!hasCapability(actor, 'manage-roles')) return [];
  return ['guest', 'member', 'admin'];
}

// ─────────────────────────────────────────────────────────────────────────────
// DC-7.3 Moderation Action — the socket frame
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0x89 MODERATE` — one act, on one live participant.
 *
 * On the socket rather than over HTTP because every one of these is about a
 * *session*: the target is somebody standing in the room, addressed by the
 * session id the presence list already holds, and `FR-7.10` requires the effect
 * to be immediate rather than "on next join". A REST call would need the world to
 * be reachable from a controller anyway, and would arrive without the connection
 * that proves who is asking.
 *
 * The durable half — roles, bans as records, access policy, the audit log — is
 * HTTP, because none of it is about a session and some of it is about people who
 * are not here.
 */
export const moderateSchema = z.object({
  action: z.enum([
    /** `FR-7.5`. Overrides the target's own unmute until lifted. */
    'mute',
    'unmute',
    /** `FR-7.6`. Camera and screen share together — one permission on the SFU. */
    'disable-video',
    'enable-video',
    /** `FR-7.7`. Removed from this instance; may return unless also banned. */
    'kick',
    /** `FR-7.8`. Kick, plus a record that refuses the next attempt. */
    'ban',
    /** `FR-7.9`. Moved to a spawn — the same override portals use. */
    'respawn',
  ]),
  /** The presence list holds session ids, and a moderator acts on somebody they
   *  can see. Durable identities are how the HTTP surface addresses people who
   *  are not here. */
  targetSessionId: z.string().min(1).max(128),
  /**
   * Shown to the target and written to the audit log (`FR-7.19`).
   *
   * Optional, because a moderator dealing with an emergency should not be made to
   * type before they can act — but the audit row records its absence rather than
   * inventing one.
   */
  reason: z.string().trim().max(280).optional(),
  /**
   * `FR-7.8` — a time-limited ban. Absent means permanent.
   *
   * Capped at ten years rather than left unbounded: an accidental extra digit
   * produces a date nobody will be around to lift, and "permanent" already has a
   * spelling.
   */
  durationMinutes: z.number().int().positive().max(5_256_000).optional(),
});

export type ModeratePayload = z.infer<typeof moderateSchema>;
export type ModerationAction = ModeratePayload['action'];

/**
 * `0x8A BLOCK` — `FR-7.16`, `FR-7.18`.
 *
 * Not a moderation action and deliberately not on the frame above: it needs no
 * capability beyond being a participant, it affects nobody but the two people
 * involved, and it is not written to the moderation audit log. Merging the two
 * would put a personal decision into a moderator's record.
 */
export const blockSchema = z.object({
  targetSessionId: z.string().min(1).max(128),
  blocked: z.boolean(),
});

export type BlockPayload = z.infer<typeof blockSchema>;

/**
 * `0x8B REPORT` — `FR-7.17`.
 *
 * Carries only who and why. The **where** — position, map, the zone they were
 * standing in — is captured on the server at the moment of filing, because
 * `DC-7.6` asks for context and a client-supplied position is a client-supplied
 * fact about a person who is being complained about.
 */
export const reportSchema = z.object({
  targetSessionId: z.string().min(1).max(128),
  reason: z.string().trim().max(1000).optional(),
});

export type ReportPayload = z.infer<typeof reportSchema>;

/**
 * `0x9F MODERATION_STATE` — what a target is told, and only the target.
 *
 * `FR-7.5` requires the target to be *notified*, which is a different fact from
 * the one observers get. Everyone in range learns that somebody is muted, through
 * the `moderation` field on `PARTICIPANT_UPDATE`; only the muted person is told
 * who did it and why. Publishing a moderator's name and their reason to the room
 * would turn every mute into an announcement.
 *
 * Its own frame rather than a self-only field on `PARTICIPANT_UPDATE`, for the
 * reason `chatChannels` and `IDENTITY` are separate: a field that is only ever
 * valid for self, on a frame that is usually about others, is a leak waiting for
 * a refactor.
 */
export const moderationStateSchema = z.object({
  /** `FR-7.5` — cannot transmit audio until lifted. */
  micMuted: z.boolean(),
  /** `FR-7.6` — camera and screen share. */
  cameraDisabled: z.boolean(),
  /** Who did it, by display name. Absent when the state is being cleared or was
   *  restored on a rejoin rather than applied just now. */
  byName: z.string().optional(),
  reason: z.string().optional(),
  /** Server clock. A client that reconnects gets this frame again with the same
   *  `at`, so a "you were muted" notice does not re-announce itself. */
  at: z.number().int(),
});

export type ModerationStatePayload = z.infer<typeof moderationStateSchema>;

/** What observers are told about somebody — no actor, no reason. Rides on
 *  `SNAPSHOT`, `PARTICIPANT_ADD` and `PARTICIPANT_UPDATE`. */
export const participantModerationSchema = z.object({
  micMuted: z.boolean(),
  cameraDisabled: z.boolean(),
});

export type ParticipantModeration = z.infer<typeof participantModerationSchema>;

export const NO_MODERATION: ParticipantModeration = { micMuted: false, cameraDisabled: false };

// ─────────────────────────────────────────────────────────────────────────────
// DC-7.4 Access Policy — the HTTP surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `FR-7.11`–`FR-7.14`, as an administrator sees it.
 *
 * `password` is absent and `passwordSet` is a boolean, which is the whole
 * difference between a policy you can read and a credential you can steal. An
 * admin who has forgotten the password sets a new one; nothing hands it back.
 */
export const accessPolicySchema = z.object({
  /** `FR-7.11` — no new participants may enter. People already inside stay. */
  locked: z.boolean(),
  /** `FR-7.12` — whether one is required, never what it is. */
  passwordSet: z.boolean(),
  /** `FR-7.13` — when true, only addresses on the list may enter. */
  allowlistEnabled: z.boolean(),
  allowlist: z.array(z.string()),
  /** `FR-7.14`. Null means the map's own default (`DEFAULT_MAP_CAPACITY`). */
  capacity: z.number().int().positive().nullable(),
  /** `FR-6.8`, moved under `manage-access` in this phase — it is an access
   *  control, and phase 6 only let members change it because there was no other
   *  distinction to check. */
  allowGuests: z.boolean(),
});

export type AccessPolicyDto = z.infer<typeof accessPolicySchema>;

/**
 * Every field optional; absent means "leave it alone".
 *
 * `password: null` clears it and `password: "…"` sets it, which is why the field
 * is nullable rather than merely optional — there would otherwise be no way to
 * express "remove the password" that was not also "do not touch the password".
 */
export const accessPolicyUpdateSchema = z
  .object({
    locked: z.boolean().optional(),
    password: z.string().min(4).max(200).nullable().optional(),
    allowlistEnabled: z.boolean().optional(),
    capacity: z.number().int().positive().max(10_000).nullable().optional(),
    allowGuests: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'nothing to update',
  );

export type AccessPolicyUpdate = z.infer<typeof accessPolicyUpdateSchema>;

/** `FR-7.13`. Keyed by email because an allowlist has to be able to name somebody
 *  who has not registered yet — that is what an allowlist is for. */
export const allowlistEntrySchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(320),
});

export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Roles over HTTP — FR-7.3
// ─────────────────────────────────────────────────────────────────────────────

/** One member of the Space, as the roles screen lists them. */
export const spaceMemberSchema = z.object({
  accountId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  joinedAt: z.string(),
  /** Whether they are standing in the world right now, so a moderator can tell
   *  "kick" from "ban" without guessing. */
  online: z.boolean(),
});

export type SpaceMemberDto = z.infer<typeof spaceMemberSchema>;

/**
 * `FR-7.3` — assign or revoke.
 *
 * `owner` is not accepted here; the schema refuses it rather than the service,
 * so the transfer path cannot be reached by a body that merely looks ordinary.
 */
export const roleUpdateSchema = z.object({
  role: z.enum(['guest', 'member', 'admin']),
});

export type RoleUpdate = z.infer<typeof roleUpdateSchema>;

/** The Rules' "explicit ownership-transfer path". A separate endpoint, a separate
 *  capability, and it names the successor rather than merely stepping down —
 *  a Space with no owner has nobody who can appoint one. */
export const ownershipTransferSchema = z.object({
  accountId: z.string().min(1).max(64),
});

export type OwnershipTransfer = z.infer<typeof ownershipTransferSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// DC-7.3 / DC-7.6 / DC-7.7 — bans, reports and the audit log, as read back
// ─────────────────────────────────────────────────────────────────────────────

export const banSchema = z.object({
  id: z.string(),
  /** Null for a guest ban — there is no account to name. */
  accountId: z.string().nullable(),
  displayName: z.string(),
  /** `guest` bans key on a browser fingerprint and an address, and both are
   *  weak. Stated on the wire so the interface can say so at the moment it
   *  matters rather than in documentation nobody reads. */
  kind: z.enum(['account', 'guest']),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  /** ISO 8601, or null for permanent (`FR-7.8`). */
  expiresAt: z.string().nullable(),
  liftedAt: z.string().nullable(),
});

export type BanDto = z.infer<typeof banSchema>;

/** `FR-7.8` from the HTTP side — banning somebody who is not currently here. */
export const banCreateSchema = z.object({
  accountId: z.string().min(1).max(64),
  reason: z.string().trim().max(280).optional(),
  durationMinutes: z.number().int().positive().max(5_256_000).optional(),
});

export type BanCreateRequest = z.infer<typeof banCreateSchema>;

/** `DC-7.6` — with the context captured when it was filed. */
export const reportRecordSchema = z.object({
  id: z.string(),
  reporterName: z.string(),
  targetName: z.string(),
  /** Durable where the party had a durable identity, session-scoped otherwise.
   *  A report about a guest who has left names somebody nothing can resolve, and
   *  the record says so rather than pretending. */
  targetIdentity: z.string(),
  reason: z.string().nullable(),
  /** Where it happened — `FR-7.17`'s "optional context", captured server-side. */
  context: z.object({
    mapId: z.string(),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    zoneIds: z.array(z.string()),
  }),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().nullable(),
});

export type ReportDto = z.infer<typeof reportRecordSchema>;

/** `DC-7.7` — one row of the append-only record (`FR-7.19`). */
export const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorName: z.string(),
  actorIdentity: z.string(),
  action: z.string(),
  targetName: z.string().nullable(),
  targetIdentity: z.string().nullable(),
  /** Action-specific parameters — a ban's duration, a role change's before and
   *  after. Free-form because the alternative is a column per action type. */
  detail: z.record(z.string(), z.unknown()),
});

export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

/**
 * Everything a moderation screen needs in one response.
 *
 * One call rather than four, because the screen is useless with three of them:
 * a members list with no roles, or a ban list with no audit trail, is a view
 * somebody would have to reconcile by hand.
 */
export const moderationOverviewSchema = z.object({
  role: roleSchema,
  capabilities: z.array(capabilitySchema),
  access: accessPolicySchema,
  members: z.array(spaceMemberSchema),
  bans: z.array(banSchema),
  reports: z.array(reportRecordSchema),
  audit: z.array(auditEntrySchema),
});

export type ModerationOverviewDto = z.infer<typeof moderationOverviewSchema>;

/**
 * How long a kicked participant is refused a rejoin — the "short instance
 * denylist" the Phase 7 implementation notes ask for.
 *
 * `FR-7.7` says a kicked user "may rejoin only if not also banned", so this
 * cannot be long: it is not a punishment, it is the gap that stops a client whose
 * reconnect logic is already running from being back before the moderator's
 * finger has left the button. Ten seconds is comfortably more than one backoff
 * step (`NFR-23` starts at 500 ms) and comfortably less than anybody would call
 * a ban.
 */
export const KICK_COOLDOWN_MS = 10_000;

/** `FR-7.14`, and it must agree with `FR-8.8` — see the Phase 7 Rules. Until
 *  instancing exists there is one instance, so "refuse" is the only policy that
 *  can be implemented honestly, and this is the number it refuses at. */
export const DEFAULT_MAP_CAPACITY = TUNING.DEFAULT_MAP_CAPACITY;
