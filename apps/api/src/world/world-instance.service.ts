/**
 * WorldInstanceService — the live world (DC-1.4), now several of them (DC-8.3).
 *
 * Owns the participant registry, the 20 Hz tick, and area-of-interest fan-out.
 * All of it lives in process memory: it dies with the WebSocket connections on
 * restart, and clients rebuild from nothing on reconnect, so there is nothing
 * worth persisting (ADR 0009).
 *
 * The server runs NO physics. Clients are authoritative over their own
 * transforms (ADR 0004); this service stores what they report, filters it by
 * interest, and fans it out. It retains one override — forceTransform — for
 * spawn, portals (FR-3.14), moderator respawn (FR-7.9) and, from phase 8, map
 * transfer (FR-8.6).
 *
 * ── What phase 8 changed ────────────────────────────────────────────────────
 *
 * Until now there was one world. There are now several — a Space holds many Maps
 * (`FR-8.1`) and a busy Map runs as several instances (`FR-8.8`) — and a
 * participant is in exactly one of them at a time (`FR-8.4`).
 *
 * The registries stay flat and session-keyed: `participants` and `connections`
 * still hold everybody, because a ban, a role change, a resume token and a
 * durable identity are all facts about a *person* and are the same wherever they
 * are standing. What became per-instance is everything spatial — the grid, zone
 * occupancy, interest and audience — and it is per-instance **structurally**:
 * `MapInstance` owns its own member set and its own grid, and no query spans
 * two. That is `FR-8.10`'s isolation, and it is a property of the shape rather
 * than of a filter somebody has to remember to apply.
 *
 * ── The one method to read carefully ────────────────────────────────────────
 *
 * `transfer`. The Phase 8 notes name map transfer as the riskiest operation in
 * the phase: four things move at once — instance membership, LiveKit room,
 * transform and area of interest — and a partial failure leaves a participant
 * present in two places or in none. It is one orchestrated method with an
 * explicit rollback and a re-entrancy guard, and it is the only place any of
 * those four are changed together.
 */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CAPABILITIES,
  DIRECTORY_REFRESH_MS,
  INSTANCE_REAP_AFTER_MS,
  INTERACT_RANGE_M,
  KICK_COOLDOWN_MS,
  MAX_INSTANCES_PER_MAP,
  NO_MODERATION,
  Op,
  appearanceForSeed,
  emoteById,
  encodeJsonFrame,
  encodeTransformBatch,
  instanceLabel,
  parseInstanceId,
  type AudienceEntryPayload,
  type AvatarAppearance,
  type BatchEntry,
  type ChatChannelDto,
  type MapDirectoryEntryDto,
  type NavigatePayload,
  type ParticipantDto,
  type ParticipantModeration,
  type PresenceStatus,
  type Role,
  type SpaceDirectoryDto,
  type Transform,
  type Zone,
} from '@hubitat/protocol';
import {
  applyMediaBudget,
  computeAoi,
  computeZoneOccupancy,
  isInSpotlight,
  privateZoneOf,
  resolveAudience,
  symmetricBlocks,
  type AoiConfig,
  type AudienceConfig,
  type AudienceParticipant,
  type BlockLookup,
  type MediaBudget,
  type ZoneConfig,
} from '@hubitat/world-core';
import type { RuntimeConfig } from '../config/tuning.config.js';
import { loadConfig } from '../config/tuning.config.js';
import type { GuestSessionView, SessionIdentity } from '../auth/identity-bridge.js';
import { MediaService } from '../media/media.service.js';
import { MapService } from './map.service.js';
import { MapInstance, type ParticipantPoint } from './map-instance.js';
import { MapRegistry, type CatalogueChange, type MapRecord } from './map-registry.service.js';
import { assignInstance, type InstanceLoad } from './instance-assignment.js';
import {
  generateDisplayName,
  identityOf,
  type Connection,
  type Participant,
} from './participant.js';

/**
 * What the gateway hands in after resolving an access token — phase 6.
 *
 * Structurally `ResolvedAccount` from the auth module, redeclared here rather
 * than imported so this service does not depend on `AccountService`. The world
 * has no business knowing how a token becomes a person; it needs only the
 * answer.
 */
export interface AuthenticatedIdentity {
  accountId: string;
  displayName: string;
  appearance: AvatarAppearance;
  statusPreference: PresenceStatus;
  member: boolean;
  /** Phase 7, `FR-7.1`. Resolved by the gateway from `memberships` before the
   *  participant exists, so nobody is ever briefly the wrong role. */
  role: Role;
}

/** What the gateway learned about the connection itself, as opposed to about the
 *  person on it. Both fields exist only to give a guest ban something to key on
 *  (`FR-7.8`), and are read for nothing else. */
export interface ConnectionOrigin {
  fingerprint: string | null;
  ip: string | null;
}

/**
 * Distance granularity in the AUDIENCE change signature, in metres.
 *
 * Coarse enough that walking does not re-send the frame every tick, fine enough
 * that the simulcast layer the client picks from `distanceM` is never more than
 * this far out of date. Two metres over a 12 m audible range is six steps.
 */
const DISTANCE_BUCKET_M = 2;

/**
 * Drop duplicate accessories.
 *
 * The schema bounds the array's length and its members, which still admits the
 * same hat listed three times — a well-formed frame that costs every viewer a
 * duplicated draw. Cheaper to fix once here than to make fifteen renderers
 * defensive.
 */
function normalizeAppearance(appearance: AvatarAppearance): AvatarAppearance {
  return { ...appearance, accessories: [...new Set(appearance.accessories)] };
}

/** Both sides are normalized, so accessories compare as ordered sets. */
function sameAppearance(a: AvatarAppearance, b: AvatarAppearance): boolean {
  return (
    a.baseModel === b.baseModel &&
    a.colors.skin === b.colors.skin &&
    a.colors.hair === b.colors.hair &&
    a.colors.top === b.colors.top &&
    a.colors.bottom === b.colors.bottom &&
    a.accessories.length === b.accessories.length &&
    a.accessories.every((id) => b.accessories.includes(id))
  );
}

/** DC-3.3 — what a subscriber to the trigger stream receives. */
export interface ZoneTriggerEvent {
  sessionId: string;
  localId: number;
  zoneId: string;
  zoneType: Zone['type'];
  kind: 'enter' | 'exit';
  /** The authored `key` of a trigger zone, when it has one. */
  key?: string;
  at: number;
}

/** `FR-8.5`, `FR-8.6`, `FR-8.13`, `FR-8.14` — one move, however it was asked
 *  for. */
export interface TransferRequest {
  mapId?: string | undefined;
  instanceId?: string | undefined;
  followSessionId?: string | undefined;
  spawnId?: string | undefined;
  reason: 'portal' | 'navigate' | 'follow' | 'landing' | 'evicted' | 'archived';
  /** Overrides the notice the transfer would otherwise compute — used by
   *  `FR-8.18`, where the reason somebody moved is not a door they walked
   *  through. */
  notice?: string;
}

export interface TransferOutcome {
  ok: boolean;
  code?: 'map-unavailable' | 'map-full' | 'internal';
  message?: string;
}

@Injectable()
export class WorldInstanceService {
  private readonly logger = new Logger(WorldInstanceService.name);
  private readonly config: RuntimeConfig = loadConfig();

  private readonly participants = new Map<string, Participant>();
  private readonly connections = new Map<string, Connection>();
  /** Reverse index for resume: token → sessionId. */
  private readonly resumeTokens = new Map<string, string>();

  /**
   * `DC-8.3` — every live copy of every Map, keyed by `<mapId>#<index>`.
   *
   * The complete truth about where everybody is, and the only one: with a single
   * process the in-memory map *is* authoritative, so `FR-8.12`'s per-map counts
   * are read straight off this rather than aggregated from anywhere (ADR 0009,
   * and the Phase 8 notes say it in so many words).
   */
  private readonly instances = new Map<string, MapInstance>();

  /**
   * `FR-7.7` — identities refused a rejoin for the next few seconds.
   *
   * The "short instance denylist" the Phase 7 notes ask for, and it is not a
   * punishment: a kicked client's reconnect backoff (`NFR-23`) starts at 500 ms,
   * so without it a kick is followed by the same person reappearing before the
   * moderator's finger has left the button, and the moderator concludes the
   * feature is broken. `KICK_COOLDOWN_MS` is deliberately far shorter than
   * anybody would call a ban — a kicked user "may rejoin only if not also
   * banned" (`FR-7.7`), and this is what makes the rejoin *feel* like a
   * decision rather than a race.
   *
   * Space-wide rather than per instance, which is what it always meant: being
   * kicked out of a room you may walk back into through the other door is not
   * being kicked.
   */
  private readonly kickCooldowns = new Map<string, number>();

  /**
   * `FR-7.16` — the block lookup the tick consults, built once.
   *
   * A field rather than a fresh object per tick because `fanOutAudience` passes
   * it into `resolveAudience` once per listener: allocating a closure fifty times
   * a tick, twenty times a second, for a function that reads one Set is exactly
   * the kind of thing the `NFR-7` budget is spent on by accident.
   *
   * The symmetry rule itself lives in `world-core`, so the audience path and the
   * chat path cannot disagree about what a block means.
   */
  private readonly blockLookup: BlockLookup = symmetricBlocks(
    (sessionId) => this.participants.get(sessionId)?.blockedSessions,
  );

  private readonly aoiConfig: AoiConfig;
  private readonly zoneConfig: ZoneConfig;
  private readonly audienceConfig: AudienceConfig;
  private readonly mediaBudget: MediaBudget;

  /**
   * FR-3.17 — the trigger stream other systems consume.
   *
   * A plain listener list rather than Nest's event emitter: this fires inside the
   * tick, and the tick has a 50 ms budget (NFR-7) that an injected event bus with
   * its own dispatch machinery would eat into for no benefit. Phase 10 subscribes
   * here for object interaction; the ZONE_EVENT frame is simply the first
   * subscriber.
   */
  private readonly zoneListeners = new Set<(event: ZoneTriggerEvent) => void>();

  /**
   * `FR-5.5` — what chat channels a participant currently has, supplied by
   * `ChatService`.
   *
   * A registered function rather than an injected service, and the same
   * arrangement `IdentityBridge` and `WorldModerationBridge` use for the same
   * reason: `ChatService` depends on this class, so an import the other way is a
   * cycle. `MAP_TRANSFER` has to carry the destination's channels — a zone
   * channel belongs to the Map that authored the zone, and none of the old ones
   * survive the move — and computing them here would be a second implementation
   * of a decision phase 5 already owns.
   */
  private chatChannels: ((participant: Participant) => ChatChannelDto[]) | null = null;

  private nextLocalId = 1;
  private tickTimer: NodeJS.Timeout | null = null;
  private unsubscribeCatalogue: (() => void) | null = null;

  /** Rolling tick duration, exposed on /health so NFR-7 degradation is visible
   *  before users report it. */
  private lastTickMs = 0;

  /** `FR-8.12` — the last directory written to each connection, so an unchanged
   *  one is not re-sent every second. Same protection as the AUDIENCE signature,
   *  for the same reason. */
  private readonly directorySignatures = new Map<string, string>();
  private lastDirectoryAt = 0;

  constructor(
    private readonly maps: MapService,
    private readonly registry: MapRegistry,
    private readonly media: MediaService,
  ) {
    this.aoiConfig = {
      enterRadius: this.config.aoiEnterRadiusM,
      exitRadius: this.config.aoiExitRadiusM,
      cellSize: this.config.aoiCellSizeM,
    };
    this.zoneConfig = { hysteresisM: this.config.zoneHysteresisM };
    this.audienceConfig = {
      maxAudibleDistanceM: this.config.maxAudibleDistanceM,
      maxVisibleDistanceM: this.config.maxVisibleDistanceM,
      hysteresisM: this.config.audioHysteresisM,
      refDistanceM: this.config.audioRefDistanceM,
      rolloffFactor: this.config.audioRolloffFactor,
      spotlightGain: this.config.spotlightGain,
      privateZoneGain: this.config.privateZoneGain,
    };
    this.mediaBudget = {
      maxConcurrentAudio: this.config.maxConcurrentAudio,
      maxConcurrentVideo: this.config.maxConcurrentVideo,
    };
  }

  /** FR-3.17 — subscribe to enter/exit. Returns an unsubscribe. */
  onZoneEvent(listener: (event: ZoneTriggerEvent) => void): () => void {
    this.zoneListeners.add(listener);
    return () => this.zoneListeners.delete(listener);
  }

