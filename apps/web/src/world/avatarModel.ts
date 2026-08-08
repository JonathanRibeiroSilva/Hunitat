/**
 * The avatar model: loaded once, cloned per participant.
 *
 * Phase 4 risk nº2 — instancing a character is expensive, and re-parsing the
 * file per participant is the version of it that only shows up in a crowd. The
 * GLB is fetched and parsed exactly once; every avatar after that is a clone
 * sharing the same geometry.
 *
 * Risk nº3 is the other half: a clone shares geometry but owns its materials
 * (customization means each participant is a different colour), so disposal is
 * asymmetric. `disposeAvatarInstance` frees the materials it created and leaves
 * the shared geometry alone; `releaseAvatarModel` frees the geometry when the
 * last world holding it goes. Freeing geometry per instance would blank every
 * other avatar.
 *
 * The model outlives an individual world, which is why the release is counted
 * rather than unconditional — see `retained`.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import {
  AVATAR_ACCESSORIES,
  AVATAR_PALETTES,
  REQUIRED_AVATAR_CLIPS,
  colorFor,
  type AvatarAppearance,
  type AvatarBaseModel,
  type AvatarColorSlot,
} from '@hubitat/protocol';

export interface AvatarModel {
  /** The parsed source. Never added to a scene — only cloned from. */
  readonly source: THREE.Group;
  readonly clips: readonly THREE.AnimationClip[];
}

export interface AvatarInstance {
  readonly root: THREE.Group;
  readonly clips: readonly THREE.AnimationClip[];
  /** Materials this instance owns, and the only thing it may dispose. */
  readonly materials: Map<AvatarColorSlot | 'Detail', THREE.MeshStandardMaterial>;
  /** Nodes whose girth the build variant scales, with their authored scale —
   *  captured once, because applying a factor to a value already scaled would
   *  compound on every appearance change. */
  readonly bodyParts: { node: THREE.Object3D; baseScale: THREE.Vector3 }[];
  readonly accessories: Map<string, THREE.Object3D[]>;
}

/**
 * Girth multipliers per build.
 *
 * X and Z only. Height is fixed at `AVATAR_HEIGHT_M` because the physics
 * capsule, the camera target and the nameplate anchor are all derived from it —
 * a taller avatar would collide differently from how it looks.
 */
const BUILD_SCALE: Record<AvatarBaseModel, [number, number]> = {
  standard: [1, 1],
  slim: [0.86, 0.9],
  broad: [1.16, 1.08],
};

const COLOR_SLOTS: readonly AvatarColorSlot[] = ['skin', 'hair', 'top', 'bottom'];

/** Material name in the GLB → the appearance slot that colours it. `Detail`
 *  (eyes, shoes, glasses) is deliberately absent: it is not customizable. */
const MATERIAL_SLOT: Record<string, AvatarColorSlot> = {
  Skin: 'skin',
  Hair: 'hair',
  Top: 'top',
  Bottom: 'bottom',
};

let loading: Promise<AvatarModel> | null = null;
let loaded: AvatarModel | null = null;

/**
 * How many loaded worlds are holding the shared model.
 *
 * A map transfer (`FR-8.6`) overlaps two worlds by construction: `loadWorld`
 * for the destination finishes first, and only then does React run the cleanup
 * that drops the world being left. The destination's avatars are clones of this
 * same source — `loadAvatarModel` is idempotent, so nothing was re-parsed — so
 * freeing on the first release frees the geometry the room now on screen is
 * drawing from, and nulls `loaded` out from under `Avatar`'s build effect,
 * which reads it synchronously and gives up when it is missing.
 *
 * The symptom is every avatar in the room you just walked into being invisible
 * — nameplate and speaking ring still drawn, because those are React children
 * rather than parts of the model — with nothing in the console to say why.
 *
 * Counting the holders is what makes the overlap safe: the arrival retains
 * before the departure releases, so the count dips to one rather than to zero
 * and the geometry survives the handover.
 */
let retained = 0;

/**
 * Idempotent. Called from the loading screen so the model is parsed before the
 * world appears, and from anywhere else that needs it — the promise is shared,
 * so two callers do not produce two downloads.
 */
export function loadAvatarModel(url: string): Promise<AvatarModel> {
  loading ??= new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      const model: AvatarModel = { source: gltf.scene, clips: gltf.animations };
      warnAboutMissingPieces(model, url);
      loaded = model;
      return model;
    })
    .catch((error: unknown) => {
      // Cleared so a retry can try again. A cached rejection would make the
      // second attempt fail instantly with the first attempt's error.
      loading = null;
      throw error;
    });
  return loading;
}

export function avatarModel(): AvatarModel | null {
  return loaded;
}

/**
 * The contract in assets/avatars/README.md, checked against what actually
 * loaded.
 *
 * A warning rather than a failure, and the same judgement `loadWorld` makes
 * about missing `COL_` nodes: a model with no `run` clip is usable and someone
 * needs to be told, whereas refusing to render anybody because a hat is missing
 * helps no one. Silence is the only wrong answer — the symptom of a renamed
 * clip is an avatar that slides everywhere without moving its legs, which
 * nobody traces back to an asset.
 */
