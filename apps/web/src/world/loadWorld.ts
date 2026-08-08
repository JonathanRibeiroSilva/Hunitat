/**
 * World loading, done imperatively rather than through Suspense.
 *
 * The UX spec is explicit that the canvas is never shown partially built, and
 * that a failure names the step that failed — "Couldn't download the world" is
 * actionable, "Something went wrong" is not
 * (specs/ux/phase-01-screens.md).
 *
 * Suspense would give a single opaque pending state and swallow the distinction
 * between a network failure and a corrupt file, so the steps are driven here.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type * as THREE from 'three';
import { mapDocumentSchema, type ClientTuning, type MapDocument } from '@hubitat/protocol';
import { loadAvatarModel, releaseAvatarModel, retainAvatarModel } from './avatarModel.js';
import { buildPhysics, initPhysics, type PhysicsWorld } from './physics.js';
import { useStore } from '../state/store.js';

/**
 * Empty is meaningful and must stay `??`, not `||`: it leaves asset paths
 * relative, so they resolve against whatever origin served the page. That is
 * what lets a tunnelled dev server work — see docs/remote-media-testing.md.
 */
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * specs/ux/phase-01-screens.md — "A step exceeding 30 seconds is treated as
 * failed."
 *
 * Distinct from NFR-13's 8 s budget: that is the target, this is the point at
 * which waiting longer tells the user nothing. Without it a stalled fetch leaves
 * the loading screen spinning forever, which is the void the Phase 1 rule exists
 * to prevent — it just takes longer to look like one.
 */
const STEP_TIMEOUT_MS = 30_000;

export class WorldLoadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface LoadedWorld {
  scene: THREE.Group;
  document: MapDocument;
  physics: PhysicsWorld;
  /**
   * Phase 9, `DC-9.2` — the models placed objects resolve to, keyed by the asset
   * slug a document names.
   *
   * Separate from `scene` because they are instanced: a room has eight of the
   * same chair, and loading the file once per placement would download it eight
   * times and hold eight copies of its geometry. `WorldScene` clones from here.
   */
  assets: Map<string, THREE.Group>;
}

