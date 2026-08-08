/**
 * Client state.
 *
 * The split here is deliberate and load-bearing for performance: React state
 * holds only things that change RARELY — who is present, what screen we are on.
 * Per-frame data (remote transforms) lives in plain Maps outside React and is
 * read inside `useFrame`.
 *
 * Putting fifteen interpolated transforms through `setState` at 60 fps is the
 * single easiest way to turn this client into a slideshow (ADR 0002).
 */

import { create } from 'zustand';
import { TransformBuffer } from '@hubitat/world-core';
import {
  DEFAULT_APPEARANCE,
  NO_MODERATION,
  avatarAppearanceSchema,
  type AvatarAppearance,
  type Capability,
  type ClientTuning,
  type IdentityStatePayload,
  type JoinedPayload,
  type ModerationStatePayload,
  type ParticipantDto,
  type ParticipantIdentity,
  type ParticipantModeration,
  type Role,
  type MapTransferPayload,
  type MapUpdatedPayload,
  type SpaceDirectoryDto,
  type ZoneEventPayload,
} from '@hubitat/protocol';

/** specs/ux/phase-01-screens.md */
export type AppState = 'entry' | 'loading' | 'in-world' | 'reconnecting' | 'error';

export type LoadStep =
  | 'connecting'
  | 'physics'
  | 'downloading-world'
  | 'building-collision'
  /** Phase 4. Its own step because it is its own download and its own failure —
   *  "Couldn't download the avatar" is actionable in a way that folding it into
   *  the world step would not be (specs/ux/phase-01-screens.md). */
  | 'loading-avatar'
  | 'entering';

export interface FailureInfo {
  title: string;
  detail: string;
  /** Retry is offered only where retrying can plausibly work. A retry button on
   *  a corrupt world file teaches users that buttons lie. */
  retryable: boolean;
  technical?: string;
}

export interface RosterEntry {
  localId: number;
  sessionId: string;
  displayName: string;
  activity: 'active' | 'idle';
  status: 'available' | 'away' | 'do-not-disturb';
  /** DC-4.1. In the roster rather than in a map of its own because it arrives
   *  on the same frames the rest of this entry does, and two structures updated
   *  from one payload drift the moment one of them is forgotten. */
  appearance: AvatarAppearance;
  /** Phase 6, `FR-6.13` — guest or account, and whether they belong to this
   *  Space. Carries no account id: the presence list needs to say "guest" beside
   *  a name and has no use for a durable handle for a stranger. */
  identity: ParticipantIdentity;
  /** Phase 7, `FR-7.1`. Shown so "ask an admin" is advice somebody can follow.
   *  Never used to decide what *this* client may do — that is `capabilities`
   *  below, and both are re-checked on the server (`NFR-34`). */
  role: Role;
  /** Phase 7, `FR-7.5` / `FR-7.6`. The fact only: who muted them and why goes to
   *  the muted person alone. */
  moderation: ParticipantModeration;
  /** Phase 7, `FR-7.16` — whether *you* have blocked them. Arrives per observer,
   *  because the frames that carry it are already addressed per connection. */
  blocked: boolean;
}

/**
 * Where the local participant is — phase 8, `FR-8.4`.
 *
 * The Map *and* the instance of it, because `FR-8.10` requires the separation
 * between two copies of a room to be understandable rather than mysterious, and
 * "Head Office (2)" on screen is the only thing that makes it so. `instanceCount`
 * is what decides whether that label is worth showing at all: one instance is the
 * ordinary case and numbering it would invent a distinction nobody needs.
 */
export interface PlaceInfo {
  mapId: string;
  mapName: string;
  instanceId: string;
  instanceIndex: number;
  instanceLabel: string;
  instanceCount: number;
}

/**
 * What the client has been told to load — phase 8.
 *
 * Held in the store rather than derived from `joined`, because a map transfer
 * replaces it on a socket that never dropped (`FR-8.6`) and there is no second
 * `JOINED` to hang it off. `epoch` is what `App` watches: it increments whenever
 * the world genuinely has to be rebuilt, and stays put on a resume into the same
 * Map — reloading a world for a two-second network blip is exactly the
 * regression phase 1's `loadStartedRef` existed to prevent.
 */
