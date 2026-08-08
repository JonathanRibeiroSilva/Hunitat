/**
 * Spaces, Maps and Map Instances — phase 8.
 *
 * ── What this file is for ───────────────────────────────────────────────────
 *
 * Phases 1–7 were built against exactly one Map running as exactly one World
 * Instance, and every frame that mentions a place could get away with mentioning
 * none. This file is what stops being true: a Space holds several Maps, a Map
 * runs as one or more Instances, and a participant is in precisely one of them
 * at a time (`FR-8.4`).
 *
 * Three shapes carry that on the wire, and they are deliberately separate:
 *
 *   `SPACE_DIRECTORY` — where everybody is, at the granularity `FR-8.12` asks
 *   for. Read-only, refreshed on change.
 *
 *   `NAVIGATE` — a request to be somewhere else (`FR-8.13`, `FR-8.14`). The
 *   client names a destination; the server decides which *instance* of it,
 *   because capacity and grouping are its business and not the client's.
 *
 *   `MAP_TRANSFER` — the answer, and the only frame in the protocol that
 *   re-establishes a whole world. It carries what `JOINED` carries about a
 *   place, and deliberately none of what `JOINED` carries about a person: an
 *   identity does not change because somebody walked through a door.
 *
 * ── One number, two requirements ────────────────────────────────────────────
 *
 * Capacity is `FR-7.14` at the Space door and `FR-8.8` at instance assignment,
 * and the Phase 8 notes are explicit that one configured policy has to be
 * evaluated by one function or the two will disagree. The shapes here are what
 * that function reads and writes; the function itself is
 * `InstanceAssignmentService.assign`.
 */

import { z } from 'zod';
import { TUNING } from './constants.js';
import { chatChannelSchema, mediaGrantSchema, transformSchema } from './messages.js';

// ─────────────────────────────────────────────────────────────────────────────
// DC-8.4 Instance Assignment Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `FR-8.9` — how a participant is placed into one instance of a Map.
 *
 * Two policies rather than three, and `FollowMember` is deliberately absent from
 * the list. Following somebody is a property of a *request* ("take me to Ana"),
 * not of a Map, and making it configurable per Map would mean a Space could be
 * set up in which "go to a member" quietly did not.  The Phase 8 notes name all
 * three as strategies; here the first two are the Map's standing rule and the
 * third is a preferred instance the caller supplies, which every policy honours
 * when there is room (see `InstanceAssignmentService`).
 *
 *   `fill-then-spill` — the default, and the one that keeps colleagues together.
 *   Everybody lands in the lowest-numbered instance that has room, so a team
 *   arriving over five minutes arrives in one place.
 *
 *   `least-loaded` — spreads arrivals evenly. Right for a Map that exists to be
 *   busy in parallel (a support desk, a games room) and wrong for one where
 *   people expect to find each other.
 */
export const INSTANCING_POLICIES = ['fill-then-spill', 'least-loaded'] as const;
export const instancingPolicySchema = z.enum(INSTANCING_POLICIES);
export type InstancingPolicy = z.infer<typeof instancingPolicySchema>;

/**
 * `FR-8.8` — what happens when every instance of a Map is full.
 *
 * `instance` allocates another one, up to `MAX_INSTANCES_PER_MAP`. `refuse`
 * turns the Map away with a clear reason, which is what phase 7 could implement
 * on its own and what a Map that is *meant* to be one room still wants.
 *
 * The refusal is not a lesser outcome. `FR-8.10` makes two instances of a room
 * unable to see or hear each other, and for a room whose whole purpose is that
 * everybody in it is together, silently splitting the group is worse than saying
 * it is full.
 */
export const OVERFLOW_RULES = ['instance', 'refuse'] as const;
export const overflowRuleSchema = z.enum(OVERFLOW_RULES);
export type OverflowRule = z.infer<typeof overflowRuleSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// DC-8.5 Space Directory — the wire shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One live instance of a Map, as the directory lists it.
 *
 * `label` exists because `FR-8.10` is as much a user-interface requirement as a
 * technical one: two people in different instances of the same room, unable to
 * see each other, is baffling unless something on screen says so. A name — "Head
 * Office", "Head Office (2)" — is that something, and it is produced on the
 * server so every client says the same thing.
 */
