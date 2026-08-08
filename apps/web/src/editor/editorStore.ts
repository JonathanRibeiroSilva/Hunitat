/**
 * The editor's state, and the command stack that makes it undoable — phase 9.
 *
 * ── Every mutation is a command ─────────────────────────────────────────────
 *
 * `FR-9.2` asks for undo/redo, and the phase notes name the way it usually ships
 * broken: "undo/redo must cover zone and property edits, not just transforms.
 * Partial undo is worse than none — users stop trusting it."
 *
 * So there is exactly one way to change the document — `apply`, which takes a
 * function producing the next one and pushes the previous onto a stack — and no
 * component anywhere writes `document` directly. That is what makes coverage
 * structural: a new edit *cannot* be un-undoable, because there is no other door.
 *
 * Whole-document snapshots rather than inverse operations, deliberately. A map
 * document is tens of kilobytes and an edit happens at human speed; the memory
 * is nothing, and inverse operations are where partial undo comes from — every
 * new kind of edit needs its own inverse, and the one somebody forgets is the
 * one that breaks trust in all of them.
 *
 * ── Saving is separate from editing ─────────────────────────────────────────
 *
 * The document in this store is *local*. `save` sends it with the revision it
 * was loaded at (`FR-9.22`); a 409 means somebody else got there first, and the
 * answer is to reload rather than retry — retrying is precisely the overwrite
 * the requirement forbids.
 */

import { create } from 'zustand';
import {
  MAP_DOCUMENT_WARN_BYTES,
  POSITION_MAX_M,
  type AssetDto,
  type EditorStateDto,
  type MapDocument,
  type MapVersionDto,
  type PlacedObject,
  type Zone,
  type ZoneType,
} from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';

/** What the gizmo is doing. `play` is not a tool — it is `FR-9.3`, walking the
 *  draft as a participant would — but it belongs in the same mutually-exclusive
 *  set because the same click means different things in each. */
export type EditorMode = 'select' | 'translate' | 'rotate' | 'scale' | 'play';

/** What is selected: one placed object, or one zone. Never both, and never
 *  several — multi-select is a real feature and a half-built one is worse than
 *  none, since every property panel would have to answer "what do I show". */
export type Selection = { kind: 'object'; id: string } | { kind: 'zone'; id: string } | null;

/** How deep the history goes. Snapshots are cheap and an author's afternoon is
 *  not; a hundred steps is more than anybody reaches for and still bounded. */
const HISTORY_LIMIT = 100;

interface EditorStore {
  /** Null until a map is opened. Everything below is meaningless without it. */
  mapId: string | null;
  spaceSlug: string;
  mapName: string;

  document: MapDocument | null;
  /** What the server last confirmed, so `dirty` is "differs from saved" rather
   *  than "has ever been touched". */
  savedDocument: MapDocument | null;
  revision: number;

  past: MapDocument[];
  future: MapDocument[];

  mode: EditorMode;
  selection: Selection;

  assets: AssetDto[];
  versions: MapVersionDto[];
  publishedVersion: number;
  /** Who saved the draft last, so the version bar can say so — and so an author
   *  who is about to be refused by `FR-9.22` sees whose work they would have
   *  overwritten before they press save. */
  draftUpdatedBy: string | null;
  lock: EditorStateDto['lock'];
  brokenPortals: { zoneId: string; targetMapId: string }[];

  saving: boolean;
  error: string | null;
  notice: string | null;

  open: (state: EditorStateDto, spaceSlug: string) => void;
  close: () => void;
  adopt: (state: EditorStateDto) => void;

  /** The one door. See the header. */
  apply: (change: (document: MapDocument) => MapDocument, label?: string) => void;
  undo: () => void;
  redo: () => void;

  setMode: (mode: EditorMode) => void;
  select: (selection: Selection) => void;
  setError: (error: string | null) => void;
  notify: (message: string | null) => void;

  save: () => Promise<void>;
  publish: (notes?: string) => Promise<void>;
  revert: (version: number, publish: boolean) => Promise<void>;
  discard: () => Promise<void>;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  mapId: null,
  spaceSlug: 'default',
  mapName: '',

  document: null,
  savedDocument: null,
  revision: 0,

  past: [],
  future: [],

  mode: 'select',
  selection: null,

  assets: [],
  versions: [],
  publishedVersion: 0,
  draftUpdatedBy: null,
  lock: null,
  brokenPortals: [],