export interface WorldRequest {
  epoch: number;
  mapId: string;
  mapUrl: string;
  mapDocumentUrl: string;
  spawn: { x: number; y: number; z: number; yaw: number };
}

interface Store {
  appState: AppState;
  loadStep: LoadStep;
  loadProgress: number;
  failure: FailureInfo | null;

  displayName: string;
  joined: JoinedPayload | null;
  tuning: ClientTuning | null;

  /**
   * The local participant's appearance (FR-4.8).
   *
   * Held here as well as in the roster because the customizer edits it before
   * the server has echoed it back, and a control bound to the roster copy would
   * lag every click by a round trip.
   */
  appearance: AvatarAppearance;

  /**
   * Whether `appearance` is one this browser actually has, rather than the
   * placeholder default.
   *
   * Load-bearing, and the reason is not obvious. The server generates a distinct
   * appearance per guest — `appearanceForSeed(localId)` — but only when `JOIN`
   * offers none. Offering the default instead reads as a request, so a client
   * that always sends something turns every first-time guest into the same
   * avatar: a room of identical clones, and a step backwards from the phase 1
   * capsules, which at least had `colorForId`.
   *
   * Set once the server has told us what we are wearing, so a reconnect keeps
   * the same look, and set when the user chooses one. Never persisted on its
   * own — a fresh browser has nothing remembered and must be seeded by the
   * server.
   */
  appearanceRemembered: boolean;

  /**
   * Roster changes on join/leave only — a few times a minute, not per frame.
   *
   * Includes the local participant. The server excludes an observer from their
   * own area of interest, so `SNAPSHOT` and `PARTICIPANT_ADD` never carry self —
   * but `PARTICIPANT_UPDATE` *about* self does, and the presence list is
   * specified to mark "you" and sort it first
   * (specs/ux/phase-01-screens.md). So the client seeds the entry from `JOINED`
   * and keeps it across every snapshot.
   */
  roster: Map<number, RosterEntry>;
  totalInInstance: number;

  /**
   * The local participant's own zone occupancy (FR-3.17).
   *
   * `ZONE_EVENT` carries nobody else's transitions, so this map is complete by
   * construction rather than by filtering. It exists so a person whose audio has
   * just become private can be told — which is the reason the frame exists at
   * all (specs/protocol/wire-protocol.md).
   *
   * Deliberately NOT re-derived from the loaded map document. Occupancy is
   * computed on the server from the quantized position and is authoritative for
   * media; a second implementation here would disagree at boundaries and there
   * would be no way to tell which was right.
   */
  zones: Map<string, ZoneEventPayload['zoneType']>;

  /**
   * Phase 7 — what this connection may do (`FR-7.2`), from `JOINED` and
   * `IDENTITY`.
   *
   * Held apart from `joined` so a role change arriving mid-session is one
   * assignment rather than a rebuild of the whole join payload, and so every
   * component that gates a control reads the same field.
   *
   * Advisory in one direction only. It hides buttons that would be refused; it
   * cannot enable anything, because the server re-checks every action against
   * the same matrix.
   */
  role: Role;
  capabilities: Capability[];

  /**
   * Phase 7, `FR-7.5` — what a moderator has taken away from *you*.
   *
   * Separate from the roster entry for yourself, which carries the same two
   * booleans: this one also carries the actor and the reason, which nobody else
   * is told, and the media controls read it to explain why the microphone button
   * is dead rather than leaving it looking broken.
   */
  moderation: ModerationStatePayload | null;

  /** Phase 8 — which Map and which copy of it. Null before the first `JOINED`. */
  place: PlaceInfo | null;
  /** Phase 8 — the world to have loaded. See `WorldRequest`. */
  world: WorldRequest | null;
  /**
   * `DC-8.5` — the Space directory, pushed on change.
   *
   * Whole documents rather than a merged view: the server sends the complete
   * thing every time it changes (bounded by the number of Maps), so there is no
   * accumulation for a dropped frame to corrupt. Null until the first push,
   * which arrives inside the handshake.
   */
  directory: SpaceDirectoryDto | null;
  /**
   * Phase 9, `FR-9.20` — a newer version of the Map this participant is in.
   *
   * Held rather than acted on. The requirement is explicit that publishing must
   * not hard-break the people inside, so this is an offer the HUD renders and
   * the person takes when they are not mid-sentence. Cleared on a transfer,
   * because arriving anywhere already picks up the current version.
   */
  mapUpdate: MapUpdatedPayload | null;