function warnAboutMissingPieces(model: AvatarModel, url: string): void {
  const present = new Set(model.clips.map((clip) => clip.name));
  const missing = REQUIRED_AVATAR_CLIPS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    console.warn(
      `[avatar] ${url} is missing animation clips: ${missing.join(', ')}. ` +
        `Those states will fall back to idle. See assets/avatars/README.md`,
    );
  }

  const materials = new Set<string>();
  model.source.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material?.name) materials.add(material.name);
    }
  });
  const missingMaterials = Object.keys(MATERIAL_SLOT).filter((name) => !materials.has(name));
  if (missingMaterials.length > 0) {
    console.warn(
      `[avatar] ${url} has no ${missingMaterials.join(', ')} material(s); ` +
        `those customization slots will have no effect. See assets/avatars/README.md`,
    );
  }
}

/**
 * One participant's avatar.
 *
 * `SkeletonUtils.clone` rather than `Object3D.clone`: the current asset has no
 * `SkinnedMesh`, where the two agree, but a VRM does — and there the plain
 * clone shares the skeleton, so every avatar in the room animates as one. The
 * cost of being right ahead of time is a function name.
 */
export function createAvatarInstance(
  model: AvatarModel,
  appearance: AvatarAppearance,
): AvatarInstance {
  const root = cloneSkeleton(model.source) as THREE.Group;

  const materials = new Map<AvatarColorSlot | 'Detail', THREE.MeshStandardMaterial>();
  const bodyParts: AvatarInstance['bodyParts'] = [];
  const accessories = new Map<string, THREE.Object3D[]>();
  for (const id of AVATAR_ACCESSORIES) accessories.set(id, []);

  root.traverse((object) => {
    if (object.name.startsWith('BODY_')) {
      bodyParts.push({ node: object, baseScale: object.scale.clone() });
    }

    // `ACC_cap_peak` belongs to `cap`: the longest matching id wins, so a
    // multi-node accessory is toggled as one piece.
    for (const id of AVATAR_ACCESSORIES) {
      if (object.name === `ACC_${id}` || object.name.startsWith(`ACC_${id}_`)) {
        accessories.get(id)!.push(object);
      }
    }

    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // Deliberately not `receiveShadow`. Self-shadowing a figure made of boxes
    // buys shadow acne on every seam and nothing else at this size.

    const source = mesh.material as THREE.MeshStandardMaterial;
    const slot = MATERIAL_SLOT[source.name] ?? 'Detail';
    let material = materials.get(slot);
    if (!material) {
      material = source.clone();
      material.name = source.name;
      materials.set(slot, material);
    }
    mesh.material = material;
  });

  const instance: AvatarInstance = {
    root,
    clips: model.clips,
    materials,
    bodyParts,
    accessories,
  };
  applyAppearance(instance, appearance);
  return instance;
}

/**
 * FR-4.6, FR-4.7 — a live appearance change.
 *
 * Mutates the instance in place rather than rebuilding it. An instant swap is
 * permitted, but disposing and recreating a clone mid-frame drops the animation
 * mixer's state with it, so the avatar would restart its walk cycle every time
 * somebody moved a colour slider.
 */
export function applyAppearance(instance: AvatarInstance, appearance: AvatarAppearance): void {
  for (const slot of COLOR_SLOTS) {
    const material = instance.materials.get(slot);
    if (!material) continue;
    material.color.set(colorFor(slot, appearance.colors[slot]));
  }

  const [scaleX, scaleZ] = BUILD_SCALE[appearance.baseModel] ?? BUILD_SCALE.standard;
  for (const { node, baseScale } of instance.bodyParts) {
    node.scale.set(baseScale.x * scaleX, baseScale.y, baseScale.z * scaleZ);
  }

  const worn = new Set(appearance.accessories);
  for (const [id, nodes] of instance.accessories) {
    for (const node of nodes) node.visible = worn.has(id as never);
  }
}

/** The colour a nameplate, presence dot or emote burst should use for someone —
 *  their shirt, so the HUD and the world agree about who is who. */
export function accentColorFor(appearance: AvatarAppearance): string {
  return colorFor('top', appearance.colors.top);
}

/** Every palette, for the customizer. Re-exported so the UI has one import for
 *  the whole avatar vocabulary. */
export const PALETTES = AVATAR_PALETTES;

/**
 * NFR-14 — release one participant's avatar.
 *
 * Materials only. The geometry is shared with every other instance and with the
 * source; disposing it here blanks the entire room, which is a bug that looks
 * like a driver problem.
 */
export function disposeAvatarInstance(instance: AvatarInstance): void {
  for (const material of instance.materials.values()) material.dispose();
  instance.materials.clear();
}

/**
 * Claim the shared model on behalf of one loaded world.
 *
 * Called by `loadWorld` once the world it is building has actually succeeded,
 * so a load that fails on a later step leaves no claim behind. Paired with
 * exactly one `releaseAvatarModel` from `disposeWorld`, which is idempotent per
 * world — so the count follows worlds, not call sites.
 */
export function retainAvatarModel(): void {
  retained += 1;
}

/**
 * Release one world's claim, and free the shared model when the last one goes.
 *
 * Called when a world is torn down, by which point every instance belonging to
 * *that* world is gone. Whether every instance anywhere is gone is exactly what
 * the count answers: during a map transfer the answer is no.
 */
export function releaseAvatarModel(): void {
  // Clamped rather than asserted: an extra release is a leak of nothing,
  // whereas a negative count would keep the model alive for the session.
  retained = Math.max(0, retained - 1);
  if (retained > 0) return;

  const model = loaded;
  loaded = null;
  loading = null;
  if (!model) return;

  model.source.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material?.dispose();
    }
  });
}