  saving: false,
  error: null,
  notice: null,

  open: (state, spaceSlug) =>
    set({
      mapId: state.mapId,
      spaceSlug,
      mapName: state.mapName,
      document: state.draft,
      savedDocument: state.draft,
      revision: state.revision,
      past: [],
      future: [],
      mode: 'select',
      selection: null,
      assets: state.assets,
      versions: state.versions,
      publishedVersion: state.publishedVersion,
      draftUpdatedBy: state.draftUpdatedBy,
      lock: state.lock,
      brokenPortals: state.brokenPortals,
      error: null,
      notice: null,
    }),

  close: () =>
    set({
      mapId: null,
      document: null,
      savedDocument: null,
      past: [],
      future: [],
      selection: null,
      mode: 'select',
      error: null,
      notice: null,
    }),

  /**
   * Take what the server just said, without losing what the author is doing.
   *
   * The document is deliberately **not** replaced here. This runs after a save,
   * a lock heartbeat and a publish, all of which can land while somebody is
   * mid-drag — and adopting the server's copy would snap their gizmo back to
   * where it was when the request left. What is adopted is everything the
   * server owns: the revision, the versions, the lock, the library.
   */
  adopt: (state) =>
    set({
      revision: state.revision,
      savedDocument: state.draft,
      assets: state.assets,
      versions: state.versions,
      publishedVersion: state.publishedVersion,
      draftUpdatedBy: state.draftUpdatedBy,
      lock: state.lock,
      brokenPortals: state.brokenPortals,
    }),

  apply: (change) =>
    set((store) => {
      if (!store.document) return store;
      const next = change(store.document);
      if (next === store.document) return store;
      return {
        document: next,
        past: [...store.past, store.document].slice(-HISTORY_LIMIT),
        // Any new edit invalidates the redo branch. Keeping it would let an
        // author redo their way into a document that never existed.
        future: [],
      };
    }),

  undo: () =>
    set((store) => {
      const previous = store.past.at(-1);
      if (!previous || !store.document) return store;
      return {
        document: previous,
        past: store.past.slice(0, -1),
        future: [store.document, ...store.future].slice(0, HISTORY_LIMIT),
        // A selection can name something that no longer exists one step back.
        // Cleared rather than validated: the inspector would otherwise render
        // for an object that is not there.
        selection: null,
      };
    }),

  redo: () =>
    set((store) => {
      const next = store.future[0];
      if (!next || !store.document) return store;
      return {
        document: next,
        past: [...store.past, store.document].slice(-HISTORY_LIMIT),
        future: store.future.slice(1),
        selection: null,
      };
    }),

  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
  setError: (error) => set({ error }),
  notify: (notice) => set({ notice }),

  save: async () => {
    const { mapId, spaceSlug, document, revision } = get();
    if (!mapId || !document) return;

    set({ saving: true, error: null });
    try {
      const state = await auth.saveDraft(spaceSlug, mapId, document, revision);
      get().adopt(state);
      set({ notice: 'Draft saved.' });
    } catch (error) {
      // A 409 is `FR-9.22` doing its job, and it needs a different sentence from
      // every other failure: the request was well-formed and was refused because
      // somebody else's work would have been destroyed by it.
      set({ error: describe(error) });
    } finally {
      set({ saving: false });
    }
  },

  publish: async (notes) => {
    const { mapId, spaceSlug, document, revision } = get();
    if (!mapId || !document) return;

    set({ saving: true, error: null });
    try {
      // Saved first, always. Publishing the *server's* draft when the author has
      // unsaved changes on screen would publish a version they never saw.
      const saved = await auth.saveDraft(spaceSlug, mapId, document, revision);
      const state = await auth.publishMap(spaceSlug, mapId, notes);
      get().adopt(state);
      set({
        notice: `Published version ${state.publishedVersion}. People inside have been offered a reload.`,
      });
      void saved;
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set({ saving: false });
    }
  },

  revert: async (version, publish) => {
    const { mapId, spaceSlug } = get();
    if (!mapId) return;

    set({ saving: true, error: null });
    try {
      const state = await auth.revertMap(spaceSlug, mapId, version, publish);
      // The whole document *is* replaced here, unlike `adopt` — reverting is an
      // explicit "throw away what is on screen", which is the one time that is
      // what the author asked for.
      set({
        document: state.draft,
        savedDocument: state.draft,
        past: [],
        future: [],
        selection: null,
        notice: publish
          ? `Reverted to version ${version} and published it as ${state.publishedVersion}.`
          : `Version ${version} loaded into the draft. Publish it when you are ready.`,
      });
      get().adopt(state);
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set({ saving: false });
    }
  },