  reconnectAttempt: number;
  nextRetryInMs: number;

  /**
   * A transient, non-fatal message.
   *
   * The Phase 3 Rules require that a participant whose portal cannot be resolved
   * "stays put and is informed". A console warning informs a developer, not a
   * person standing in a room wondering why the doorway did nothing.
   *
   * Carries `at` so re-issuing the same text still restarts the timer — two
   * failed portal attempts must read as two, not one that never dismissed.
   */
  notice: { message: string; at: number } | null;

  setAppState: (state: AppState) => void;
  notify: (message: string) => void;
  dismissNotice: () => void;
  setLoadStep: (step: LoadStep, progress?: number) => void;
  fail: (failure: FailureInfo) => void;
  setDisplayName: (name: string) => void;
  setAppearance: (appearance: AvatarAppearance) => void;
  setJoined: (joined: JoinedPayload) => void;

  applySnapshot: (participants: ParticipantDto[], total: number) => void;
  addParticipant: (participant: ParticipantDto) => void;
  removeParticipant: (localId: number) => void;
  updateParticipant: (update: Partial<RosterEntry> & { localId: number; total?: number }) => void;
  clearRoster: () => void;
  applyZoneEvent: (event: ZoneEventPayload) => void;
  /** Phase 6, `FR-6.7` — a guest became an account without the socket moving. */
  applyIdentity: (identity: IdentityStatePayload) => void;
  /** Phase 7, `FR-7.5` — the self-only half of a force-mute. */
  applyModeration: (moderation: ModerationStatePayload) => void;
  /** Phase 8, `FR-8.6` — you are in a different Map now. */
  applyMapTransfer: (transfer: MapTransferPayload) => void;
  /** Phase 8, `FR-8.12`. */
  setDirectory: (directory: SpaceDirectoryDto) => void;
  /** Phase 9, `FR-9.20` — a new version of the Map you are in exists. */
  setMapUpdate: (update: MapUpdatedPayload | null) => void;

  setReconnect: (attempt: number, nextRetryInMs: number) => void;
  reset: () => void;
}

/**
 * Per-frame data, outside React on purpose.
 *
 * Keyed by instance-local id. Ids are never reused while an instance lives, so
 * a late frame for a departed participant resolves to nothing rather than to a
 * stranger.
 */
export const remoteBuffers = new Map<number, TransformBuffer>();

export function ensureBuffer(localId: number, bufferMs: number, periodMs: number): TransformBuffer {
  let buffer = remoteBuffers.get(localId);
  if (!buffer) {
    buffer = new TransformBuffer(bufferMs, periodMs);
    remoteBuffers.set(localId, buffer);
  }
  return buffer;
}

export interface EmoteSignal {
  clip: string;
  glyph: string;
  durationMs: number;
  /** `performance.now()` at arrival. Two identical emotes in a row are
   *  otherwise indistinguishable, and the second one would never play. */
  at: number;
}

/**
 * The most recent emote per participant, outside React for the same reason the
 * transform buffers are.
 *
 * An emote is consumed inside `useFrame` by the avatar it belongs to — pushing
 * it through `setState` would re-render the whole tree to start a two-second
 * animation, and someone leaning on the wave key would do it repeatedly. Each
 * avatar remembers the `at` it last played and ignores anything older.
 */
export const emoteSignals = new Map<number, EmoteSignal>();

export function pushEmote(localId: number, signal: EmoteSignal): void {
  emoteSignals.set(localId, signal);
}