export const instanceSummarySchema = z.object({
  instanceId: z.string().min(1),
  /** 0 is the original. `FR-8.11` never reaps it. */
  index: z.number().int().nonnegative(),
  label: z.string(),
  occupancy: z.number().int().nonnegative(),
  /** At capacity — a "go to" that named it would spill, so the interface can
   *  say so rather than appear to ignore the click. */
  full: z.boolean(),
});

export type InstanceSummaryDto = z.infer<typeof instanceSummarySchema>;

export const mapDirectoryEntrySchema = z.object({
  mapId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string(),
  /** `FR-8.7` — where an arrival with nothing else to go on lands. */
  isDefault: z.boolean(),
  capacity: z.number().int().positive(),
  /** `FR-8.12` — across every instance, which is the number a person means when
   *  they ask how busy a room is. */
  occupancy: z.number().int().nonnegative(),
  /** Empty when nobody is there: an instance is allocated on arrival, and a Map
   *  nobody is in is running nothing (`FR-8.11`). */
  instances: z.array(instanceSummarySchema).default([]),
  /** `FR-8.13` — whether *this* viewer may navigate straight there. False is
   *  drawn as a disabled entry with a reason, never as an absent one: a Map you
   *  cannot enter but can see people in still has to be explicable. */
  reachable: z.boolean().default(true),
  /** Present when `reachable` is false. */
  reason: z.string().optional(),
});

export type MapDirectoryEntryDto = z.infer<typeof mapDirectoryEntrySchema>;

/**
 * `FR-8.14` — one person, and enough to go to them.
 *
 * Restricted to members of the Space. A guest gets counts and no names, which is
 * the "subject to permissions" in `FR-8.12` given the only reading that is
 * defensible without inventing a permission this phase does not have: somebody
 * who has not been invited into a Space should not be handed a live map of where
 * every employee in it is standing.
 */
export const directoryPersonSchema = z.object({
  sessionId: z.string().min(1),
  displayName: z.string(),
  mapId: z.string().min(1),
  instanceId: z.string().min(1),
  /** True when they are in the viewer's own instance — which is exactly when
   *  "go to" has nothing to do, and when the two of them can already hear each
   *  other. */
  here: z.boolean(),
});

export type DirectoryPersonDto = z.infer<typeof directoryPersonSchema>;

/**
 * `0xA1 SPACE_DIRECTORY` — `DC-8.5`, pushed on change.
 *
 * Pushed rather than polled, and the whole thing rather than a diff: it is
 * bounded by the number of Maps in a Space times the number of instances of
 * each, and a self-describing document cannot drift out of step with the server
 * the way an accumulated sequence of diffs can after one dropped frame. Same
 * reasoning as `AUDIENCE`, and the same protection — it is only written when its
 * signature changes.
 */
export const spaceDirectorySchema = z.object({
  spaceId: z.string(),
  spaceSlug: z.string(),
  spaceName: z.string(),
  /** Null only on a server with no database, where there is one Map and nothing
   *  to be the default *of*. */
  defaultMapId: z.string().nullable(),
  /** Where the viewer is standing, so the interface can mark it without
   *  re-deriving it from a `MAP_TRANSFER` it may have missed. */
  hereMapId: z.string(),
  hereInstanceId: z.string(),
  maps: z.array(mapDirectoryEntrySchema).default([]),
  /** Empty for a viewer who is not a member — see `directoryPersonSchema`. */
  people: z.array(directoryPersonSchema).default([]),
});