  /** `FR-5.5` — see the field. Called once by `ChatService` at bootstrap. */
  provideChatChannels(provider: (participant: Participant) => ChatChannelDto[]): void {
    this.chatChannels = provider;
  }

  get runtimeConfig(): RuntimeConfig {
    return this.config;
  }

  start(): void {
    if (this.tickTimer) return;
    const intervalMs = Math.round(1000 / this.config.tickRateHz);
    this.tickTimer = setInterval(() => this.tick(), intervalMs);

    // `FR-8.18` — a Map that is archived or deleted must not leave the people
    // standing in it in a broken instance. The catalogue is the only thing that
    // knows it happened, and this is the only thing that can move them.
    this.unsubscribeCatalogue = this.registry.onChange((change) => this.onCatalogueChange(change));

    this.logger.log(`World tick started at ${this.config.tickRateHz} Hz (${intervalMs} ms)`);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.unsubscribeCatalogue?.();
    this.unsubscribeCatalogue = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Instances — DC-8.3, FR-8.8 – FR-8.11
  // ───────────────────────────────────────────────────────────────────────────

  /** The instance a session is in, or undefined for somebody who has left. */
  instanceOf(sessionId: string): MapInstance | undefined {
    const participant = this.participants.get(sessionId);
    if (!participant) return undefined;
    return this.instances.get(participant.instanceId);
  }

  instanceById(instanceId: string): MapInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** Every live instance of one Map, in index order. */
  instancesOf(mapId: string): MapInstance[] {
    const found: MapInstance[] = [];
    for (const instance of this.instances.values()) {
      if (instance.mapId === mapId) found.push(instance);
    }
    return found.sort((a, b) => a.index - b.index);
  }

  /**
   * `FR-8.8`, `FR-8.9` — put somebody into a copy of a Map.
   *
   * The decision itself is `assignInstance`, which is pure and knows nothing
   * about this class; what happens here is the part that has side effects:
   * allocating an instance when the policy asks for one, and — critically —
   * clearing `emptySince` **before** returning, so the reaper cannot see the
   * instance as abandoned in the window between choosing it and putting somebody
   * in it. The Phase 8 Rules call that out by name: never reap while someone is
   * arriving.
   */
  private acquireInstance(
    map: MapRecord,
    options: { preferredInstanceId?: string | undefined; alreadyCounted?: boolean } = {},
  ): { instance: MapInstance; spilled: boolean } | { refused: 'map-full' } {
    const loads: InstanceLoad[] = this.instancesOf(map.id).map((instance) => ({
      instanceId: instance.id,
      index: instance.index,
      occupancy: instance.members.size,
    }));

    const decision = assignInstance({
      instances: loads,
      capacity: this.registry.capacityOf(map),
      policy: map.instancing,
      overflow: map.overflow,
      preferredInstanceId: options.preferredInstanceId,
      maxInstances: MAX_INSTANCES_PER_MAP,
      ...(options.alreadyCounted ? { alreadyCounted: true } : {}),
    });

    if (decision.kind === 'refuse') return { refused: 'map-full' };

    const instance =
      decision.kind === 'existing'
        ? this.instances.get(decision.instanceId)
        : this.allocateInstance(map, decision.index);

    if (!instance) {
      // The instance was reaped between the load snapshot and this lookup, which
      // one process and a synchronous path make impossible — but returning a
      // refusal beats a non-null assertion that would be a crash if it ever
      // became possible.
      return { refused: 'map-full' };
    }

    // Take the reference before the sweep can see it as empty. See the header of
    // `MapInstance.emptySince`.
    instance.emptySince = null;
    return { instance, spilled: decision.spilled };
  }

  private allocateInstance(map: MapRecord, index: number): MapInstance {
    const instance = new MapInstance(map, index, this.config.aoiCellSizeM);
    this.instances.set(instance.id, instance);
    this.logger.log(
      `Allocated instance ${instance.id} of map "${map.slug}" ` +
        `(${this.instancesOf(map.id).length} running).`,
    );
    return instance;
  }

  private addToInstance(instance: MapInstance, participant: Participant): void {
    instance.members.add(participant.sessionId);
    instance.emptySince = null;
    participant.instanceId = instance.id;
  }

  private removeFromInstance(sessionId: string): MapInstance | undefined {
    const participant = this.participants.get(sessionId);
    if (!participant) return undefined;

    const instance = this.instances.get(participant.instanceId);
    if (!instance) return undefined;

    instance.members.delete(sessionId);
    instance.grid.rebuild([]);
    if (instance.members.size === 0) instance.emptySince = Date.now();
    return instance;
  }

  /**
   * `FR-8.11` — reclaim instances that have been empty long enough.
   *
   * Two rules, and both matter:
   *
   *   **Instance 0 is never reaped.** It is the Map's identity — the room people
   *   name, link to and expect to be there — and re-allocating it costs nothing
   *   while keeping it costs one empty object per Map.
   *
   *   **The delay is the mechanism.** An instance that momentarily empties as the
   *   last two people walk through a portal must not be torn down and instantly
   *   recreated by the third arriving a second later; instance ids are stable and
   *   quoted in the directory, so a reap-and-recreate cycle hands the same id to
   *   a different set of people while somebody is looking at the old one.
   *
   * Reaping never touches an occupied instance, which is the requirement's
   * "without disrupting occupied instances" — and it cannot, because the only
   * candidates are those whose member set is empty.
   */
  private reapInstances(now: number): void {
    for (const [id, instance] of this.instances) {
      if (instance.index === 0) continue;
      if (instance.members.size > 0 || instance.emptySince === null) continue;
      if (now - instance.emptySince < INSTANCE_REAP_AFTER_MS) continue;

      this.instances.delete(id);
      this.logger.log(`Reaped empty instance ${id} after ${INSTANCE_REAP_AFTER_MS / 1000}s.`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Join / leave / resume
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * FR-1.1, FR-1.2, FR-1.3, FR-1.5, and from phase 8 `FR-8.7`.
   *
   * With a valid resume token this REBINDS the existing participant to the new
   * socket rather than creating a second one — the Phase 1 rule that reconnect
   * must not duplicate a participant. A resume keeps the instance it was in,
   * which is the point: reconnecting must not move somebody to another room.
   *
   * A fresh arrival lands on the Space's default Map at a valid spawn, which is
   * `FR-8.7` in one line.
   */
  join(
    connection: Connection,
    requestedName: string | undefined,
    resumeToken: string | undefined,
    requestedAppearance?: AvatarAppearance,
    /**
     * Phase 6, `FR-6.18` — the identity the gateway resolved from the access
     * token, before this call.
     *
     * Absent means a guest, which the gateway has already decided is permitted
     * (`FR-6.8`). Present, it **outranks** whatever the client asked for: the
     * profile is the authority on an account holder's name and appearance
     * (`FR-6.9`), so a stale local copy in a browser cannot overwrite what the
     * person set from another device.
     */
    account?: AuthenticatedIdentity,
    /** Phase 7 — the two signals a guest ban can key on, from the socket rather
     *  than from the person. */
    origin?: ConnectionOrigin,
  ): { participant: Participant; resumed: boolean; instance: MapInstance } {
    const resumed = resumeToken ? this.tryResume(resumeToken) : null;

    if (resumed) {
      resumed.disconnectedAt = null;
      // The origin is re-read on every join, including a resume: a client that
      // reconnected from a different network has a different address, and the
      // ban check that runs before this call has already used the new one.
      if (origin) {
        resumed.fingerprint = origin.fingerprint;
        resumed.ip = origin.ip;
      }
      if (account) {
        // A reconnect that arrives authenticated re-asserts the account, which
        // matters for the one ordering that is otherwise wrong: a guest who
        // upgraded, dropped and resumed inside the window would otherwise come
        // back under their old ephemeral identity.
        resumed.identity = {
          kind: 'account',
          accountId: account.accountId,
          member: account.member,
        };
        resumed.displayName = this.sanitizeName(account.displayName) || resumed.displayName;
        resumed.appearance = normalizeAppearance(account.appearance);
        // Same reasoning as the identity above, one phase later: a role granted
        // or revoked while they were away has to be the one they come back
        // under, or a demoted admin keeps moderating for as long as their
        // resume window lasts.
        resumed.role = account.role;
      } else if (requestedName) {
        resumed.displayName = this.sanitizeName(requestedName);
      }
      this.rotateResumeToken(resumed);

      connection.sessionId = resumed.sessionId;
      connection.joined = true;
      this.resetInterest(connection);
      this.connections.set(resumed.sessionId, connection);

      // The instance they were in is still theirs — a retained participant stays
      // a member of it, which is exactly what stops the reaper taking the room
      // out from under a reconnect. It can still be gone if the Map itself was
      // archived while they were away, in which case they land on the default
      // one like any other arrival.
      const instance = this.instances.get(resumed.instanceId) ?? this.landOnDefault(resumed);

      this.logger.debug(`Resumed session ${resumed.sessionId} (${resumed.displayName})`);
      return { participant: resumed, resumed: true, instance };
    }

    const sessionId = randomUUID();
    const localId = this.allocateLocalId();
    const participant: Participant = {
      sessionId,
      localId,
      // FR-6.9 — the profile wins for an account holder. A guest keeps the phase
      // 1 behaviour exactly: what they typed, or a generated name.
      displayName:
        this.sanitizeName(account?.displayName ?? requestedName) || generateDisplayName(),
      // Filled in by `landOnDefault` below, which is the only thing that knows
      // which Map and which copy of it. Never left unset: every other field on
      // this object is meaningless without a place for it to be true in.
      instanceId: '',
      transform: { x: 0, y: 0, z: 0, yaw: 0 },
      transferring: false,
      flags: 0,
      status: account?.statusPreference ?? 'available',
      activity: 'active',
      lastInputAt: Date.now(),
      joinedAt: Date.now(),
      resumeToken: '',
      disconnectedAt: null,
      zones: new Set(),
      portalCooldownUntil: 0,
      // FR-4.8, and from phase 6 the durable half of it. An account wears what
      // `profiles.avatar_appearance` says; a guest wears what the client
      // remembered, or a distinct-looking one derived from the local id — so a
      // room of people who never opened the customizer is still a room of
      // distinguishable people, which is what `colorForId` gave the phase 1
      // capsules.
      appearance: account
        ? normalizeAppearance(account.appearance)
        : requestedAppearance
          ? normalizeAppearance(requestedAppearance)
          : appearanceForSeed(localId),
      lastEmoteAt: 0,
      chatSendTimes: [],
      lastTypingAt: 0,
      lastTypingKey: '',
      identity: account
        ? { kind: 'account', accountId: account.accountId, member: account.member }
        : { kind: 'guest', accountId: null, member: false },
      // Phase 7. `guest` for anybody with no membership — including a signed-in
      // account that has never redeemed an invite, which is the same person
      // `FR-6.13` calls an account and not a member.
      role: account?.role ?? 'guest',
      moderation: { ...NO_MODERATION },
      moderatedBy: null,
      moderationReason: null,
      moderatedAt: 0,
      blockedSessions: new Set(),
      fingerprint: origin?.fingerprint ?? null,
      ip: origin?.ip ?? null,
    };
    this.rotateResumeToken(participant);

    this.participants.set(sessionId, participant);
    connection.sessionId = sessionId;
    connection.joined = true;
    this.connections.set(sessionId, connection);

    const instance = this.landOnDefault(participant);

    this.logger.debug(
      `Joined ${sessionId} as "${participant.displayName}" in ${participant.instanceId}`,
    );
    return { participant, resumed: false, instance };
  }

  /**
   * `FR-8.7` — put an arrival on the Space's landing Map at a valid spawn.
   *
   * Capacity at the Space door is `FR-7.14` and has already been checked by the
   * time this runs; what can still refuse here is `FR-8.8`, a landing Map that is
   * full. There is nowhere to send somebody who cannot enter the Space's own
   * front room, so the last resort is the instance ceiling rather than a
   * refusal — the alternative is a joined participant with no place to be, which
   * is the state the whole phase is arranged to make unrepresentable.
   */
  private landOnDefault(participant: Participant): MapInstance {
    const map = this.registry.landingMap();
    const acquired = this.acquireInstance(map);

    const instance =
      'instance' in acquired
        ? acquired.instance
        : // Every instance of the landing Map is full and the Map refuses to
          // spill. Rather than leave the participant nowhere, they go into the
          // lowest-indexed instance over capacity and the Space's own capacity
          // check (`FR-7.14`) is what actually keeps the numbers honest — it runs
          // at the door and refuses before this is ever reached.
          (this.instancesOf(map.id)[0] ?? this.allocateInstance(map, 0));

    this.addToInstance(instance, participant);
    // FR-3.7 — the placement rule needs to know who is already standing there,
    // and "there" is this instance rather than the Space.
    participant.transform = this.maps.pickSpawn(
      instance.document,
      this.occupiedPoints(instance, participant.sessionId),
    );
    participant.zones = new Set();
    return instance;
  }

  /** FR-1.4 — voluntary departure, or a socket close with no resume intent.
   *  From phase 7 also `FR-7.7` and `FR-7.8`, which is why the reason is on the
   *  wire: a client that was kicked and one that timed out need different
   *  sentences. */
  leave(sessionId: string, reason: 'left' | 'timeout' | 'kicked' | 'banned' = 'left'): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;

    const instance = this.instances.get(participant.instanceId);

    this.removeFromInstance(sessionId);
    this.participants.delete(sessionId);
    this.connections.delete(sessionId);
    this.resumeTokens.delete(participant.resumeToken);
    this.directorySignatures.delete(sessionId);
    // Everyone who had blocked them keeps the durable block; only the projection
    // onto live session ids has to go, or a session id reused by nobody would
    // sit in fifty Sets for the life of the process.
    for (const other of this.participants.values()) other.blockedSessions.delete(sessionId);

    if (instance) this.broadcastRemoval(instance, participant, reason);
    this.logger.debug(`Removed ${sessionId} (${reason})`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-8.5, FR-8.6, FR-8.13, FR-8.14 — moving between Maps
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Move one participant to another Map, or to another instance of this one.
   *
   * **The riskiest operation in the phase**, and the reason it is one method.
   * Four things move together — instance membership, the LiveKit room, the
   * transform, and the area of interest — and the Phase 8 notes are explicit that
   * a partial failure leaves a participant present in two places or in none. So:
   *
   *   1. Everything that can *refuse* happens first, before anything moves:
   *      resolving the destination, checking it is enterable, and asking the
   *      assignment policy for an instance. A refusal at any point leaves the
   *      participant exactly where they were.
   *   2. The LiveKit token for the destination is minted **before** the world
   *      state changes, because it is the only step that talks to another
   *      process and therefore the only one that can fail slowly. A token that
   *      cannot be minted degrades to no media rather than to a half-move — the
   *      same treatment `JOINED` gives a missing SFU.
   *   3. Only then does the world change, synchronously and in one block: leave
   *      A, join B, place, reset interest, announce.
   *
   * ── The token is per-room, and reusing it is the classic failure ────────────
   *
   * Sharp edge nº2 in the Phase 8 notes: a LiveKit grant names a room, so
   * carrying the old one across a transfer fails in a way that looks like a media
   * bug rather than an auth bug. `MAP_TRANSFER` always carries a freshly minted
   * grant for the destination room, and the client always replaces its
   * connection with it.
   */
  async transfer(sessionId: string, request: TransferRequest): Promise<TransferOutcome> {
    const participant = this.participants.get(sessionId);
    if (!participant) return { ok: false, code: 'internal', message: 'You are not in this world.' };

    // Re-entrancy guard. A portal fires from the tick and a `NAVIGATE` from the
    // socket, and both are asynchronous past the token mint — without this, two
    // overlapping transfers would each remove the participant from an instance
    // and add them to another, and the second would be adding them to a room
    // they had already left.
    if (participant.transferring) {
      return { ok: false, code: 'internal', message: 'You are already going somewhere.' };
    }

    const source = this.instances.get(participant.instanceId);
    const resolved = this.resolveDestination(participant, request);
    if ('refusal' in resolved) return resolved.refusal;

    const { map, spawnId, preferredInstanceId } = resolved;

    if (map.archivedAt) {
      return {
        ok: false,
        code: 'map-unavailable',
        message: `"${map.name}" has been archived and cannot be entered.`,
      };
    }

    const acquired = this.acquireInstance(map, {
      preferredInstanceId,
      // Moving within the instance you are already in does not consume a second
      // slot. Without this, walking through a same-map portal in a full room
      // would refuse you re-entry to the room you are standing in.
      alreadyCounted: preferredInstanceId !== undefined && preferredInstanceId === source?.id,
    });

    if ('refused' in acquired) {
      return {
        ok: false,
        code: 'map-full',
        message:
          `"${map.name}" is full (${this.registry.capacityOf(map)} people per copy). ` +
          `Try again in a few minutes.`,
      };
    }

    const { instance: destination, spilled } = acquired;

    // Same instance, same spawn request: this is a same-map portal, which is
    // phase 3's business and not a transfer at all. Handled by the caller;
    // reaching here means a `NAVIGATE` to where they already are, which is a
    // no-op rather than an error.
    if (destination.id === participant.instanceId && request.reason !== 'portal') {
      return { ok: true };
    }

    participant.transferring = true;
    try {
      // ── Step 2: the only step that can fail slowly ─────────────────────────
      const media = await this.media.grant(
        participant.sessionId,
        participant.displayName,
        participant.moderation,
        destination.mediaRoom(this.media.room),
      );

      // The socket closed while the token was being signed. Nothing has moved
      // yet — this is exactly why the token is minted first — so the participant
      // is left in the instance they were in and their close handler will retain
      // them there.
      const connection = this.connections.get(sessionId);
      if (!connection || connection.socket.readyState !== connection.socket.OPEN) {
        return { ok: false, code: 'internal', message: 'The connection went away.' };
      }

      // ── Step 3: the world changes, synchronously and in one block ──────────

      // Leaving the old instance is announced to the people still in it *before*
      // membership changes anywhere, so nobody is briefly visible in two rooms.
      if (source && source.id !== destination.id) {
        // Their zone occupancy belongs to the map they are leaving. Published as
        // exits so `FR-3.17`'s subscribers — chat channels, phase 10's objects —
        // see a balanced enter/exit pair rather than a participant who silently
        // stopped being in a private zone.
        for (const zoneId of participant.zones) {
          this.publishZoneEvent(source, participant, zoneId, 'exit', Date.now());
        }
        participant.zones = new Set();

        this.removeFromInstance(sessionId);
        this.broadcastRemoval(source, participant, 'left');

        // The SFU half of leaving. Fire-and-forget: the world-side move has
        // already happened, the new token is for a different room, and a slow
        // `removeParticipant` must not hold up an arrival.
        void this.media.removeFromRoom(participant.sessionId, source.mediaRoom(this.media.room));
      }

      this.addToInstance(destination, participant);

      const spawn = this.spawnFor(destination, spawnId, participant.sessionId);
      participant.transform = spawn;
      // A portal that delivered them into another map must not fire again at the
      // destination, and the destination's own portals must not fire on arrival.
      participant.portalCooldownUntil = Date.now() + this.config.portalCooldownMs;

      // The new socket state. Everything the old instance taught this connection
      // has to go, or the client is told about people it has already been told
      // have left — and a remembered audible set would let somebody in the *old*
      // room re-enter at the outer radius without ever having been subscribed.
      this.resetInterest(connection);

      const instanceCount = this.instancesOf(destination.mapId).length;
      this.send(connection, Op.MAP_TRANSFER, {
        reason: request.reason,
        mapId: destination.mapId,
        mapSlug: destination.mapSlug,
        mapName: destination.mapName,
        instanceId: destination.id,
        instanceIndex: destination.index,
        instanceLabel: destination.label(instanceCount),
        instanceCount,
        spawn,
        mapUrl: this.registry.geometryUrl(map),
        mapDocumentUrl: this.registry.documentUrl(map),
        media,
        chatChannels: this.chatChannels?.(participant) ?? [],
        ...(this.transferNotice(request, destination, instanceCount, spilled)
          ? { notice: this.transferNotice(request, destination, instanceCount, spilled) }
          : {}),
      });

      // FR-1.15, one phase later: a transfer is an arrival, and an arrival has to
      // be told who is already here rather than only who moves next.
      this.send(connection, Op.SNAPSHOT, this.snapshotFor(sessionId));

      this.logger.debug(
        `${participant.displayName} moved ${source?.id ?? '(nowhere)'} → ${destination.id} ` +
          `(${request.reason})`,
      );
      return { ok: true };
    } catch (error) {
      this.logger.error(
        `Transfer of ${sessionId} to ${map.slug} failed: ${(error as Error).message}`,
      );
      return { ok: false, code: 'internal', message: 'That move could not be completed.' };
    } finally {
      participant.transferring = false;
    }
  }

  /**
   * Turn a request into a Map, a spawn and a preferred instance.
   *
   * Three ways to name a destination and one order for them, which is the order
   * `NAVIGATE` documents: follow a person, then an instance, then a Map. Following
   * wins because it is the most specific thing somebody can ask for — "wherever
   * Ana is" is an answer that no map id can express.
   */
  private resolveDestination(
    participant: Participant,
    request: TransferRequest,
  ):
    | { map: MapRecord; spawnId: string | undefined; preferredInstanceId: string | undefined }
    | { refusal: TransferOutcome } {
    if (request.followSessionId) {
      const peer = this.participants.get(request.followSessionId);
      const peerInstance = peer ? this.instances.get(peer.instanceId) : undefined;
      if (!peer || !peerInstance || !this.connections.has(peer.sessionId)) {
        return {
          refusal: {
            ok: false,
            code: 'map-unavailable',
            message: 'That person is no longer in this space.',
          },
        };
      }
      const map = this.registry.byId(peerInstance.mapId);
      if (!map) {
        return {
          refusal: {
            ok: false,
            code: 'map-unavailable',
            message: 'That person is somewhere this server can no longer resolve.',
          },
        };
      }
      // `FR-8.14` — their instance is *preferred*, not guaranteed. The
      // assignment path still applies, so following somebody into a full room
      // spills and says so rather than defeating capacity.
      return { map, spawnId: request.spawnId, preferredInstanceId: peerInstance.id };
    }

    if (request.instanceId) {
      const parsed = parseInstanceId(request.instanceId);
      const map = parsed ? this.registry.byId(parsed.mapId) : undefined;
      if (!map) {
        return {
          refusal: { ok: false, code: 'map-unavailable', message: 'That room no longer exists.' },
        };
      }
      return { map, spawnId: request.spawnId, preferredInstanceId: request.instanceId };
    }

    /**
     * No destination named at all — `FR-8.18`.
     *
     * The only caller that reaches this is the eviction path: a Map was archived
     * or deleted underneath somebody, and where they go is not a choice they
     * made. `FR-8.7`'s landing Map is the answer, and it is the same answer an
     * arrival gets, which is what makes "you have been moved to the main map" a
     * true sentence rather than a euphemism for being disconnected.
     *
     * `NAVIGATE` cannot reach it: its schema requires one of the three ways to
     * name a place. The refusal below is for a destination that *was* named and
     * does not resolve — a portal into a deleted Map, or a directory entry that
     * went stale in an open panel.
     */
    const map = request.mapId ? this.registry.resolve(request.mapId) : this.registry.landingMap();
    if (!map) {
      return {
        refusal: {
          ok: false,
          code: 'map-unavailable',
          message: `This space has no map called "${request.mapId}".`,
        },
      };
    }

    // Arriving at a Map with nothing more specific asked for: prefer the
    // instance the participant is already in when it is the same Map — walking
    // out of a door and back in should not move you to a different copy of the
    // room you were just in.
    const current = this.instances.get(participant.instanceId);
    return {
      map,
      spawnId: request.spawnId,
      preferredInstanceId: current?.mapId === map.id ? current.id : undefined,
    };
  }

  /**
   * `FR-8.10`'s sentence, when there is one to say.
   *
   * The requirement is that instance separation is "made understandable to
   * users", and a person who followed a colleague and landed somewhere they
   * cannot see them is the exact case where silence is baffling. Everything else
   * — an ordinary move to a room running one instance — says nothing, because a
   * notice on every doorway is a notice nobody reads.
   */
  private transferNotice(
    request: TransferRequest,
    instance: MapInstance,
    instanceCount: number,
    spilled: boolean,
  ): string | undefined {
    if (request.notice) return request.notice;
    if (!spilled && instanceCount <= 1) return undefined;

    if (spilled && request.reason === 'follow') {
      return (
        `That copy of ${instance.mapName} was full, so you are in ` +
        `${instance.label(instanceCount)}. People in the other copy cannot see or hear you.`
      );
    }
    if (spilled) {
      return (
        `${instance.mapName} was full, so you are in ${instance.label(instanceCount)} — ` +
        `a separate copy of the room. People in the other copies cannot see or hear you.`
      );
    }
    return (
      `You are in ${instance.label(instanceCount)}. ${instanceCount} copies of this room are ` +
      `running and each one is separate — people in the others cannot see or hear you.`
    );
  }

  /** The spawn a transfer arrives at: the one it named, else the Map's default,
   *  placed clear of collision, of other people, and of portals (`FR-3.16`). */
  private spawnFor(
    instance: MapInstance,
    spawnId: string | undefined,
    sessionId: string,
  ): Transform {
    const named = this.maps.spawnById(instance.document, spawnId);
    const spawn = named ?? this.maps.defaultSpawn(instance.document);
    return this.maps.placeInSpawn(
      instance.document,
      spawn,
      this.occupiedPoints(instance, sessionId),
      {
        avoidZones: instance.zones.filter((zone) => zone.type === 'portal'),
        avoidMarginM: this.config.portalExitClearanceM,
      },
    );
  }

  /**
   * `FR-8.13`, `FR-8.14` — the socket-facing entry point.
   *
   * Validation of *who may go where* lives here rather than in `transfer`,
   * because `transfer` is also how `FR-8.18` moves somebody out of a Map that is
   * being archived, and that move is not subject to whether they would have been
   * allowed to ask for it.
   */
  async navigate(sessionId: string, payload: NavigatePayload): Promise<TransferOutcome> {
    const participant = this.participants.get(sessionId);
    if (!participant) return { ok: false, code: 'internal', message: 'You are not in this world.' };

    return this.transfer(sessionId, {
      mapId: payload.mapId,
      instanceId: payload.instanceId,
      followSessionId: payload.followSessionId,
      spawnId: payload.spawnId,
      reason: payload.followSessionId ? 'follow' : 'navigate',
    });
  }

  /**
   * `FR-8.18` — a Map went away underneath the people standing in it.
   *
   * They are moved to the Space's landing Map and told why, rather than being
   * disconnected or left in an instance of something that no longer exists. The
   * difference matters: an archived room is an administrative decision about a
   * room, and answering it by throwing everybody out of the building would be a
   * far bigger consequence than the decision.
   */
  private onCatalogueChange(change: CatalogueChange): void {
    // Names travel with the Map, so a rename has to reach the instances that are
    // already running or the interface keeps calling the room by its old name.
    for (const instance of this.instances.values()) {
      const map = this.registry.byId(instance.mapId);
      if (map) instance.mapName = map.name;
    }

    /**
     * `FR-9.20` — a new version was published under the people standing in it.
     *
     * A notification, and nothing else. The requirement is explicit that
     * publishing must handle occupants gracefully — "apply on next entry or
     * coordinate a smooth reload, not a hard break" — so the running instance
     * keeps the document it was allocated with and the next one reads the new
     * version. What arrives here is the offer of a reload, which the person
     * takes when they are not mid-sentence.
     */
    if (change.kind === 'published') {
      for (const instance of this.instances.values()) {
        if (instance.mapId !== change.mapId) continue;
        for (const sessionId of instance.members) {
          const connection = this.connections.get(sessionId);
          if (!connection) continue;
          this.send(connection, Op.MAP_UPDATED, {
            mapId: change.mapId,
            mapName: instance.mapName,
            version: change.version,
            by: change.by,
            notes: change.notes,
          });
        }
      }
      return;
    }

    if (change.kind === 'created' || change.kind === 'updated') return;

    if (change.kind === 'space-archived') {
      for (const participant of this.participants.values()) {
        const connection = this.connections.get(participant.sessionId);
        if (!connection) continue;
        this.send(connection, Op.ERROR, {
          code: 'space-locked',
          message: 'This space has been archived. You have been signed out of it.',
          fatal: true,
        });
        this.leave(participant.sessionId, 'left');
        connection.socket.close(1000, 'space archived');
      }
      return;
    }

    const affected = [...this.instances.values()].filter(
      (instance) => instance.mapId === change.mapId,
    );
    if (affected.length === 0) return;

    const stranded = affected.flatMap((instance) => [...instance.members]);
    const what = change.kind === 'archived' ? 'archived' : 'removed';

    for (const sessionId of stranded) {
      void this.transfer(sessionId, {
        reason: change.kind === 'archived' ? 'archived' : 'evicted',
        notice: `The room you were in has been ${what}. You have been moved to the main map.`,
      }).then((outcome) => {
        if (outcome.ok) return;
        // Nowhere to put them — the landing Map is full and refuses to spill.
        // Being told and disconnected is the honest outcome; being left in an
        // instance of a Map that no longer exists is the one `FR-8.18` rules out.
        const connection = this.connections.get(sessionId);
        if (connection) {
          this.send(connection, Op.ERROR, {
            code: 'map-unavailable',
            message: `The room you were in has been ${what}, and there is nowhere free to move you to.`,
            fatal: true,
          });
          connection.socket.close(1000, 'map removed');
        }
        this.leave(sessionId, 'left');
      });
    }

    // Instances of a Map that has gone are dropped once they empty, which the
    // transfers above are in the middle of doing. Instance 0 is normally never
    // reaped; a Map that no longer exists is the one exception, because keeping
    // the identity of a deleted room stable serves nobody.
    for (const instance of affected) {
      if (change.kind === 'deleted') this.instances.delete(instance.id);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Moderation (phase 7)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-7.5`, `FR-7.6`, `FR-7.10` — apply a mute or a camera block, live.
   *
   * The world's flags are the authoritative copy and they are written **here**,
   * before anything is asked of the SFU. `ModerationService` calls this and then
   * calls LiveKit; the order matters because the SFU can be slow, unreachable, or
   * absent entirely, and none of those may leave the participant unmuted in the
   * presence list while the moderator watches.
   *
   * `at` is stamped once so the target's client can tell a state it has already
   * announced from a new one — a reconnect re-sends this frame, and a
   * "you have been muted" notice that fired again on every resume would be a
   * moderator shouting.
   */
  setModeration(
    sessionId: string,
    moderation: ParticipantModeration,
    by: { name: string; reason?: string } | null,
  ): boolean {
    const participant = this.participants.get(sessionId);
    if (!participant) return false;

    const unchanged =
      participant.moderation.micMuted === moderation.micMuted &&
      participant.moderation.cameraDisabled === moderation.cameraDisabled;
    if (unchanged) return false;

    participant.moderation = { ...moderation };
    participant.moderatedBy = by?.name ?? null;
    participant.moderationReason = by?.reason ?? null;
    participant.moderatedAt = Date.now();

    // Observers learn the fact. They are not told who did it or why: publishing
    // a moderator's name and their reason to the room turns every mute into an
    // announcement, and the Phase 7 spec asks for the target to be notified, not
    // for everybody to be.
    this.broadcastUpdate(participant, { moderation: participant.moderation });
    this.sendModerationState(participant);
    return true;
  }

  /** `FR-7.5` — the self-only half. Re-sent on resume so a client that
   *  reconnected still knows why its microphone will not turn on. */
  sendModerationState(participant: Participant): void {
    const connection = this.connections.get(participant.sessionId);
    if (!connection) return;

    this.send(connection, Op.MODERATION_STATE, {
      micMuted: participant.moderation.micMuted,
      cameraDisabled: participant.moderation.cameraDisabled,
      ...(participant.moderatedBy ? { byName: participant.moderatedBy } : {}),
      ...(participant.moderationReason ? { reason: participant.moderationReason } : {}),
      at: participant.moderatedAt,
    });
  }

  /**
   * `FR-7.7`, `FR-7.8` — remove somebody from this instance, now.
   *
   * Three things, and leaving out any one of them produces a kick that does not
   * look like one:
   *
   *   1. The target is told **before** the socket closes, with a fatal `ERROR`
   *      carrying the reason. A connection that simply drops is indistinguishable
   *      from a network fault, and the client would reconnect into the cooldown
   *      and report "the server keeps disconnecting me".
   *   2. The participant is removed outright rather than retained for the resume
   *      window — a kick that leaves a resumable session behind is a kick the
   *      target can undo by pressing reload.
   *   3. The identity is put on the short denylist, so the reconnect that is
   *      already in flight does not win the race.
   *
   * The SFU half — `removeParticipant` — is `ModerationService`'s, because this
   * service has no business knowing what an SFU is.
   */
  kick(sessionId: string, message: string, banned: boolean): boolean {
    const participant = this.participants.get(sessionId);
    if (!participant) return false;

    const connection = this.connections.get(sessionId);
    if (connection) {
      this.send(connection, Op.ERROR, {
        code: banned ? 'banned' : 'forbidden',
        message,
        fatal: true,
      });
    }

    // A ban is enforced at the door by `AccessPolicyService`, which is durable
    // and exact; the cooldown is only for the kick case, where there is nothing
    // else to stop an instant rejoin.
    //
    // **Two keys for a guest, and the second is the one that works.** A guest's
    // identity is `guest:<sessionId>`, and the session is destroyed one line
    // below — so a kicked guest reconnecting fresh arrives as a different
    // identity and the cooldown would never match. Their fingerprint is the same
    // browser either way, which is exactly what needs slowing down.
    if (!banned) {
      const until = Date.now() + KICK_COOLDOWN_MS;
      this.kickCooldowns.set(identityOf(participant), until);
      if (participant.fingerprint) {
        this.kickCooldowns.set(`fp:${participant.fingerprint}`, until);
      }
    }

    this.leave(sessionId, banned ? 'banned' : 'kicked');

    // Closed after `leave`, so the removal has been broadcast to everybody else
    // before the socket goes away and the close handler has nothing left to
    // retain.
    connection?.socket.close(1008, banned ? 'banned' : 'kicked');
    return true;
  }

  /**
   * `FR-7.7` — is this identity inside the post-kick cooldown?
   *
   * Consulted by the gateway before a join is accepted. Expired entries are
   * dropped on read rather than swept: the map is bounded by the number of
   * people who have been kicked in the last ten seconds, which is not a number
   * that needs a timer.
   */
  kickedRecently(identity: string): boolean {
    const until = this.kickCooldowns.get(identity);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.kickCooldowns.delete(identity);
      return false;
    }
    return true;
  }

  /**
   * `FR-7.9` — move a disruptive participant to a spawn.
   *
   * The same override portals use, with `reason: "moderation"` so the client can
   * tell the two apart. Placement goes through `placeInSpawn` rather than through
   * the raw spawn point, which means a respawned participant does not land on top
   * of somebody — and, more usefully here, does not land back inside the private
   * zone they were being removed from, because the placement rule is the one
   * Phase 3 already settled.
   *
   * Within their own instance, deliberately. Respawning is about where somebody
   * is standing in a room, and moving them to a different room would be an
   * eviction dressed as a respawn.
   */
  respawn(sessionId: string): boolean {
    const participant = this.participants.get(sessionId);
    const instance = participant ? this.instances.get(participant.instanceId) : undefined;
    if (!participant || !instance) return false;

    const spawn = this.maps.pickSpawn(instance.document, this.occupiedPoints(instance, sessionId));
    this.forceTransform(sessionId, spawn, 'moderation');
    return true;
  }

  /**
   * `FR-7.1`, `FR-7.10` — a role change reaching a session already in the world.
   *
   * Both halves: observers get the role on `PARTICIPANT_UPDATE` so the presence
   * list stops marking a demoted admin as one, and the participant themself gets
   * a fresh `IDENTITY` frame carrying the new capability list, which is what
   * their client draws the moderation controls from.
   */
  setRole(accountId: string, role: Role): number {
    let updated = 0;
    for (const participant of this.participants.values()) {
      if (participant.identity.accountId !== accountId) continue;
      if (participant.role === role) continue;

      participant.role = role;
      // `member` here is membership of the Space (`DC-6.4`), which every role
      // above `guest` implies — revoking a role revokes the membership row it
      // was stored on, so the two cannot disagree.
      participant.identity.member = role !== 'guest';

      this.broadcastUpdate(participant, {
        role,
        identity: { kind: participant.identity.kind, member: participant.identity.member },
      });
      this.sendIdentity(participant);
      updated++;
    }
    return updated;
  }

  /**
   * `FR-7.16` — project a durable block set onto the people who are here.
   *
   * Called at join, and again whenever the blocker changes their list or somebody
   * new arrives. Rebuilt wholesale rather than patched: the set is bounded by
   * `DEFAULT_MAP_CAPACITY`, and a patch would have to know which of the two
   * changed, which is one more thing to get wrong for no measurable gain.
   *
   * The blocker is told which of the people in front of them they have blocked;
   * the blocked party is told nothing, because the Rules require a block not to
   * imply the blocker is offline and telling somebody they have been blocked is
   * the other half of that mistake.
   *
   * Space-wide rather than per instance: a block follows a person between rooms,
   * and rebuilding it on every transfer would leave a window in which somebody
   * they blocked yesterday was audible in a new map.
   */
  applyBlocks(sessionId: string, blockedIdentities: ReadonlySet<string>): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;

    const before = participant.blockedSessions;
    const after = new Set<string>();
    for (const other of this.participants.values()) {
      if (other.sessionId === sessionId) continue;
      if (blockedIdentities.has(identityOf(other))) after.add(other.sessionId);
    }
    participant.blockedSessions = after;

    const connection = this.connections.get(sessionId);
    if (!connection) return;

    // Only the difference is announced. Re-sending the whole set on every join
    // would be one frame per arrival per blocker for a value that almost never
    // changes — and the audience signature already re-sends when a block
    // actually silences somebody.
    for (const id of after) {
      if (!before.has(id)) this.sendBlockState(connection, id, true);
    }
    for (const id of before) {
      if (!after.has(id)) this.sendBlockState(connection, id, false);
    }
  }

  /** Every live session acting under one durable identity — usually zero or one,
   *  more when somebody has two tabs open. A ban has to reach all of them. */
  sessionsOf(identity: string): Participant[] {
    const matches: Participant[] = [];
    for (const participant of this.participants.values()) {
      if (identityOf(participant) === identity) matches.push(participant);
    }
    return matches;
  }

  private sendBlockState(connection: Connection, sessionId: string, blocked: boolean): void {
    const other = this.participants.get(sessionId);
    if (!other) return;
    this.send(connection, Op.PARTICIPANT_UPDATE, { id: other.localId, blocked });
  }

  /**
   * The socket dropped but the participant may come back (FR-1.5).
   *
   * They are removed from everyone else's view straight away and retained only
   * as resumable state. The trade is deliberate: a reconnecting user reappears,
   * rather than never having seemed to leave.
   *
   * They stay a **member of their instance**, which is what stops the reaper
   * taking the room out from under a reconnect that is thirty seconds away.
   */
  markDisconnected(sessionId: string): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;

    participant.disconnectedAt = Date.now();
    this.connections.delete(sessionId);
    this.directorySignatures.delete(sessionId);

    const instance = this.instances.get(participant.instanceId);
    if (instance) this.broadcastRemoval(instance, participant, 'left');
  }

  /**
   * What a resume token currently names, without consuming it.
   *
   * The gateway needs this **before** it decides whether to admit somebody:
   * `FR-7.14`'s capacity check must not refuse a reconnect, since the
   * participant is already counted, and the post-kick denylist has to be checked
   * against the identity the token belongs to rather than against the one the
   * client claims. `tryResume` below is the consuming version and runs after the
   * decision.
   *
   * Null for an expired, unknown, or already-live token — all three mean "this
   * is a fresh arrival", which is what `JOIN` degrades to anyway.
   */
  resumableSessionOf(token: string): { sessionId: string; identity: string } | null {
    const sessionId = this.resumeTokens.get(token);
    if (!sessionId) return null;

    const participant = this.participants.get(sessionId);
    if (!participant) return null;
    if (this.connections.has(sessionId)) return null;
    if (
      participant.disconnectedAt !== null &&
      Date.now() - participant.disconnectedAt > this.config.resumeTokenTtlMs
    ) {
      return null;
    }

    return { sessionId, identity: identityOf(participant) };
  }

  private tryResume(token: string): Participant | null {
    const sessionId = this.resumeTokens.get(token);
    if (!sessionId) return null;

    const participant = this.participants.get(sessionId);
    if (!participant) {
      this.resumeTokens.delete(token);
      return null;
    }

    // A live socket already holds this session: this is not a resume, it is a
    // duplicate. Refuse rather than hijacking the existing connection.
    if (this.connections.has(sessionId)) return null;

    if (
      participant.disconnectedAt !== null &&
      Date.now() - participant.disconnectedAt > this.config.resumeTokenTtlMs
    ) {
      this.leave(sessionId, 'timeout');
      return null;
    }

    return participant;
  }

  private rotateResumeToken(participant: Participant): void {
    if (participant.resumeToken) this.resumeTokens.delete(participant.resumeToken);
    const token = randomUUID();
    participant.resumeToken = token;
    this.resumeTokens.set(token, participant.sessionId);
  }

  /**
   * Everything this connection was told about *a place*, forgotten.
   *
   * Run on resume and on transfer, and the two need exactly the same thing: the
   * socket is about to be told about a world it knows nothing about. An
   * inherited audience signature would suppress the first frame the new world
   * needs, and a remembered audible or visible set would let somebody standing
   * in the hysteresis band re-enter at the outer radius without ever having been
   * subscribed on this connection.
   */
  private resetInterest(connection: Connection): void {
    connection.aoi.clear();
    connection.audienceSignature = '';
    connection.audible.clear();
    connection.visible.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // State updates
  // ───────────────────────────────────────────────────────────────────────────

  /** Client-authoritative: we store what they report, unvalidated (ADR 0004). */
  applyTransform(sessionId: string, transform: Transform, flags: number): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;

    // A transform reported while a transfer is in flight describes the map they
    // are leaving. Dropped rather than stored: applying it would put them at the
    // old map's coordinates in the new map for one tick, which is a visible jump
    // and, worse, one that can land inside the destination's collision.
    if (participant.transferring) return;

    participant.transform = transform;
    participant.flags = flags;
    this.markActive(participant);
  }

  setStatus(sessionId: string, status: Participant['status']): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;
    participant.status = status;
    participant.lastInputAt = Date.now();
    this.broadcastUpdate(participant, { status });
  }

  /**
   * FR-4.5, FR-4.6, FR-4.7 — a customization change, live.
   *
   * No respawn: the appearance is replaced in place and announced, and the
   * client swaps the model at the transform the participant is already standing
   * at. `FR-4.7` permits a respawn; not needing one is better, and moving
   * someone because they changed their shirt would fight every zone rule phase 3
   * settled.
   */
  setAppearance(sessionId: string, appearance: AvatarAppearance): void {
    const participant = this.participants.get(sessionId);
    if (!participant) return;

    const next = normalizeAppearance(appearance);
    participant.lastInputAt = Date.now();

    // An unchanged appearance is dropped before it fans out. This frame has the
    // same amplification shape the emote throttle exists for — one inbound
    // message becomes one outbound per observer, so in a crowd of fifteen the
    // 60/s inbound cap allows ~900 outbound frames a second — and unlike an
    // emote, re-asserting the same appearance is indistinguishable from not
    // sending it. Cheaper to notice that here than to make every client
    // defensive about redundant updates.
    if (sameAppearance(participant.appearance, next)) return;

    participant.appearance = next;
    this.broadcastUpdate(participant, { appearance: next });
  }

  /**
   * FR-4.14, FR-4.15, FR-4.16 — trigger an emote, throttled.
   *
   * Returns whether it was broadcast. Excess is dropped **silently**: the
   * wire-protocol document is explicit that a throttled emote is not an error,
   * and answering with `ERROR` would turn a leaned-on key into a stream of
   * warnings for a client that did nothing wrong.
   *
   * Duration is decided here and stated on the frame, rather than left to each
   * viewer's copy of the catalogue. `FR-4.16`'s time bound is a guarantee, and a
   * guarantee that fifteen clients each compute separately is fifteen chances to
   * disagree about when the dance stops.
   */
  emote(sessionId: string, emoteId: string): boolean {
    const participant = this.participants.get(sessionId);
    if (!participant) return false;

    const definition = emoteById(emoteId);
    if (!definition) {
      // A newer client naming an emote this build does not have. Ignored, per
      // the versioning rule — never fatal.
      this.logger.debug(`Unknown emote "${emoteId}" from ${sessionId}`);
      return false;
    }

    const now = Date.now();
    if (now - participant.lastEmoteAt < this.config.emoteMinIntervalMs) return false;
    participant.lastEmoteAt = now;

    // Waving is input. Without this an idle participant emotes while still
    // rendered as idle, which reads as the indicator being stuck.
    this.markActive(participant);

    this.broadcastToObservers(participant, Op.EMOTE_PLAY, {
      id: participant.localId,
      emote: definition.id,
      durationMs: Math.min(definition.durationMs, this.config.emoteMaxDurationMs),
    });
    return true;
  }

  /** FR-1.22 — any input clears idle, and the change is announced like any
   *  other participant state. */
  private markActive(participant: Participant): void {
    participant.lastInputAt = Date.now();
    if (participant.activity !== 'idle') return;
    participant.activity = 'active';
    this.broadcastUpdate(participant, { activity: 'active' });
  }

  /** The one place the server outranks the client on position. Phase 1 uses it
   *  for spawn; Phase 3 for portals, Phase 7 for moderation, Phase 8 for a
   *  transfer's arrival. */
  forceTransform(
    sessionId: string,
    transform: Transform,
    reason: 'spawn' | 'portal' | 'moderation' | 'transfer',
  ): void {
    const participant = this.participants.get(sessionId);
    const connection = this.connections.get(sessionId);
    if (!participant) return;

    participant.transform = { ...transform };
    if (connection) {
      this.send(connection, Op.FORCE_TRANSFORM, { transform, reason });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The tick
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Order matters here.
   *
   * Zones settle BEFORE the grid is rebuilt, because a portal moves someone and
   * FR-3.16 forbids the interest fan-out from carrying a link to the place they
   * just left. Audience comes last, when both position and occupancy are final
   * for this tick.
   *
   * Everything spatial runs **per instance**, and there is no pass that spans
   * two. That is `FR-8.10`: two copies of a room cannot leak into each other,
   * because nothing here ever looks at more than one at a time.
   */
  private tick(): void {
    const startedAt = performance.now();
    const now = Date.now();

    this.expireIdle(now);
    this.reapAbandoned(now);

    for (const instance of this.instances.values()) {
      this.updateZones(instance, now);
      this.rebuildGrid(instance);
      this.fanOut(instance);
      this.fanOutAudience(instance);
    }

    this.reapInstances(now);
    this.pushDirectories(now);

    this.lastTickMs = performance.now() - startedAt;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Zones (FR-3.2, FR-3.3, FR-3.14, FR-3.17, FR-3.18)
  // ───────────────────────────────────────────────────────────────────────────

  private updateZones(instance: MapInstance, now: number): void {
    const zones = instance.zones;
    if (zones.length === 0) return;

    for (const sessionId of instance.members) {
      const participant = this.participants.get(sessionId);
      if (!participant || !this.connections.has(sessionId)) continue;
      // Mid-transfer their position describes the map they are leaving; settling
      // it against this instance's zones would announce an entry into a room
      // they are already on their way out of.
      if (participant.transferring) continue;

      const entered = this.settleZones(instance, participant, zones, now);

      const portalId = entered.find(
        (id) => zones.find((zone) => zone.id === id)?.type === 'portal',
      );
      if (!portalId) continue;
      if (now < participant.portalCooldownUntil) continue;
      if (!this.usePortal(instance, participant, portalId, now)) continue;

      // Settle again at the destination, in the same tick. This is what turns the
      // teleport into a balanced exit-here / enter-there rather than leaving the
      // participant recorded as standing in a portal they are no longer in.
      //
      // Only for a same-map portal: a cross-map one has handed the participant to
      // `transfer`, which clears their occupancy itself and settles them against
      // the destination's zones on the next tick.
      if (!participant.transferring && participant.instanceId === instance.id) {
        this.settleZones(instance, participant, zones, now);
      }
    }
  }

  /**
   * Recompute occupancy, store it, publish the diff. Returns the ids entered.
   *
   * **Stored before published, and the order matters.** Listeners run
   * synchronously inside `publishZoneEvent`, and a subscriber told "you have
   * entered west-corridor" has to be able to read the participant as being in
   * it — Phase 5 advertises the chat channels for a zone off exactly this event
   * (`FR-5.5`), and with the assignment last it would compute them from the
   * occupancy of the previous tick and announce the channel one crossing late.
   */
  private settleZones(
    instance: MapInstance,
    participant: Participant,
    zones: readonly Zone[],
    now: number,
  ): string[] {
    const occupancy = computeZoneOccupancy(
      participant.transform,
      zones,
      participant.zones,
      this.zoneConfig,
    );

    participant.zones = occupancy.current;

    for (const id of occupancy.entered) {
      this.publishZoneEvent(instance, participant, id, 'enter', now);
    }
    for (const id of occupancy.exited) {
      this.publishZoneEvent(instance, participant, id, 'exit', now);
    }

    return occupancy.entered;
  }

  private publishZoneEvent(
    instance: MapInstance,
    participant: Participant,
    zoneId: string,
    kind: 'enter' | 'exit',
    at: number,
  ): void {
    const zone = instance.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return;

    const event: ZoneTriggerEvent = {
      sessionId: participant.sessionId,
      localId: participant.localId,
      zoneId,
      zoneType: zone.type,
      kind,
      key: zone.properties.key,
      at,
    };

    for (const listener of this.zoneListeners) listener(event);

    // Their own transitions only — see the ZONE_EVENT note in wire-protocol.md.
    const connection = this.connections.get(participant.sessionId);
    if (!connection) return;
    this.send(connection, Op.ZONE_EVENT, {
      id: participant.localId,
      zoneId,
      zoneType: zone.type,
      kind,
      ...(zone.properties.key !== undefined ? { key: zone.properties.key } : {}),
      at,
    });
  }

  /**
   * FR-3.14, FR-3.15, FR-3.16, and from phase 8 `FR-8.5`.
   *
   * Returns whether the participant was actually moved. Every refusal path leaves
   * them exactly where they were and tells them why: the Phase 3 Rules are
   * explicit that an unresolvable destination must never swallow someone.
   *
   * ── The cross-map branch is what phase 8 added ──────────────────────────────
   *
   * `FR-3.15` deliberately kept the destination abstract — `{ mapId, spawnId }` —
   * and left resolving it to this phase. A target naming another Map hands the
   * participant to `transfer`, which is asynchronous, so this returns true
   * immediately: the move is in flight, the participant is marked as
   * transferring, and nothing else in the tick will touch them until it lands.
   */
  private usePortal(
    instance: MapInstance,
    participant: Participant,
    zoneId: string,
    now: number,
  ): boolean {
    const zone = instance.zones.find((candidate) => candidate.id === zoneId);
    const connection = this.connections.get(participant.sessionId);
    const target = zone?.properties.target;

    if (!target) {
      this.refusePortal(connection, `Portal "${zoneId}" has no destination.`);
      return false;
    }

    // ── Cross-map (FR-8.5) ───────────────────────────────────────────────────
    if (target.mapId && target.mapId !== instance.mapSlug && target.mapId !== instance.mapId) {
      const destination = this.registry.resolve(target.mapId);
      if (!destination) {
        // The Rules' dangling-portal case, from the traversal side. A Map that
        // was deleted leaves portals naming it, and somebody walking into one has
        // to be told rather than swallowed.
        this.refusePortal(
          connection,
          `Portal "${zoneId}" leads to "${target.mapId}", which is not a map in this space.`,
        );
        return false;
      }

      participant.portalCooldownUntil = now + this.config.portalCooldownMs;
      void this.transfer(participant.sessionId, {
        mapId: destination.id,
        spawnId: target.spawnId,
        reason: 'portal',
      }).then((outcome) => {
        if (outcome.ok) return;
        // A full destination leaves them exactly where they were, told why. That
        // is `FR-3.16` and `FR-8.8` agreeing: a portal into a full Map applies
        // the capacity rule rather than teleporting somebody into an over-full
        // room or into nowhere.
        this.refusePortal(
          this.connections.get(participant.sessionId),
          outcome.message ?? 'That doorway leads somewhere you cannot go right now.',
          outcome.code === 'map-full' ? 'map-full' : 'map-unavailable',
        );
      });
      return true;
    }

    // ── Same map (FR-3.14, unchanged from phase 3) ───────────────────────────
    const spawn = this.maps.spawnById(instance.document, target.spawnId);
    if (!spawn) {
      this.refusePortal(
        connection,
        `Portal "${zoneId}" targets unknown spawn "${target.spawnId}".`,
      );
      return false;
    }

    // Arriving clear of every portal is the primary re-trigger defence; the
    // cooldown below only covers portals packed tighter than the clearance.
    const arrival = this.maps.placeInSpawn(
      instance.document,
      spawn,
      this.occupiedPoints(instance, participant.sessionId),
      {
        avoidZones: instance.zones.filter((z) => z.type === 'portal'),
        avoidMarginM: this.config.portalExitClearanceM,
      },
    );

    participant.portalCooldownUntil = now + this.config.portalCooldownMs;
    this.forceTransform(participant.sessionId, arrival, 'portal');
    this.logger.debug(`${participant.sessionId} took portal "${zoneId}" to spawn "${spawn.id}"`);
    return true;
  }

  private refusePortal(
    connection: Connection | undefined,
    message: string,
    code: 'portal-unresolved' | 'map-full' | 'map-unavailable' = 'portal-unresolved',
  ): void {
    this.logger.warn(message);
    if (!connection) return;
    this.send(connection, Op.ERROR, { code, message, fatal: false });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Audience (FR-3.19, FR-3.20)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Who each participant may hear and see, recomputed each tick and sent only on
   * change.
   *
   * The candidate set is the observer's area of interest, not the whole world:
   * MAX_AUDIBLE_DISTANCE_M (12 m) is well inside AOI_ENTER_RADIUS_M (25 m), so
   * nobody audible can be outside it. The exceptions are zone-driven — a private
   * zone or a spotlight defeats distance — so those are unioned in explicitly
   * rather than being quietly dropped at the interest boundary.
   *
   * There is deliberately **no early return for a zoneless map**. resolveAudience
   * degrades to pure proximity when it is passed no zones, and FR-2.6 applies to
   * every map whether or not anyone authored a volume into it. Skipping the
   * fan-out would leave such a world silent with nothing to point at.
   *
   * Per instance, and the spotlight case is why that is load-bearing rather than
   * merely tidy: `FR-3.12` lets a spotlighted speaker reach the whole map from
   * outside anybody's interest set, so a pass that spanned instances would carry
   * a voice from one copy of a room into another — precisely what `FR-8.10`
   * forbids, arriving through the one mechanism designed to defeat distance.
   */
  private fanOutAudience(instance: MapInstance): void {
    // Resolved once per tick, not once per observer-candidate pair. Doing it
    // inline would make this O(participants² × zones) — the shape the spatial
    // grid exists to keep out of the tick (NFR-7).
    const views = new Map<string, AudienceParticipant>();
    const spotlighters: string[] = [];
    const byPrivateZone = new Map<string, string[]>();

    for (const sessionId of instance.members) {
      const participant = this.participants.get(sessionId);
      if (!participant || !this.connections.has(sessionId)) continue;

      const view = this.audienceViewOf(participant);
      const privateZoneId = view.privateZoneId ?? null;
      const inSpotlight = view.inSpotlight === true;

      views.set(sessionId, view);

      if (inSpotlight) spotlighters.push(sessionId);
      if (privateZoneId !== null) {
        const members = byPrivateZone.get(privateZoneId);
        if (members) members.push(sessionId);
        else byPrivateZone.set(privateZoneId, [sessionId]);
      }
    }

    const candidates: AudienceParticipant[] = [];

    for (const sessionId of instance.members) {
      const connection = this.connections.get(sessionId);
      if (!connection || !connection.joined) continue;
      const listener = views.get(sessionId);
      if (!listener) continue;

      // Interest set, plus everyone whose reach defeats distance by design:
      // spotlighters, and the occupants of the listener's own private zone.
      // Someone on a stage 40 m away is outside interest and squarely inside the
      // audience FR-3.12 requires, so the union is explicit rather than implied.
      const seen = new Set<string>();
      candidates.length = 0;

      const add = (id: string): void => {
        if (id === sessionId || seen.has(id)) return;
        const view = views.get(id);
        if (!view) return;
        seen.add(id);
        candidates.push(view);
      };

      for (const id of connection.aoi) add(id);
      for (const id of spotlighters) add(id);
      // Truthiness rather than `!== null`: the field is optional on
      // AudienceParticipant, so undefined has to fall out here too. Zone ids are
      // non-empty by schema, so there is no empty-string case to lose.
      const listenerZone = listener.privateZoneId;
      if (listenerZone) {
        for (const id of byPrivateZone.get(listenerZone) ?? []) add(id);
      }

      // The previous sets are what make the thresholds a band rather than a line
      // (FR-2.14/2.15 churn, Phase 2 Rules). Budgeting comes after resolution,
      // never inside it: policy decides who may be heard, bandwidth decides how
      // many of them fit, and conflating the two makes an isolation bug and a
      // capacity limit look identical from the outside.
      // `FR-7.16` — the block is one more input to the function phases 2, 3 and 5
      // already use, rather than a parallel filter. The Phase 7 notes are
      // explicit about why: filtering blocked users anywhere else leaves the
      // audio flowing and only hides it.
      const audience = applyMediaBudget(
        resolveAudience(listener, candidates, this.audienceConfig, this.blockLookup, connection),
        this.mediaBudget,
      );

      const targets: AudienceEntryPayload[] = [];
      const audible = new Set<string>();
      const visible = new Set<string>();

      for (const entry of audience) {
        const other = this.participants.get(entry.id);
        if (!other) continue;
        targets.push({
          id: other.localId,
          sessionId: other.sessionId,
          gain: entry.gain,
          reason: entry.reason,
          visible: entry.visible,
          distanceM: Number(entry.distanceM.toFixed(2)),
        });
        audible.add(entry.id);
        if (entry.visible) visible.add(entry.id);
      }

      // Membership is recorded from the BUDGETED set, not the resolved one. A
      // stream that was shed is not subscribed, so it must re-enter through the
      // inner radius like anyone else — remembering it as "already in" would let
      // it come back at the outer one and defeat the cap it was shed by.
      connection.audible = audible;
      connection.visible = visible;

      // Sorted so the signature depends on the audience, not on Map iteration
      // order — otherwise an unchanged set re-sends whenever anyone rejoins.
      targets.sort((a, b) => a.id - b.id);

      // The signature tracks the DISCRETE decisions a client acts on —
      // membership, why, whether video is on, and a coarse distance bucket for
      // the simulcast layer. Continuous gain is deliberately excluded: it changes
      // in the third decimal on every step, and keying on it would re-send this
      // frame twenty times a second for a value the client does not act on
      // (ADR 0007 makes the browser's PannerNode authoritative for playback,
      // and the zone gains that matter are constants tied to `reason`).
      const signature = targets
        .map(
          (t) =>
            `${t.id}:${t.reason}:${t.visible ? 1 : 0}:${Math.floor(t.distanceM / DISTANCE_BUCKET_M)}`,
        )
        .join('|');
      if (signature === connection.audienceSignature) continue;

      connection.audienceSignature = signature;
      this.send(connection, Op.AUDIENCE, { targets });
    }
  }

  /** Where everyone currently connected **in this instance** is standing, for
   *  placement rules. Never across instances: spreading an arrival away from
   *  somebody in a different copy of the room would be placement reacting to a
   *  person who is not there. */
  private occupiedPoints(
    instance: MapInstance,
    excludeSessionId?: string,
  ): { x: number; y: number; z: number }[] {
    const points: { x: number; y: number; z: number }[] = [];
    for (const sessionId of instance.members) {
      if (sessionId === excludeSessionId) continue;
      if (!this.connections.has(sessionId)) continue;
      const participant = this.participants.get(sessionId);
      if (participant) points.push({ ...participant.transform });
    }
    return points;
  }

  /** FR-1.22 — idle after no input for IDLE_TIMEOUT_MS, back to active on input. */
  private expireIdle(now: number): void {
    for (const participant of this.participants.values()) {
      if (participant.activity !== 'active') continue;
      if (now - participant.lastInputAt <= this.config.idleTimeoutMs) continue;
      participant.activity = 'idle';
      this.broadcastUpdate(participant, { activity: 'idle' });
    }
  }

  /** Retained sessions whose resume window has closed are gone for good. */
  private reapAbandoned(now: number): void {
    for (const participant of [...this.participants.values()]) {
      if (participant.disconnectedAt === null) continue;
      if (now - participant.disconnectedAt <= this.config.resumeTokenTtlMs) continue;
      this.leave(participant.sessionId, 'timeout');
    }
  }

  /**
   * Only connected participants enter the grid. Retained (disconnected)
   * participants must stay invisible, or FR-1.4's promptness is broken.
   */
  private rebuildGrid(instance: MapInstance): void {
    const points: ParticipantPoint[] = [];
    for (const sessionId of instance.members) {
      if (!this.connections.has(sessionId)) continue;
      const participant = this.participants.get(sessionId);
      if (!participant || participant.transferring) continue;
      points.push({
        id: sessionId,
        x: participant.transform.x,
        z: participant.transform.z,
        participant,
      });
    }
    instance.grid.rebuild(points);
  }

  private fanOut(instance: MapInstance): void {
    const total = instance.grid.size;

    for (const sessionId of instance.members) {
      const connection = this.connections.get(sessionId);
      if (!connection || !connection.joined) continue;
      const observer = this.participants.get(sessionId);
      if (!observer || observer.transferring) continue;

      const diff = computeAoi(
        {
          id: sessionId,
          x: observer.transform.x,
          z: observer.transform.z,
        },
        instance.grid,
        connection.aoi,
        this.aoiConfig,
      );

      // FR-1.17: a clean appear/disappear, so the client can drop remote state
      // rather than leaving a stale copy standing in the world.
      for (const id of diff.added) {
        const other = this.participants.get(id);
        // Built for this observer: `blocked` describes them, not the arrival.
        if (other) this.send(connection, Op.PARTICIPANT_ADD, this.toDto(other, observer));
      }
      for (const id of diff.removed) {
        const other = this.participants.get(id);
        if (other) {
          this.send(connection, Op.PARTICIPANT_REMOVE, {
            id: other.localId,
            reason: 'out-of-range',
          });
        }
      }

      connection.aoi = diff.current;

      if (diff.current.size > 0) {
        const entries: BatchEntry[] = [];
        for (const id of diff.current) {
          const other = this.participants.get(id);
          if (!other) continue;
          entries.push({
            id: other.localId,
            transform: other.transform,
            flags: other.flags,
          });
        }
        this.sendBinary(connection, encodeTransformBatch(entries));
      }

      if (diff.added.length > 0 || diff.removed.length > 0) {
        this.send(connection, Op.PARTICIPANT_UPDATE, {
          id: observer.localId,
          totalInInstance: total,
        });
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-8.12, FR-8.13 — the directory
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `DC-8.5` — which Maps exist, how busy each one is, and who is where.
   *
   * Read straight off the in-memory registry, which is the complete truth with
   * one process (ADR 0009): there is nothing to aggregate and nothing that could
   * be stale.
   *
   * ── "Subject to permissions" (`FR-8.12`) ────────────────────────────────────
   *
   * Counts for everybody, names for members. The requirement leaves the line
   * unspecified and this is the only reading that is defensible without inventing
   * a permission the phase does not have: somebody who has not been invited into
   * a Space should not be handed a live map of where every employee in it is
   * standing. A member seeing colleagues is the feature; a visitor seeing the
   * same thing is a directory of the building's occupants.
   */
  directoryFor(sessionId: string): SpaceDirectoryDto | null {
    const viewer = this.participants.get(sessionId);
    if (!viewer) return null;

    const space = this.registry.currentSpace;
    const viewerInstance = this.instances.get(viewer.instanceId);

    const maps: MapDirectoryEntryDto[] = [];
    for (const map of this.registry.list()) {
      if (map.archivedAt) continue;

      const instances = this.instancesOf(map.id);
      const capacity = this.registry.capacityOf(map);
      let occupancy = 0;

      const summaries = instances.map((instance) => {
        const count = this.connectedIn(instance).length;
        occupancy += count;
        return {
          instanceId: instance.id,
          index: instance.index,
          label: instance.label(instances.length),
          occupancy: count,
          full: instance.members.size >= capacity,
        };
      });

      maps.push({
        mapId: map.id,
        slug: map.slug,
        name: map.name,
        isDefault: map.id === space.defaultMapId,
        capacity,
        occupancy,
        instances: summaries,
        // `FR-8.13` — everything a participant can see, they may walk to. The
        // access controls that decide who is in a Space at all (`FR-7.11`–
        // `FR-7.14`) are enforced at the door and do not vary by room; a
        // per-map restriction would be a permission this phase does not define,
        // and inventing one here would put a second access model beside phase
        // 7's.
        reachable: true,
      });
    }

    // `FR-8.14` — enough to go to somebody, and only for members.
    const people = viewer.identity.member
      ? [...this.participants.values()]
          .filter((person) => this.connections.has(person.sessionId))
          .map((person) => ({
            sessionId: person.sessionId,
            displayName: person.displayName,
            mapId: this.instances.get(person.instanceId)?.mapId ?? '',
            instanceId: person.instanceId,
            here: person.instanceId === viewer.instanceId,
          }))
          .filter((person) => person.mapId !== '')
      : [];

    return {
      spaceId: space.id,
      spaceSlug: space.slug,
      spaceName: space.name,
      defaultMapId: space.defaultMapId,
      hereMapId: viewerInstance?.mapId ?? '',
      hereInstanceId: viewer.instanceId,
      maps,
      people,
    };
  }

  /** `FR-8.12` — push the directory to everybody it has changed for.
   *
   *  Off the tick rather than on it (`DIRECTORY_REFRESH_MS`), because per-map
   *  counts change a few times a minute and rebuilding a document that lists
   *  every Map twenty times a second to send it none of those times is work spent
   *  producing an unchanged string. The signature check is the second half of the
   *  same protection, and is what makes the push free when nothing moved. */
  private pushDirectories(now: number): void {
    if (now - this.lastDirectoryAt < DIRECTORY_REFRESH_MS) return;
    this.lastDirectoryAt = now;

    for (const [sessionId, connection] of this.connections) {
      if (!connection.joined) continue;
      const directory = this.directoryFor(sessionId);
      if (!directory) continue;

      const signature = JSON.stringify(directory);
      if (this.directorySignatures.get(sessionId) === signature) continue;
      this.directorySignatures.set(sessionId, signature);
      this.send(connection, Op.SPACE_DIRECTORY, directory);
    }
  }

  /** Answer a `DIRECTORY` request now, bypassing the signature check: a client
   *  that just opened the panel needs the document even if it is the same one it
   *  was last sent. */
  sendDirectory(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    const directory = this.directoryFor(sessionId);
    if (!connection || !directory) return;
    this.directorySignatures.set(sessionId, JSON.stringify(directory));
    this.send(connection, Op.SPACE_DIRECTORY, directory);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sending
  // ───────────────────────────────────────────────────────────────────────────

  send(connection: Connection, opcode: number, payload: unknown): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(encodeJsonFrame(opcode, payload));
  }

  /**
   * Transform batches are DROPPED rather than queued when the socket is
   * backed up.
   *
   * This replaces socket.io's `volatile emit` and is correct for this data: a
   * stale position has no value once a newer one exists, and queueing them turns
   * a slow client into an ever-growing buffer. JSON event frames are never
   * skipped — those are reliable.
   */
  private sendBinary(connection: Connection, frame: ArrayBuffer): void {
    const socket = connection.socket;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > this.config.maxBufferedBytes) return;
    socket.send(frame);
  }

  private broadcastUpdate(participant: Participant, fields: Record<string, unknown>): void {
    this.broadcastToObservers(participant, Op.PARTICIPANT_UPDATE, {
      id: participant.localId,
      ...fields,
    });
  }

  /**
   * Everyone who can see this participant, plus the participant themself.
   *
   * Self is included unconditionally and not by accident: an observer is never
   * in their own interest set, so an emote or a status change routed only
   * through the area of interest would be invisible to its author. In third
   * person that is not a subtlety — you watch your own avatar wave, or the key
   * appears to have done nothing.
   *
   * Scoped to the participant's own instance. Interest sets never span two, so
   * this could not leak either way; iterating one instance rather than every
   * connection in the process is what keeps a Space with twenty Maps from paying
   * for all of them on every status change.
   */
  private broadcastToObservers(
    participant: Participant,
    opcode: number,
    payload: Record<string, unknown>,
  ): void {
    const instance = this.instances.get(participant.instanceId);
    if (!instance) return;

    for (const sessionId of instance.members) {
      const connection = this.connections.get(sessionId);
      if (!connection) continue;
      if (sessionId !== participant.sessionId && !connection.aoi.has(participant.sessionId)) {
        continue;
      }
      this.send(connection, opcode, payload);
    }
  }

  /**
   * Tell everyone the participant is gone AND drop them from every observer's
   * interest set.
   *
   * Purging the set is the part that is easy to miss and expensive to debug.
   * `computeAoi` decides whether to emit PARTICIPANT_ADD by asking whether the
   * id was in the previous set. Leave a departed session in there and a fast
   * reconnect — inside one tick — is classified as "already present", no ADD is
   * sent, and the observer stays blind to that participant for the rest of the
   * session. The client was told they left; the server has to agree.
   *
   * The instance is passed in rather than looked up, because this runs *after*
   * the participant has been removed from it — on a transfer, they are already a
   * member of somewhere else by the time the people they left have to be told.
   */
  private broadcastRemoval(instance: MapInstance, participant: Participant, reason: string): void {
    for (const sessionId of instance.members) {
      const connection = this.connections.get(sessionId);
      if (!connection) continue;
      connection.aoi.delete(participant.sessionId);
      this.send(connection, Op.PARTICIPANT_REMOVE, {
        id: participant.localId,
        reason,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Queries
  // ───────────────────────────────────────────────────────────────────────────

  /** FR-1.15 — the joiner sees who is already present, not just who moves next. */
  snapshotFor(sessionId: string): {
    participants: ParticipantDto[];
    totalInInstance: number;
  } {
    const observer = this.participants.get(sessionId);
    const connection = this.connections.get(sessionId);
    const instance = observer ? this.instances.get(observer.instanceId) : undefined;
    if (!observer || !connection || !instance) return { participants: [], totalInInstance: 0 };

    const diff = computeAoi(
      { id: sessionId, x: observer.transform.x, z: observer.transform.z },
      instance.grid,
      new Set(),
      this.aoiConfig,
    );
    connection.aoi = diff.current;

    const participants: ParticipantDto[] = [];
    for (const id of diff.current) {
      const other = this.participants.get(id);
      if (other) participants.push(this.toDto(other, observer));
    }

    // Counted from the live connections in this instance, not from the grid: the
    // grid is rebuilt on the tick, so at join time it still describes the world
    // as it was before this participant arrived — and a total lower than the
    // number of people the presence list is already showing reads as a bug in the
    // list.
    return { participants, totalInInstance: this.connectedIn(instance).length };
  }

  getParticipant(sessionId: string): Participant | undefined {
    return this.participants.get(sessionId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Identity (phase 6) — the `WorldIdentityPort` the auth module calls into
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-6.11` — the identity every other phase stores for this participant.
   *
   * One function, used by chat for message authorship, read state and direct
   * conversation keys. A second opinion anywhere would mean a message written
   * under one identity and read back under another.
   */
  identityOf(participant: Participant): string {
    return identityOf(participant);
  }

  /**
   * Who is currently acting under a durable identity, if anyone.
   *
   * Chat needs it to resolve a stored `sender_identity` back to a live local id
   * when replaying history. Linear over a registry bounded by
   * `DEFAULT_MAP_CAPACITY` (50), which is cheaper than maintaining a second
   * index that can fall out of step with the first.
   */
  participantByIdentity(identity: string): Participant | undefined {
    for (const participant of this.participants.values()) {
      if (identityOf(participant) === identity) return participant;
    }
    return undefined;
  }

  /**
   * `FR-6.7` — look up a live guest by their resume token.
   *
   * The resume token, never the session id: session ids are broadcast to
   * everyone in range on `PARTICIPANT_ADD`, so accepting one would let anybody
   * in the room register an account carrying a stranger's name and appearance.
   *
   * Guests only. An account holder presenting their own resume token to the
   * upgrade endpoint has nothing to upgrade, and letting it through would let a
   * second account be created that inherits a first account's profile.
   */
  readGuestSession(resumeToken: string): GuestSessionView | null {
    const sessionId = this.resumeTokens.get(resumeToken);
    if (!sessionId) return null;

    const participant = this.participants.get(sessionId);
    if (!participant || participant.identity.kind !== 'guest') return null;

    return {
      sessionId,
      displayName: participant.displayName,
      appearance: participant.appearance,
    };
  }

  /**
   * `FR-6.7` — the guest is now an account, and the socket never moved.
   *
   * Three things happen, in this order and for reasons:
   *
   *   1. The identity is replaced. Everything that reads it afterwards — chat
   *      authorship, read state — is durable from this moment.
   *   2. Name and appearance are applied and **broadcast**, because everybody
   *      looking at them is looking at the old name until told otherwise.
   *   3. `IDENTITY` goes to the participant themself, which is the only frame
   *      that carries an account id and the only one sent here.
   *
   * The socket is untouched throughout. That is the requirement — "must not lose
   * the user's place mid-session" — and it is why this is a mutation rather than
   * a rejoin.
   */
  bindSession(sessionId: string, identity: SessionIdentity): boolean {
    const participant = this.participants.get(sessionId);
    if (!participant) return false;

    participant.identity = {
      kind: identity.kind,
      accountId: identity.accountId ?? null,
      member: identity.member,
    };
    // Phase 7. An upgrade can make somebody a member — the invite code rides
    // along with the registration — and a member is not a guest. Absent, the
    // role follows membership, which is the same answer `RolesService` gives for
    // a row that has just been created.
    participant.role = identity.role ?? (identity.member ? 'member' : 'guest');

    const changed: Record<string, unknown> = {};

    const name = this.sanitizeName(identity.displayName);
    if (name && name !== participant.displayName) {
      participant.displayName = name;
      changed.displayName = name;
    }

    const appearance = normalizeAppearance(identity.appearance);
    if (!sameAppearance(participant.appearance, appearance)) {
      participant.appearance = appearance;
      changed.appearance = appearance;
    }

    // Observers are told what they can see. `identity` rides along so a presence
    // list stops marking a freshly-upgraded person as a guest, and `role` so it
    // stops disagreeing with the capabilities the person themself was just sent.
    this.broadcastUpdate(participant, {
      ...changed,
      identity: { kind: participant.identity.kind, member: participant.identity.member },
      role: participant.role,
    });

    this.sendIdentity(participant);

    // Becoming a member changes what the directory may say to them (`FR-8.12`),
    // and the signature check would otherwise suppress the corrected document
    // until somebody moved.
    this.directorySignatures.delete(sessionId);

    this.logger.debug(
      `Session ${sessionId} is now ${participant.identity.kind}` +
        `${participant.identity.member ? ' (member)' : ''}.`,
    );
    return true;
  }

  /**
   * `FR-6.10` — push a profile change to every live session of one account.
   *
   * Usually zero or one. More than one is somebody with two tabs open, and both
   * of them should show the name they just chose rather than one of them waiting
   * for a reconnect.
   */
  refreshAccountSessions(accountId: string, identity: SessionIdentity): number {
    let updated = 0;
    for (const [sessionId, participant] of this.participants) {
      if (participant.identity.accountId !== accountId) continue;
      if (this.bindSession(sessionId, identity)) updated++;
    }
    return updated;
  }

  getConnection(sessionId: string): Connection | undefined {
    return this.connections.get(sessionId);
  }

  /**
   * `0x9e IDENTITY` — who this connection is, and what it may do.
   *
   * One builder for the frame and for the `identity` field on `JOINED`, which
   * the gateway calls through `identityPayloadFor` below. Two spellings of the
   * same shape is how the two would eventually disagree about a capability list,
   * and a client that drew its moderation controls from the stale one would show
   * buttons the server refuses.
   */
  private sendIdentity(participant: Participant): void {
    const connection = this.connections.get(participant.sessionId);
    if (!connection) return;
    this.send(connection, Op.IDENTITY, this.identityPayloadFor(participant));
  }

  /** The shape `JOINED.identity` and the `IDENTITY` frame share. */
  identityPayloadFor(participant: Participant): Record<string, unknown> {
    return {
      kind: participant.identity.kind,
      ...(participant.identity.accountId ? { accountId: participant.identity.accountId } : {}),
      member: participant.identity.member,
      displayName: participant.displayName,
      appearance: participant.appearance,
      // `FR-7.2` — the role for display, the capability list to act on. Derived
      // from the one matrix in `@hubitat/protocol`, so the client cannot hold a
      // second opinion about what an admin may do.
      role: participant.role,
      capabilities: [...CAPABILITIES[participant.role]],
    };
  }

  /**
   * Everyone with a live socket **in one instance** — `FR-5.1`'s "all
   * participants in the world instance", and the candidate set every chat scope
   * narrows from.
   *
   * Retained (disconnected) participants are excluded. They are invisible to
   * everyone else during the resume window, and delivering a room message to
   * somebody nobody can see would mean the message existed for a participant the
   * world has already announced as gone.
   *
   * ── The instance argument is `FR-8.10` ──────────────────────────────────────
   *
   * Phase 5 could take "everybody" to mean everybody, because there was one
   * world. A room message that reached every instance of a Map would be the one
   * channel through which two copies of a room could hear each other — and it
   * would be a text channel, which is worse than an audio one, because it is
   * retained.
   */
  connectedParticipants(instance?: MapInstance): Participant[] {
    if (instance) return this.connectedIn(instance);

    const connected: Participant[] = [];
    for (const [sessionId, participant] of this.participants) {
      if (this.connections.has(sessionId)) connected.push(participant);
    }
    return connected;
  }

  /** Everybody with a live socket in one instance. */
  private connectedIn(instance: MapInstance): Participant[] {
    const connected: Participant[] = [];
    for (const sessionId of instance.members) {
      if (!this.connections.has(sessionId)) continue;
      const participant = this.participants.get(sessionId);
      if (participant) connected.push(participant);
    }
    return connected;
  }

  /** The zones of the Map a participant is standing in — what chat reads to
   *  decide which zone channels they have (`FR-5.5`). */
  zonesOf(participant: Participant): readonly Zone[] {
    return this.instances.get(participant.instanceId)?.zones ?? [];
  }

  /** `DC-7.6` — which Map a report was filed in. */
  mapIdOf(participant: Participant): string {
    return this.instances.get(participant.instanceId)?.mapSlug ?? 'unknown';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interactive objects — phase 10
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-10.14` — may this person open a shared object's channel?
   *
   * The whole of the scoping, in one place, because a CRDT update is opaque and
   * idempotent: there is no per-message filtering to do, so entitlement is
   * decided once at subscription and a socket that passes is entitled to
   * everything on it.
   *
   * Four things have to be true, and each rules out a different way in:
   *
   *   1. **The token names a live session.** The *resume token*, never a session
   *      id — session ids are broadcast to everyone in range on
   *      `PARTICIPANT_ADD`, so accepting one would let anybody in the room open
   *      any whiteboard in it. This is the same secret `FR-6.7`'s upgrade
   *      endpoint accepts, for the same reason.
   *   2. **They are in a Map that has that object**, which is what stops a
   *      participant in the atrium editing the office's board.
   *   3. **The object is interactive and shared.** A per-participant object has
   *      no shared state, and opening a channel for one would create state
   *      nobody else can see and nothing will ever read.
   *   4. **They are within its interaction range** (`FR-10.2`), so proximity is
   *      an access control rather than a hint.
   */
  authorizeInteraction(
    resumeToken: string,
    objectId: string,
  ):
    | { ok: true; mapId: string; sessionId: string; contentType: string; persist: boolean }
    | { ok: false; reason: string } {
    const sessionId = this.resumeTokens.get(resumeToken);
    const participant = sessionId ? this.participants.get(sessionId) : undefined;
    if (!participant || !this.connections.has(participant.sessionId)) {
      return { ok: false, reason: 'that session is not in this world' };
    }

    const instance = this.instances.get(participant.instanceId);
    if (!instance) return { ok: false, reason: 'that session is not in a map' };

    const object = instance.document.objects.find((candidate) => candidate.id === objectId);
    if (!object) return { ok: false, reason: 'no such object in this map' };

    const interactive = object.interactive;
    if (!interactive) return { ok: false, reason: 'that object is not interactive' };
    if (!interactive.shared) {
      return { ok: false, reason: 'that object is not shared — its content is per-participant' };
    }

    // The authored range, or the default. Grown by a metre for the *channel*
    // specifically: a person who steps back mid-stroke must not have their
    // socket closed under them, and the prompt they acted on was already a
    // decision about proximity.
    const range = (interactive.interactionRangeM ?? INTERACT_RANGE_M) + 1;
    const dx = participant.transform.x - object.transform.position.x;
    const dy = participant.transform.y - object.transform.position.y;
    const dz = participant.transform.z - object.transform.position.z;
    if (dx * dx + dy * dy + dz * dz > range * range) {
      return { ok: false, reason: 'you are too far from that object' };
    }

    return {
      ok: true,
      mapId: instance.mapId,
      sessionId: participant.sessionId,
      contentType: interactive.contentType,
      // `FR-10.16` — and sharp edge nº5: `persistShared: false` means gone on
      // last leave, which is a decision the author made and this honours rather
      // than second-guesses.
      persist: interactive.persistShared === true,
    };
  }

  /**
   * A participant as `resolveAudience` wants to see them.
   *
   * Public because Phase 5 resolves `nearby` recipients through the same
   * function the tick uses for media, and building the view a second time in the
   * chat service is how the two would begin to disagree about which private zone
   * somebody is in.
   */
  audienceViewOf(participant: Participant): AudienceParticipant {
    const zones = this.zonesOf(participant);
    return {
      id: participant.sessionId,
      x: participant.transform.x,
      y: participant.transform.y,
      z: participant.transform.z,
      privateZoneId: privateZoneOf(participant.zones, zones),
      inSpotlight: isInSpotlight(participant.zones, zones),
    };
  }

  get stats() {
    let connected = 0;
    let retained = 0;
    for (const [sessionId, participant] of this.participants) {
      if (this.connections.has(sessionId)) connected++;
      else if (participant.disconnectedAt !== null) retained++;
    }
    return {
      connected,
      retained,
      tickRateHz: this.config.tickRateHz,
      lastTickMs: Number(this.lastTickMs.toFixed(3)),
      // Phase 8 — `NFR-38` in the multi-map world: "the tick is slow" and "there
      // are nine instances running" are different problems and only one of them
      // is visible from `lastTickMs` alone.
      instances: this.instances.size,
      maps: this.registry.live().length,
    };
  }

  /** Live occupancy per Map, for the management screen. Read off the registry,
   *  which is the whole truth with one process. */
  occupancyByMap(): Map<string, { occupancy: number; instances: number }> {
    const counts = new Map<string, { occupancy: number; instances: number }>();
    for (const instance of this.instances.values()) {
      const entry = counts.get(instance.mapId) ?? { occupancy: 0, instances: 0 };
      entry.occupancy += this.connectedIn(instance).length;
      entry.instances += 1;
      counts.set(instance.mapId, entry);
    }
    return counts;
  }

  /**
   * One participant, as one observer is told about them.
   *
   * The observer argument is what makes `blocked` safe to put on this frame:
   * `SNAPSHOT` and `PARTICIPANT_ADD` are already addressed per connection, so
   * each copy is built for the person receiving it. Every other field on the
   * frame is the same for everybody.
   */
  private toDto(participant: Participant, observer?: Participant): ParticipantDto {
    return {
      id: participant.localId,
      sessionId: participant.sessionId,
      displayName: participant.displayName,
      status: participant.status,
      activity: participant.activity,
      transform: participant.transform,
      // Phase 4 Rules — appearance travels with the participant, so someone who
      // walks into range after a customization change sees the current look and
      // not the default until the next one.
      appearance: participant.appearance,
      // FR-6.13 — enough for a presence list to mark a guest, and no account id:
      // a durable handle for a stranger is not something an observer needs.
      identity: {
        kind: participant.identity.kind,
        member: participant.identity.member,
      },
      // FR-7.1 — so a presence list can say who moderates. Not a permission:
      // nothing a client does with this is trusted (`NFR-34`).
      role: participant.role,
      // FR-7.5, FR-7.6 — the fact, without the actor or the reason. Those go
      // only to the person it was done to.
      moderation: participant.moderation,
      // FR-7.16 — true only on the copy sent to somebody who has blocked them.
      blocked: observer?.blockedSessions.has(participant.sessionId) ?? false,
    };
  }

  private sanitizeName(name: string | undefined): string {
    if (!name) return '';
    return name.trim().slice(0, this.config.maxDisplayNameChars);
  }

  /**
   * Instance-local ids are not reused while an instance lives, so a late frame
   * referencing a departed participant resolves to nobody rather than to a
   * stranger. The u16 space wraps after 65535 joins; on wrap we skip ids still
   * in use.
   *
   * Allocated **process-wide** rather than per instance, which is stricter than
   * the name suggests and deliberately so: a transfer keeps the participant's
   * local id, and ids that were only unique within an instance would collide the
   * moment two people from two rooms met in a third.
   */
  private allocateLocalId(): number {
    for (let attempt = 0; attempt < 0xffff; attempt++) {
      const candidate = this.nextLocalId;
      this.nextLocalId = this.nextLocalId >= 0xffff ? 1 : this.nextLocalId + 1;

      let taken = false;
      for (const participant of this.participants.values()) {
        if (participant.localId === candidate) {
          taken = true;
          break;
        }
      }
      if (!taken) return candidate;
    }
    throw new Error('local id space exhausted');
  }
}

/** Re-exported so the gateway can label an instance without importing the
 *  protocol package for one function. */
export { instanceLabel };