export const useStore = create<Store>((set) => ({
  appState: 'entry',
  loadStep: 'connecting',
  loadProgress: 0,
  failure: null,

  displayName: localStorage.getItem('hubitat.displayName') ?? '',
  joined: null,
  tuning: null,
  appearance: readStoredAppearance() ?? DEFAULT_APPEARANCE,
  appearanceRemembered: readStoredAppearance() !== null,

  roster: new Map(),
  totalInInstance: 0,
  zones: new Map(),

  role: 'guest',
  capabilities: [],
  moderation: null,

  place: null,
  world: null,
  directory: null,
  mapUpdate: null,

  reconnectAttempt: 0,
  nextRetryInMs: 0,
  notice: null,

  setAppState: (appState) => set({ appState }),
  notify: (message) => set({ notice: { message, at: Date.now() } }),
  dismissNotice: () => set({ notice: null }),
  setLoadStep: (loadStep, loadProgress = 0) => set({ loadStep, loadProgress }),
  fail: (failure) => set({ appState: 'error', failure }),

  setDisplayName: (displayName) => {
    // A convenience only. Identity itself stays ephemeral, as FR-1.7 requires.
    localStorage.setItem('hubitat.displayName', displayName);
    set({ displayName });
  },

  /**
   * FR-4.8 — "persists with their identity: for guests, for the session".
   *
   * Stored beside the display name, and for the same reason: identity itself
   * stays ephemeral (FR-1.7), but making someone rebuild their avatar every time
   * they reload is a worse reading of the requirement than remembering the one
   * thing they chose. Phase 6 moves this to `profiles.avatar_appearance` and the
   * local copy becomes the fallback for guests.
   */
  setAppearance: (appearance) => {
    localStorage.setItem('hubitat.appearance', JSON.stringify(appearance));
    set((state) => {
      const patch = { appearance, appearanceRemembered: true };
      const localId = state.joined?.localId;
      if (localId === undefined) return patch;
      const existing = state.roster.get(localId);
      if (!existing) return patch;
      const roster = new Map(state.roster);
      roster.set(localId, { ...existing, appearance });
      return { ...patch, roster };
    });
  },

  setJoined: (joined) =>
    set((state) => {
      const roster = new Map(state.roster);
      // A *failed* resume mints a new participant under a new local id. Leaving
      // the old entry behind would show the user standing in the list twice,
      // once under an id nothing will ever update again.
      if (state.joined && state.joined.localId !== joined.localId) {
        roster.delete(state.joined.localId);
      }

      // Phase 8 — reload only when the Map genuinely changed, or when nothing is
      // loaded yet. A resume issues a fresh `JOINED` for the world the client is
      // already standing in, and rebuilding physics for a two-second network
      // blip is the regression the old `loadStartedRef` guard existed to
      // prevent. It *can* differ across a resume: somebody whose Map was
      // archived while they were away comes back on the landing Map.
      const needsWorld = state.world === null || state.world.mapId !== joined.mapId;

      return {
        joined,
        place: {
          mapId: joined.mapId,
          mapName: joined.mapName,
          instanceId: joined.instanceId,
          instanceIndex: joined.instanceIndex,
          instanceLabel: joined.instanceLabel || joined.mapName,
          instanceCount: joined.instanceCount,
        },
        world: needsWorld
          ? {
              epoch: (state.world?.epoch ?? 0) + 1,
              mapId: joined.mapId,
              mapUrl: joined.mapUrl,
              mapDocumentUrl: joined.mapDocumentUrl,
              spawn: joined.spawn,
            }
          : state.world,
        tuning: joined.tuning,
        displayName: joined.displayName,
        // `FR-7.2` — stated on the handshake, so the moderation controls are
        // correct on the first frame rather than after a round trip.
        role: joined.identity.role,
        capabilities: [...joined.identity.capabilities],
        // What the server actually gave us, which is not necessarily what was
        // asked for: a first-time guest sends none and gets one generated.
        // Remembered from here on, so a reconnect inside the same session comes
        // back wearing the same thing rather than being re-seeded.
        appearance: joined.appearance,
        appearanceRemembered: true,
        roster: withSelf(roster, joined),
        // Occupancy survives a resume, because the server does not re-announce
        // it: zones live on the participant, not the socket, so reconnecting
        // inside a private zone produces no second `enter`. A fresh participant
        // starts at a spawn, so their old occupancy is stale and must go.
        zones: joined.resumed ? state.zones : new Map(),
      };
    }),

  applySnapshot: (participants, total) =>
    set((state) => {
      const roster = new Map<number, RosterEntry>();
      for (const p of participants) roster.set(p.id, toEntry(p));
      // `SNAPSHOT` replaces the roster wholesale and arrives immediately after
      // `JOINED`, so self has to be put back or it is gone before it was ever
      // seen.
      return { roster: withSelf(roster, state.joined), totalInInstance: total };
    }),

  addParticipant: (participant) =>
    set((state) => {
      const roster = new Map(state.roster);
      roster.set(participant.id, toEntry(participant));
      return { roster };
    }),

  removeParticipant: (localId) =>
    set((state) => {
      if (!state.roster.has(localId)) return state;
      const roster = new Map(state.roster);
      roster.delete(localId);
      // Drop the interpolation history too, or a returning participant would
      // slide in from wherever they last were — and the pending emote, or they
      // would come back mid-wave from a gesture nobody watched.
      remoteBuffers.delete(localId);
      emoteSignals.delete(localId);
      return { roster };
    }),

  updateParticipant: (update) =>
    set((state) => {
      const next: Partial<Store> = {};
      // Destructured out rather than spread through: `total` describes the
      // instance, not the participant, and spreading the whole argument grows a
      // stray field on every RosterEntry it touches.
      const { total, localId, ...fields } = update;
      if (total !== undefined) next.totalInInstance = total;

      const existing = state.roster.get(localId);
      if (existing) {
        const roster = new Map(state.roster);
        roster.set(localId, { ...existing, ...fields });
        next.roster = roster;
      }
      return next;
    }),

  clearRoster: () =>
    set((state) => {
      remoteBuffers.clear();
      emoteSignals.clear();
      // Self is re-seeded rather than dropped: this runs on the resume path, and
      // the participant it describes never left.
      return { roster: withSelf(new Map(), state.joined), totalInInstance: 0 };
    }),

  applyZoneEvent: (event) =>
    set((state) => {
      const zones = new Map(state.zones);
      if (event.kind === 'enter') zones.set(event.zoneId, event.zoneType);
      else zones.delete(event.zoneId);
      return { zones };
    }),

  /**
   * `FR-6.7` — the upgrade, applied to the local view.
   *
   * The stored appearance is deliberately **not** written here. From this moment
   * the profile is where the avatar lives (`FR-6.9`), and leaving a copy in
   * `localStorage` would let a stale browser copy be offered on the next `JOIN`
   * and overwrite what the person set from another device. `appearanceRemembered`
   * stays true because the value in memory is still real — it just came from the
   * server rather than from this browser.
   */
  /**
   * `FR-7.5` — a mute, an unmute, or the same state restated after a resume.
   *
   * The roster copy is updated alongside, because the badge beside your own name
   * comes from there and the two disagreeing would show somebody a working
   * microphone icon over a microphone that will not turn on.
   */
  applyModeration: (moderation) =>
    set((state) => {
      const patch: Partial<Store> = { moderation };
      const localId = state.joined?.localId;
      if (localId === undefined) return patch;

      const existing = state.roster.get(localId);
      if (!existing) return patch;

      const roster = new Map(state.roster);
      roster.set(localId, {
        ...existing,
        moderation: {
          micMuted: moderation.micMuted,
          cameraDisabled: moderation.cameraDisabled,
        },
      });
      return { ...patch, roster };
    }),

  /**
   * `FR-8.6` — the world has been replaced under a socket that never dropped.
   *
   * Everything about *where* is dropped and rebuilt; everything about *who* is
   * kept. That split is the whole method: identity, capabilities, appearance and
   * the resume token did not change because somebody walked through a door, and
   * re-deriving them would make a transfer indistinguishable from a reconnect.
   *
   * The roster is emptied except for self. Nobody in the old Map is in the new
   * one — the server has already stopped sending them and will announce the
   * people here in the `SNAPSHOT` that follows — and leaving them would show a
   * room full of people who are somewhere else.
   */
  applyMapTransfer: (transfer) =>
    set((state) => {
      remoteBuffers.clear();
      emoteSignals.clear();

      // Same Map, different copy of it (`FR-8.8` spilled them, or they followed
      // somebody into instance 2). The geometry is identical, so rebuilding it
      // would be a loading screen for nothing — but the roster still has to go,
      // because the people in the other copy are not here.
      const sameMap = state.world?.mapId === transfer.mapId;

      return {
        place: {
          mapId: transfer.mapId,
          mapName: transfer.mapName,
          instanceId: transfer.instanceId,
          instanceIndex: transfer.instanceIndex,
          instanceLabel: transfer.instanceLabel,
          instanceCount: transfer.instanceCount,
        },
        world: sameMap
          ? state.world
          : {
              epoch: (state.world?.epoch ?? 0) + 1,
              mapId: transfer.mapId,
              mapUrl: transfer.mapUrl,
              mapDocumentUrl: transfer.mapDocumentUrl,
              spawn: transfer.spawn,
            },
        roster: withSelf(new Map(), state.joined),
        totalInInstance: 0,
        // Zone occupancy belongs to the Map that authored the zones. The server
        // published an exit for each of them on the way out; keeping them would
        // leave a "your audio is private" badge lit in a room with no such zone.
        zones: new Map(),
        // `FR-9.20` — arriving anywhere picks up the current version, so an
        // offer to reload for a newer one is answered by the act of moving.
        mapUpdate: null,
        ...(transfer.notice ? { notice: { message: transfer.notice, at: Date.now() } } : {}),
      };
    }),

  setDirectory: (directory) => set({ directory }),

  setMapUpdate: (mapUpdate) => set({ mapUpdate }),

  applyIdentity: (identity) =>
    set((state) => {
      const patch: Partial<Store> = {
        displayName: identity.displayName,
        appearance: identity.appearance,
        appearanceRemembered: true,
        // `FR-7.1`, `FR-7.10` — a role change reaching a session already in the
        // world. The frame is the only thing that carries the capability list,
        // so a demotion has to land here or the panel stays open on a set of
        // controls the server will refuse.
        role: identity.role,
        capabilities: [...identity.capabilities],
        // `joined` is what the server said about *this connection*, and it is
        // what the HUD reads to decide whether to mark somebody a guest. Updated
        // alongside the roster rather than only in it: the roster entry is how
        // observers see you, and this is how you see yourself. Leaving it stale
        // showed a "guest" badge beside the name of somebody who had just
        // finished signing up.
        ...(state.joined
          ? {
              joined: {
                ...state.joined,
                displayName: identity.displayName,
                appearance: identity.appearance,
                identity,
              },
            }
          : {}),
      };

      const localId = state.joined?.localId;
      if (localId === undefined) return patch;

      const existing = state.roster.get(localId);
      if (!existing) return patch;

      const roster = new Map(state.roster);
      roster.set(localId, {
        ...existing,
        displayName: identity.displayName,
        appearance: identity.appearance,
        identity: { kind: identity.kind, member: identity.member },
        role: identity.role,
      });
      return { ...patch, roster };
    }),

  setReconnect: (reconnectAttempt, nextRetryInMs) => set({ reconnectAttempt, nextRetryInMs }),

  reset: () =>
    set(() => {
      remoteBuffers.clear();
      emoteSignals.clear();
      return {
        appState: 'entry',
        failure: null,
        joined: null,
        roster: new Map(),
        totalInInstance: 0,
        zones: new Map(),
        // Phase 7 — dropped with the rest of the world state. A capability list
        // is about a connection, and there is no connection on the entry screen;
        // keeping it would let the moderation panel open on a session that has
        // ended. The next `JOINED` states it again.
        role: 'guest' as Role,
        capabilities: [],
        moderation: null,
        // Phase 8 — dropped with the rest of the world state, and `world` in
        // particular: leaving it would make the next `JOINED` decide no reload
        // was needed and drop the user into a scene that had been disposed.
        place: null,
        world: null,
        directory: null,
        mapUpdate: null,
        reconnectAttempt: 0,
        // A message about the world you just left has nothing to say about the
        // start screen.
        notice: null,
      };
    }),
}));