export type SpaceDirectoryDto = z.infer<typeof spaceDirectorySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Client → server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0x8C NAVIGATE` — `FR-8.13`, `FR-8.14`.
 *
 * Three ways to name a destination, checked in this order:
 *
 *   `followSessionId` — "take me to Ana". Resolves to whatever Map *and
 *   instance* she is in, which is what makes `FR-8.14` reuse the assignment path
 *   rather than bypass it: her instance becomes the *preferred* one, and
 *   capacity still decides.
 *   `mapId` — a Map from the directory. The server picks the instance.
 *   `instanceId` — a specific instance, for "join their copy of the room". Still
 *   subject to capacity: a client naming a full instance is spilled, and told.
 *
 * `spawnId` is optional throughout. Absent, the destination Map's own default
 * spawn is used, which is `FR-8.7` applied to arriving anywhere rather than only
 * to arriving in the Space.
 */
export const navigateSchema = z
  .object({
    mapId: z.string().max(64).optional(),
    instanceId: z.string().max(96).optional(),
    followSessionId: z.string().max(128).optional(),
    spawnId: z.string().max(64).optional(),
  })
  .refine(
    (value) =>
      value.mapId !== undefined ||
      value.instanceId !== undefined ||
      value.followSessionId !== undefined,
    'name a map, an instance, or somebody to follow',
  );

export type NavigatePayload = z.infer<typeof navigateSchema>;

/** `0x8D DIRECTORY` — ask for the directory now, rather than waiting for the
 *  next push. Sent when a client opens the panel; the answer is the same frame
 *  the push uses. */
export const directoryRequestSchema = z.object({});

// ─────────────────────────────────────────────────────────────────────────────
// Server → client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0xA0 MAP_TRANSFER` — `FR-8.6`, and the riskiest frame in the phase.
 *
 * Four things move at once when somebody changes Map — instance membership, the
 * LiveKit room, the transform, and the area of interest — and the Phase 8 notes
 * are explicit that a partial failure leaves a participant present in two places
 * or in none. So this is one frame written at the end of one orchestrated
 * server-side method, never a sequence of smaller ones: by the time a client
 * reads it, the move has already happened in full.
 *
 * ── Why the media grant is here and not reused ──────────────────────────────
 *
 * A LiveKit token names a room. Reusing the old one against the new room fails
 * in a way that looks like a media bug rather than an auth bug (Phase 8 notes,
 * sharp edge nº2), so a transfer always carries a freshly-minted grant for the
 * destination — or null, on a server with no SFU, exactly as `JOINED` does.
 *
 * ── What it deliberately does not carry ─────────────────────────────────────
 *
 * No identity, no capabilities, no resume token, no tuning. None of those change
 * because somebody walked through a door, and re-stating them would invite a
 * client to rebuild state that is still perfectly valid — which is how a
 * transfer would come to look like a reconnect.
 */
export const mapTransferSchema = z.object({
  /** Why they moved, so the interface can say "you took the west door" rather
   *  than silently redrawing the world. `evicted` and `archived` are `FR-8.18`:
   *  the Map they were in went away underneath them. */
  reason: z.enum(['portal', 'navigate', 'follow', 'landing', 'evicted', 'archived']),
  mapId: z.string().min(1),
  mapSlug: z.string().min(1),
  mapName: z.string(),
  instanceId: z.string().min(1),
  instanceIndex: z.number().int().nonnegative(),
  /** `FR-8.10` — what to call this copy of the room, on screen. */
  instanceLabel: z.string(),
  /** How many instances of this Map are running. More than one is when the
   *  interface has to explain itself. */
  instanceCount: z.number().int().positive(),
  spawn: transformSchema,
  mapUrl: z.string(),
  mapDocumentUrl: z.string(),
  media: mediaGrantSchema.nullable(),
  /** `FR-5.5` — re-advertised, because a zone channel belongs to the Map that
   *  authored the zone and none of the old ones survive the move. */
  chatChannels: z.array(chatChannelSchema).default([]),
  /** Set when something happened that the participant would otherwise have to
   *  infer: they were spilled into a second instance away from the person they
   *  followed, or moved out of a Map that is being archived. */
  notice: z.string().optional(),
});

export type MapTransferPayload = z.infer<typeof mapTransferSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FR-8.15 – FR-8.18 — the lifecycle surface, over HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Map as an administrator sees it — `DC-8.2`.
 *
 * Everything here is *management* metadata. The Map's contents — geometry,
 * zones, spawns — are the Map Document, they are authored in phase 9, and they
 * are deliberately not on this shape: phase 8 manages Maps as units.
 */