  discard: async () => {
    const { mapId, spaceSlug } = get();
    if (!mapId) return;

    set({ saving: true, error: null });
    try {
      const state = await auth.discardDraft(spaceSlug, mapId);
      set({
        document: state.draft,
        savedDocument: state.draft,
        past: [],
        future: [],
        selection: null,
        notice: 'Draft discarded — back to the published version.',
      });
      get().adopt(state);
    } catch (error) {
      set({ error: describe(error) });
    } finally {
      set({ saving: false });
    }
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Derived readers
// ─────────────────────────────────────────────────────────────────────────────

export const isDirty = (store: EditorStore): boolean =>
  store.document !== null &&
  store.savedDocument !== null &&
  JSON.stringify(store.document) !== JSON.stringify(store.savedDocument);

/** Sharp edge nº4 in the phase notes: a `jsonb` document should stay well under
 *  a megabyte, and the only way that stays true is if the number is on screen
 *  before it stops being. */
export const documentBytes = (store: EditorStore): number =>
  store.document ? new TextEncoder().encode(JSON.stringify(store.document)).byteLength : 0;

export const isLarge = (store: EditorStore): boolean =>
  documentBytes(store) > MAP_DOCUMENT_WARN_BYTES;

// ─────────────────────────────────────────────────────────────────────────────
// Document edits
//
// Pure functions from a document to the next one. Every one of them is handed to
// `apply`, which is what makes it undoable — and none of them mutates, because a
// mutated snapshot in the history stack is a history that changes underneath the
// author.
// ─────────────────────────────────────────────────────────────────────────────

/** `FR-9.1` — place an asset from the library. */
export function placeObject(
  document: MapDocument,
  assetSlug: string,
  position: { x: number; y: number; z: number },
): MapDocument {
  const object: PlacedObject = {
    id: uniqueId(
      document.objects.map((existing) => existing.id),
      assetSlug,
    ),
    assetId: assetSlug,
    transform: {
      position: clampPoint(position),
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  };
  return { ...document, objects: [...document.objects, object] };
}

/** `FR-9.2` — duplicate, offset so the copy is visibly a second thing rather
 *  than sitting exactly inside the original. */
export function duplicateObject(document: MapDocument, id: string): MapDocument {
  const source = document.objects.find((object) => object.id === id);
  if (!source) return document;

  const copy: PlacedObject = {
    ...source,
    id: uniqueId(
      document.objects.map((object) => object.id),
      source.assetId,
    ),
    transform: {
      ...source.transform,
      position: clampPoint({
        x: source.transform.position.x + 1,
        y: source.transform.position.y,
        z: source.transform.position.z + 1,
      }),
    },
  };
  return { ...document, objects: [...document.objects, copy] };
}

export function updateObject(
  document: MapDocument,
  id: string,
  // `transform` is lifted out of the partial rather than intersected with it:
  // an intersection of `transform?: Full` and `transform?: Partial` resolves back
  // to `Full`, so a caller changing only the position would have to restate the
  // rotation and the scale it is not touching.
  patch: Omit<Partial<PlacedObject>, 'transform'> & {
    transform?: Partial<PlacedObject['transform']>;
  },
): MapDocument {
  return {
    ...document,
    objects: document.objects.map((object) =>
      object.id === id
        ? {
            ...object,
            ...patch,
            transform: {
              ...object.transform,
              ...patch.transform,
              // Clamped on every write rather than validated on save. Sharp edge
              // nº5: geometry outside ±327.67 m cannot be represented on the
              // wire at all, and the moment to say so is while the author is
              // dragging, not when they press publish.
              position: clampPoint(patch.transform?.position ?? object.transform.position),
            },
          }
        : object,
    ),
  };
}

export function removeObject(document: MapDocument, id: string): MapDocument {
  return { ...document, objects: document.objects.filter((object) => object.id !== id) };
}

/** `FR-9.2` — grouping, as a name on the object rather than a tree. The Map
 *  Document has a `group` field and no hierarchy; inventing one here would be a
 *  format change three phases depend on. */
export function setObjectGroup(
  document: MapDocument,
  id: string,
  group: string | undefined,
): MapDocument {
  return {
    ...document,
    objects: document.objects.map((object) =>
      object.id === id ? { ...object, ...(group ? { group } : { group: undefined }) } : object,
    ),
  };
}

/** `FR-9.5`–`FR-9.9` — a zone of any of the six authored types. */
export function addZone(
  document: MapDocument,
  type: ZoneType,
  center: { x: number; y: number; z: number },
): MapDocument {
  const zone: Zone = {
    id: uniqueId(
      document.zones.map((existing) => existing.id),
      type,
    ),
    type,
    volume: {
      shape: 'box',
      center: clampPoint({ x: center.x, y: Math.max(center.y, 1.25), z: center.z }),
      size: { x: 4, y: 3, z: 4 },
      yaw: 0,
    },
    properties: defaultZoneProperties(type),
  };
  return { ...document, zones: [...document.zones, zone] };
}

export function updateZone(document: MapDocument, id: string, patch: Partial<Zone>): MapDocument {
  return {
    ...document,
    zones: document.zones.map((zone) =>
      zone.id === id
        ? {
            ...zone,
            ...patch,
            properties: { ...zone.properties, ...patch.properties },
            volume: patch.volume ?? zone.volume,
          }
        : zone,
    ),
  };
}

export function removeZone(document: MapDocument, id: string): MapDocument {
  return { ...document, zones: document.zones.filter((zone) => zone.id !== id) };
}

/** `FR-9.6` — spawns are their own list, not zones. A `spawn` *zone* names one;
 *  this is the point itself. */
export function addSpawn(
  document: MapDocument,
  position: { x: number; y: number; z: number },
): MapDocument {
  const id = uniqueId(
    document.spawns.map((spawn) => spawn.id),
    'spawn',
  );
  return {
    ...document,
    spawns: [
      ...document.spawns,
      {
        id,
        position: clampPoint(position),
        yaw: 0,
        // Never the default on creation: exactly one spawn is, the document
        // schema enforces it, and a second `default: true` would make the
        // document unsaveable rather than merely wrong.
        default: false,
        radiusM: 1.5,
      },
    ],
  };
}

export function removeSpawn(document: MapDocument, id: string): MapDocument {
  const spawn = document.spawns.find((candidate) => candidate.id === id);
  // The schema requires exactly one default spawn and at least one spawn.
  // Refusing here is what turns "the save failed for a reason you cannot see"
  // into a button that does not do the thing.
  if (!spawn || spawn.default || document.spawns.length <= 1) return document;
  return { ...document, spawns: document.spawns.filter((candidate) => candidate.id !== id) };
}

export function makeDefaultSpawn(document: MapDocument, id: string): MapDocument {
  return {
    ...document,
    spawns: document.spawns.map((spawn) => ({ ...spawn, default: spawn.id === id })),
  };
}

/** `FR-9.16` — lighting and environment. */
export function updateEnvironment(
  document: MapDocument,
  patch: Partial<MapDocument['environment']>,
): MapDocument {
  return { ...document, environment: { ...document.environment, ...patch } };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sensible starting properties per zone type.
 *
 * A zone created with none is legal and useless — a private zone with no gain is
 * a volume that does nothing, and an author would have to know which of eight
 * fields applies to which of six types before seeing any effect.
 */
function defaultZoneProperties(type: ZoneType): Zone['properties'] {
  switch (type) {
    case 'private':
      return { gain: 1.0, chatEnabled: true };
    case 'spotlight':
      return { gain: 1.0, scope: 'map' };
    case 'portal':
      // Deliberately empty: a portal with no target is flagged by the editor and
      // refused by publish, which is better than one silently pointing at a
      // spawn the author did not choose.
      return {};
    case 'trigger':
      return { key: 'trigger', chatEnabled: false };
    case 'spawn':
      return { rule: 'least-crowded' };
    case 'collision':
    default:
      return {};
  }
}

function uniqueId(existing: string[], base: string): string {
  const taken = new Set(existing);
  for (let index = 1; ; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Sharp edge nº5 — the coordinate range the wire format can represent. */
function clampPoint(point: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  const clamp = (value: number): number =>
    Math.max(-POSITION_MAX_M, Math.min(POSITION_MAX_M, Number(value.toFixed(3))));
  return { x: clamp(point.x), y: clamp(point.y), z: clamp(point.z) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