/** `FR-7.2` — whether this connection may do something. One reader, so a
 *  component never re-derives the matrix. */
export const can = (capability: Capability) => (state: Store) =>
  state.capabilities.includes(capability);

function toEntry(participant: ParticipantDto): RosterEntry {
  return {
    localId: participant.id,
    sessionId: participant.sessionId,
    displayName: participant.displayName,
    activity: participant.activity,
    status: participant.status,
    // Phase 4 Rules — carried on every add and snapshot, which is what makes a
    // late arrival see the current look rather than the default.
    appearance: participant.appearance,
    // Phase 6. Defaulted for a frame from a server that predates the field —
    // "guest" is what everybody was before it existed.
    identity: participant.identity ?? { kind: 'guest', member: false },
    // Phase 7, same reasoning: a frame from an older server describes somebody
    // with no role, nothing taken away, and nobody blocked, which is what they
    // were.
    role: participant.role ?? 'guest',
    moderation: participant.moderation ?? NO_MODERATION,
    blocked: participant.blocked ?? false,
  };
}

/**
 * The remembered appearance, or a default.
 *
 * Validated rather than trusted: this is user-writable storage, and a hand-edited
 * or stale entry would otherwise reach the renderer as `undefined.colors.skin`
 * on the first frame. Anything unparseable falls back silently — a corrupted
 * outfit is not worth a message.
 */