export const mapRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** Null means the Space's own capacity, and that in turn falls back to
   *  `DEFAULT_MAP_CAPACITY`. Three levels, one function reads them. */
  capacity: z.number().int().positive().nullable(),
  instancing: instancingPolicySchema,
  overflow: overflowRuleSchema,
  isDefault: z.boolean(),
  archivedAt: z.string().nullable(),
  /** Live, from the in-memory registry — the authoritative count, since there is
   *  one process (`ADR 0009`). */
  occupancy: z.number().int().nonnegative(),
  instanceCount: z.number().int().nonnegative(),
  /** `FR-9.x` will grow this; phase 8 needs it only to show which document a
   *  Map is running. */
  version: z.number().int().nonnegative(),
  /** The geometry the client would download. Shown so an administrator can tell
   *  two Maps apart before entering them. */
  mapUrl: z.string(),
});

export type MapRecordDto = z.infer<typeof mapRecordSchema>;

/** `DC-8.1 Space`, as the management screen lists it. */
export const spaceRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  ownerAccountId: z.string().nullable(),
  ownerName: z.string().nullable(),
  defaultMapId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  occupancy: z.number().int().nonnegative(),
});

export type SpaceRecordDto = z.infer<typeof spaceRecordSchema>;

/**
 * A portal that points at a Map which no longer exists — the Phase 8 Rules'
 * "deleting a Map must not leave dangling portals".
 *
 * `jsonb` gives no foreign key, so this is an explicit scan of every Map
 * Document in the Space for portal targets naming the Map being removed. The
 * scan is the main cost of storing the document as a blob (ADR 0008), and it is
 * paid at delete time rather than at every portal traversal.
 */
export const brokenPortalSchema = z.object({
  mapId: z.string(),
  mapName: z.string(),
  zoneId: z.string(),
  targetMapId: z.string(),
});

export type BrokenPortalDto = z.infer<typeof brokenPortalSchema>;

/** Everything the Space management screen needs in one response — the same
 *  reasoning as `moderationOverviewSchema`: the screen is useless with half of
 *  it, and reconciling four calls by hand is not a thing to ask of a person. */
export const spaceOverviewSchema = z.object({
  space: spaceRecordSchema,
  maps: z.array(mapRecordSchema),
  /** Flagged rather than repaired. A portal pointing nowhere is an authoring
   *  decision to make, and silently rewriting somebody's map is not this phase's
   *  business. */
  brokenPortals: z.array(brokenPortalSchema).default([]),
  /** What this caller may do here, so the screen does not draw buttons the
   *  server will refuse (`NFR-34` — advisory in one direction only). */
  canManageMaps: z.boolean(),
  canManageSpace: z.boolean(),
});

export type SpaceOverviewDto = z.infer<typeof spaceOverviewSchema>;

/**
 * `FR-8.15` — add a Map to a Space.
 *
 * `document` is the Map Document to run, and it is optional: without one the
 * Map is created from the Space's starter document, which is what makes "create
 * a Map" a thing an administrator can do before phase 9 exists to author one.
 * The schema for it is `mapDocumentSchema`, validated in the service rather than
 * inlined here — this file must not import the document schema, or every client
 * that only wants to name a Map pulls in the whole geometry format.
 */
export const mapCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  name: z.string().trim().min(1).max(128),
  capacity: z.number().int().positive().max(10_000).nullable().optional(),
  instancing: instancingPolicySchema.optional(),
  overflow: overflowRuleSchema.optional(),
  /** Copy the contents of an existing Map rather than starting from the
   *  starter document. The cheapest way to get a second room that is laid out
   *  like the first. */
  copyFromMapId: z.string().max(64).optional(),
  /** Make it the Space's landing Map on creation (`FR-8.7`). */
  makeDefault: z.boolean().optional(),
});

export type MapCreateRequest = z.infer<typeof mapCreateSchema>;

/** `FR-8.16` — every field optional; absent means "leave it alone". */
export const mapUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    capacity: z.number().int().positive().max(10_000).nullable().optional(),
    instancing: instancingPolicySchema.optional(),
    overflow: overflowRuleSchema.optional(),
    /** `FR-8.17`. True archives, false restores. Archiving moves out whoever is
     *  standing there (`FR-8.18`). */
    archived: z.boolean().optional(),
    makeDefault: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'nothing to update',
  );

export type MapUpdateRequest = z.infer<typeof mapUpdateSchema>;