export async function loadWorld(
  mapUrl: string,
  mapDocumentUrl: string,
  avatarModelUrl: string,
  spawn: { x: number; y: number; z: number },
  tuning: ClientTuning,
): Promise<LoadedWorld> {
  const store = useStore.getState();

  // ── physics runtime ────────────────────────────────────────────────────────
  store.setLoadStep('physics');
  try {
    await withStepTimeout(
      initPhysics(),
      () =>
        new WorldLoadError(
          "Your browser couldn't start the physics engine.",
          false,
          `WebAssembly did not initialise within ${STEP_TIMEOUT_MS / 1000} s.`,
        ),
    );
  } catch (error) {
    if (error instanceof WorldLoadError) throw error;
    throw new WorldLoadError(
      "Your browser couldn't start the physics engine.",
      false,
      `WebAssembly failed to initialise. ${describe(error)}`,
    );
  }

  // ── map document ───────────────────────────────────────────────────────────
  store.setLoadStep('downloading-world', 0.05);
  let document: MapDocument;
  try {
    // The signal is what actually releases the socket; the wrapper below only
    // stops us waiting. Both, because neither is sufficient alone.
    const response = await fetch(absolute(mapDocumentUrl), {
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = mapDocumentSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new WorldLoadError(
        'The world file is damaged or in an unsupported format.',
        false,
        parsed.error.toString(),
      );
    }
    document = parsed.data;
  } catch (error) {
    if (error instanceof WorldLoadError) throw error;
    throw new WorldLoadError(
      "Couldn't download the world.",
      true,
      `Fetching ${mapDocumentUrl} failed. ${describe(error)}`,
    );
  }

  // ── geometry ───────────────────────────────────────────────────────────────
  const loader = new GLTFLoader();
  let scene: THREE.Group;
  try {
    // GLTFLoader exposes no way to cancel, so a timeout here abandons the
    // request rather than aborting it. The user gets an answer either way, which
    // is the part the spec is about.
    const gltf = await withStepTimeout(
      loader.loadAsync(absolute(mapUrl), (event) => {
        // Content-Length is absent on chunked responses, so progress is
        // best-effort. The step label still tells the user what is happening.
        if (event.lengthComputable) {
          store.setLoadStep('downloading-world', 0.05 + (event.loaded / event.total) * 0.85);
        }
      }),
      () =>
        new WorldLoadError(
          "Couldn't download the world.",
          true,
          `${mapUrl} did not finish downloading within ${STEP_TIMEOUT_MS / 1000} s.`,
        ),
    );
    scene = gltf.scene;
  } catch (error) {
    if (error instanceof WorldLoadError) throw error;
    throw new WorldLoadError(
      "Couldn't download the world.",
      true,
      `Loading ${mapUrl} failed. ${describe(error)}`,
    );
  }

  // ── colliders ──────────────────────────────────────────────────────────────
  // Usually the slowest step, and the one people mistake for a slow download.
  // No timeout guard here on purpose: trimesh construction is synchronous, so
  // nothing — not this function, not the frame loop — runs while it does. The
  // bound that matters for it is ASSET_MAX_TRIANGLES at authoring time.
  store.setLoadStep('building-collision', 0.95);
  let physics: PhysicsWorld;
  try {
    physics = buildPhysics(scene, spawn, tuning, document);
  } catch (error) {
    throw new WorldLoadError(
      'The world file is damaged or in an unsupported format.',
      false,
      `Building collision geometry failed. ${describe(error)}`,
    );
  }

  if (physics.colliderCount === 0 && physics.zoneColliderCount === 0) {
    // Legal but almost always a mistake: neither source produced anything, so
    // movement is unblocked everywhere (specs/protocol/map-document.md).
    console.warn(
      '[world] no COL_ nodes and no collision zones — nothing will block movement. ' +
        'Check the node naming convention in specs/protocol/map-document.md',
    );
  } else if (physics.colliderCount === 0 && document.geometry.collisionMode === 'convention') {
    // Zones alone will hold, but a `convention` map that produced no mesh
    // colliders is a naming mistake rather than a deliberately sparse world.
    console.warn(
      `[world] collisionMode is "convention" but no COL_ nodes were found; ` +
        `only ${physics.zoneColliderCount} authored zone collider(s) will block movement.`,
    );
  }

  // ── avatars ────────────────────────────────────────────────────────────────
  // After collision rather than in parallel with it, because collider
  // construction is synchronous and would stall the fetch anyway — and because
  // this must finish before the scene appears. An avatar arriving one frame
  // after the world does is fifteen people popping into existence.
  store.setLoadStep('loading-avatar', 0.97);
  try {
    await withStepTimeout(
      loadAvatarModel(absolute(avatarModelUrl)),
      () =>
        new WorldLoadError(
          "Couldn't download the avatars.",
          true,
          `${avatarModelUrl} did not finish downloading within ${STEP_TIMEOUT_MS / 1000} s.`,
        ),
    );
  } catch (error) {
    if (error instanceof WorldLoadError) throw error;
    throw new WorldLoadError(
      "Couldn't download the avatars.",
      true,
      `Loading ${avatarModelUrl} failed. ${describe(error)}`,
    );
  }

  // ── placed objects (phase 9) ───────────────────────────────────────────────
  //
  // After the avatar, and deliberately **not fatal**. The map's own geometry is
  // the room; a placed object that fails to download is a missing chair, and
  // refusing to enter a world over one would be a far larger consequence than
  // the fault. Each failure is logged and the object is simply absent.
  //
  // The document names assets by *slug*, never by URL — a URL is either
  // presigned and expiring or a path that moves when storage does, and the
  // document is retained for versions. So the manifest is fetched separately and
  // resolved here.
  const assets = new Map<string, THREE.Group>();
  if (document.objects.length > 0) {
    try {
      const response = await fetch(absolute(mapAssetsUrl(mapDocumentUrl)), {
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      if (response.ok) {
        const manifest = (await response.json()) as { slug: string; url: string }[];
        await Promise.all(
          manifest.map(async (entry) => {
            try {
              const gltf = await loader.loadAsync(absolute(entry.url));
              assets.set(entry.slug, gltf.scene);
            } catch (error) {
              console.warn(`[world] asset "${entry.slug}" failed to load: ${describe(error)}`);
            }
          }),
        );
      }
    } catch (error) {
      console.warn(`[world] could not read the asset manifest: ${describe(error)}`);
    }
  }

  // Claimed here rather than inside `loadAvatarModel`, and only now: everything
  // that can fail has, so this world is definitely going to exist and is
  // therefore definitely going to be disposed. A claim taken at load time would
  // be left dangling by a world that threw on a later step.
  retainAvatarModel();

  store.setLoadStep('entering', 1);
  return { scene, document, physics, assets };
}

/** `/maps/<id>/document` → `/maps/<id>/assets`. Derived rather than passed on
 *  the wire: they are two reads of one Map, and a second field would be a second
 *  thing for a frame to get wrong. */
function mapAssetsUrl(mapDocumentUrl: string): string {
  return mapDocumentUrl.replace(/\/document$/, '/assets');
}

/**
 * Explicit teardown — NFR-14.
 *
 * Three.js frees nothing on garbage collection, and R3F only disposes what it
 * created itself: `<primitive object={world.scene}>` is borrowed, not owned, so
 * the GLB is ours to release. Rapier is worse — its `World` holds WASM memory
 * that no JavaScript collector can see at all.
 *
 * Without this, every retry and every trip back to the start screen leaks a
 * whole world, and NFR-14's one-hour memory ceiling is a claim rather than a
 * property.
 */
export function disposeWorld(world: LoadedWorld): void {
  // Freeing a Rapier world twice corrupts the WASM heap, and the callers that
  // drop a world are several. Idempotence is cheaper than tracing that crash.
  if (disposed.has(world)) return;
  disposed.add(world);

  const release = (root: THREE.Object3D): void => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material) disposeMaterial(material);
      }
    });
  };

  release(world.scene);
  // Phase 9 — the library models this map placed. Cloned instances share this
  // geometry, so freeing the sources is what actually returns the memory; the
  // clones are R3F's and go with the scene graph.
  for (const asset of world.assets.values()) release(asset);

  // "All the fields of this physics world will be freed as well" — colliders,
  // the character body and the controller go with it.
  world.physics.world.free();

  // The shared avatar geometry, released here rather than by the last avatar to
  // unmount: making instances responsible for shared geometry is how one person
  // walking away blanks everybody else (phase 4 risk nº3).
  //
  // A release, not a free. The model is shared across worlds as well as across
  // participants, and a map transfer (`FR-8.6`) has the destination already
  // built and drawing from it by the time this runs — freeing it outright there
  // left every avatar in the room you had just entered invisible. It goes when
  // the last world holding it goes.
  releaseAvatarModel();
}

const disposed = new WeakSet<LoadedWorld>();

function disposeMaterial(material: THREE.Material): void {
  // Textures hang off differently-named slots per material type (map, normalMap,
  // aoMap, …). Scanning the properties catches whatever a future GLB brings
  // instead of a list that silently stops being complete.
  for (const value of Object.values(material)) {
    if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}

/**
 * Reject a step that outlives its budget, with a message naming what stalled.
 *
 * The work itself is not cancelled — that is the caller's job where it is
 * possible at all — so this settles the promise and lets the loader move to the
 * ERROR state.
 */
function withStepTimeout<T>(work: Promise<T>, onTimeout: () => WorldLoadError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), STEP_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function absolute(path: string): string {
  return path.startsWith('http') ? path : `${API_URL}${path}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