function readStoredAppearance(): AvatarAppearance | null {
  const raw = localStorage.getItem('hubitat.appearance');
  if (!raw) return null;
  try {
    const parsed = avatarAppearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // User-writable storage, so a hand-edited or stale entry is expected rather
    // than exceptional. Null, not a default: nothing remembered means the server
    // gets to choose, which is what makes guests look different from each other.
    return null;
  }
}

/**
 * Put the local participant into a roster, preserving whatever the server has
 * already said about them.
 *
 * Activity and status are server-derived (`FR-1.22` forbids a client claiming
 * `idle`), so a rebuild must not reset them to the defaults — walking through a
 * snapshot while idle would flip the indicator back to active without any input
 * having happened.
 */
function withSelf(
  roster: Map<number, RosterEntry>,
  joined: JoinedPayload | null,
): Map<number, RosterEntry> {
  if (!joined) return roster;
  const previous = roster.get(joined.localId);
  roster.set(joined.localId, {
    localId: joined.localId,
    sessionId: joined.sessionId,
    displayName: joined.displayName,
    activity: previous?.activity ?? 'active',
    status: previous?.status ?? 'available',
    // Same rule as activity and status: a rebuild must not undo what the server
    // has already said. A customization made mid-session survives the snapshot
    // that follows a resume.
    appearance: previous?.appearance ?? joined.appearance,
    // Phase 6 — from `JOINED`, which states it rather than leaving the client to
    // infer it from whether a token was sent. Not taken from `previous`: unlike
    // appearance, this is re-decided by the server on every handshake, and a
    // remembered `account` would survive a sign-out.
    identity: { kind: joined.identity.kind, member: joined.identity.member },
    // Phase 7, and the same rule: re-decided on every handshake.
    role: joined.identity.role,
    // Taken from `previous` where there is one, because a force-mute is *not*
    // re-decided by a snapshot: the server re-sends `MODERATION_STATE` after a
    // resume, and a rebuild that reset this would flash an unmuted badge in
    // between.
    moderation: previous?.moderation ?? NO_MODERATION,
    blocked: previous?.blocked ?? false,
  });
  return roster;
}

/** True while the local participant is inside any private zone.
 *
 *  Which one is deliberately not derived: overlapping private zones resolve by
 *  smallest volume on the server, and re-implementing that here would be a
 *  second copy of a decision only the server is allowed to make. */
export const inPrivateZone = (state: Store): boolean =>
  [...state.zones.values()].includes('private');

export const inSpotlight = (state: Store): boolean =>
  [...state.zones.values()].includes('spotlight');