/** `FR-8.15` — create a Space. The creator becomes its owner, because a Space
 *  with no owner has nobody who can appoint one (the same rule `RolesService`
 *  applies to the founding member of the first Space). */
export const spaceCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'),
  name: z.string().trim().min(1).max(128),
});

export type SpaceCreateRequest = z.infer<typeof spaceCreateSchema>;

/**
 * `FR-8.16`, `FR-8.17` — configure or archive a Space.
 *
 * Named `settings` rather than `update` because phase 6 already published
 * `spaceUpdateRequestSchema` for `PATCH /spaces/:slug` — the one Space property
 * it defined behaviour for, `allowGuests` — and that route, that schema and the
 * client and harness calls to it all still work. Phase 8's fields are a
 * different question about the same row (who owns it, where people land,
 * whether it is retired), asked at `PATCH /spaces/:slug/settings`.
 *
 * Folding them together would have meant rewriting a phase 6 endpoint to add
 * fields with a different capability requirement — `manage-access` for the first,
 * `manage-space` for these — which is one route with two answers to "may I call
 * this".
 */
export const spaceSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    defaultMapId: z.string().max(64).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'nothing to update',
  );

export type SpaceSettingsUpdate = z.infer<typeof spaceSettingsSchema>;

/**
 * `FR-8.17` — deletion is confirmed by naming the thing.
 *
 * A typed slug rather than a boolean, and not as ceremony: delete is durable
 * removal of every Map, every version and everything that referenced them, and a
 * `?confirm=true` is one mis-click on the wrong row. Typing the slug is the only
 * confirmation that cannot be given by accident.
 */
export const deleteConfirmationSchema = z.object({
  confirm: z.string().min(1).max(64),
});

export type DeleteConfirmation = z.infer<typeof deleteConfirmationSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to call one instance of a Map — `FR-8.10`'s user-interface half.
 *
 * Instance 0 is called by the Map's own name, because in the overwhelmingly
 * common case there is only one and "Head Office (1)" would invent a distinction
 * nobody needs. The moment a second exists, both are numbered from one — so a
 * person who was in "Head Office" and is now told they are in "Head Office (1)"
 * has been told something true and useful: there is now more than one.
 *
 * One function, on the server, so every client says the same thing.
 */
export function instanceLabel(mapName: string, index: number, instanceCount: number): string {
  if (instanceCount <= 1) return mapName;
  return `${mapName} (${index + 1})`;
}

/** The id of one instance. Derived rather than random so a directory entry and a
 *  `NAVIGATE` naming it survive a process that has re-allocated the instance —
 *  and so a log line says which copy of which room. */
export function instanceIdOf(mapId: string, index: number): string {
  return `${mapId}#${index}`;
}

export function parseInstanceId(id: string): { mapId: string; index: number } | null {
  const separator = id.lastIndexOf('#');
  if (separator <= 0) return null;
  const index = Number(id.slice(separator + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { mapId: id.slice(0, separator), index };
}

/**
 * `FR-8.11` — how long an empty instance is kept before it is reclaimed.
 *
 * The delay is the whole mechanism, not a detail of it. An instance that
 * momentarily empties as the last two people walk through a portal must not be
 * torn down and immediately recreated by the third person arriving a second
 * later — and instance ids are stable, so a reap-and-recreate cycle would hand
 * out the same id for a different set of people.
 *
 * Re-exported from `TUNING` so the reason lives next to the requirement.
 */
export const INSTANCE_REAP_AFTER_MS = TUNING.INSTANCE_REAP_AFTER_MS;

/** `FR-8.8` — the ceiling on how far a Map may spill. Past it, entry is refused
 *  with the capacity message rather than allocating an eleventh copy of a room
 *  nobody can find each other in. */
export const MAX_INSTANCES_PER_MAP = TUNING.MAX_INSTANCES_PER_MAP;

/** `FR-8.12` — how often the directory is recomputed. Off the tick: per-map
 *  counts change a few times a minute, and rebuilding a document twenty times a
 *  second to send it none of those times is work spent producing an unchanged
 *  string. */
export const DIRECTORY_REFRESH_MS = TUNING.DIRECTORY_REFRESH_MS;
