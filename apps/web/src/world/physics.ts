/**
 * Physics — Rapier, in the browser only (ADR 0005).
 *
 * The client is authoritative over its own transform (ADR 0004), so this is the
 * only place collision is resolved. The server runs no physics at all; it
 * answers spatial questions geometrically.
 *
 * FR-1.10 (blocked by geometry), FR-1.19 (gravity and ground) and FR-3.5
 * (sliding, not sticking) are configuration of Rapier's character controller
 * rather than code we write. Hand-rolling that is where the jitter FR-3.5
 * prohibits comes from.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  isCollisionNode,
  isHiddenNode,
  type ClientTuning,
  type MapDocument,
  type Zone,
} from '@hubitat/protocol';

let initialised = false;

/** WASM must finish loading before a world can exist. Belongs behind the
 *  loading screen alongside the GLB fetch (NFR-13). */
export async function initPhysics(): Promise<void> {
  if (initialised) return;
  await RAPIER.init();
  initialised = true;
}

export interface PhysicsWorld {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  colliderCount: number;
  /** Split out because the two sources fail differently: no mesh colliders means
   *  a bad GLB or a naming mistake, no zone colliders means the Map Document
   *  declares none. Debugging "I fall through the floor" needs to tell those
   *  apart. */
  zoneColliderCount: number;
}

/**
 * Build colliders from the loaded scene and from the Map Document's authored
 * volumes.
 *
 * Two sources, and both are needed. Mesh semantics come from node names, not
 * from glTF metadata: `COL_` meshes become trimesh colliders and are hidden,
 * everything else renders and does not block (specs/protocol/map-document.md).
 * Authored `collision` zones (FR-3.4) are analytic boxes and cylinders — cheaper
 * than a trimesh, and the only collision the *server* can also see, which is why
 * spawn placement (FR-3.7) can only reason about these.
 *
 * `collisionMode` selects the mesh source, not the zone source: `convention`
 * takes `COL_` meshes, `explicit` takes none and leaves the zones as the whole
 * story. Zones are always built — that is what "extending Phase 1's static
 * collision to authored volumes" means.
 *
 * Sliding (FR-3.5) is not implemented here at all; it is the character
 * controller's behaviour, configured below.
 */
export function buildPhysics(
  scene: THREE.Object3D,
  spawn: { x: number; y: number; z: number },
  tuning: ClientTuning,
  map?: Pick<MapDocument, 'zones' | 'geometry'>,
): PhysicsWorld {
  const world = new RAPIER.World({ x: 0, y: tuning.gravityMps2, z: 0 });

  let colliderCount = 0;
  scene.updateMatrixWorld(true);

  const useMeshCollision = (map?.geometry.collisionMode ?? 'convention') === 'convention';

  scene.traverse((object) => {
    if (isHiddenNode(object.name)) object.visible = false;
    if (!isCollisionNode(object.name)) return;
    if (!useMeshCollision) {
      // Still hidden: an `explicit` map does not want its collision proxies
      // rendered any more than a `convention` one does.
      object.visible = false;
      return;
    }
    if (!(object instanceof THREE.Mesh)) return;

    const trimesh = toTrimesh(object);
    if (!trimesh) return;

    world.createCollider(RAPIER.ColliderDesc.trimesh(trimesh.vertices, trimesh.indices));
    colliderCount++;
  });

  let zoneColliderCount = 0;
  for (const zone of map?.zones ?? []) {
    if (zone.type !== 'collision') continue;
    if (createZoneCollider(world, zone)) zoneColliderCount++;
  }

  const halfHeight = Math.max(0.1, tuning.avatarHeightM / 2 - tuning.avatarRadiusM);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      spawn.x,
      spawn.y + tuning.avatarHeightM / 2,
      spawn.z,
    ),
  );

  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(halfHeight, tuning.avatarRadiusM),
    body,
  );

  // The offset keeps a small gap between the character and geometry; without it
  // the controller and the solver fight over contacts and the avatar shivers.
  const controller = world.createCharacterController(0.02);
  controller.setSlideEnabled(true);
  controller.setMaxSlopeClimbAngle((tuning.characterSlopeLimitDeg * Math.PI) / 180);
  // Step offset lets the avatar clear thresholds without jumping. Too low and
  // it snags on door frames; too high and it walks up walls.
  controller.enableAutostep(tuning.characterStepOffsetM, tuning.avatarRadiusM * 0.5, true);
  controller.enableSnapToGround(tuning.characterSnapToGroundM);
  controller.setApplyImpulsesToDynamicBodies(false);

  return {
    world,
    body,
    collider,
    controller,
    colliderCount,
    zoneColliderCount,
  };
}

/**
 * FR-3.4 — an authored volume as a static collider.
 *
 * Analytic shapes, not trimeshes: a box is six planes to the solver rather than
 * twelve triangles, and the character controller's sliding behaves better
 * against them. Only `box` and `cylinder` exist in the schema, so the switch is
 * total.
 */
function createZoneCollider(world: RAPIER.World, zone: Zone): boolean {
  const volume = zone.volume;

  if (volume.shape === 'cylinder') {
    const desc = RAPIER.ColliderDesc.cylinder(volume.height / 2, volume.radius).setTranslation(
      volume.center.x,
      volume.center.y,
      volume.center.z,
    );
    world.createCollider(desc);
    return true;
  }

  const desc = RAPIER.ColliderDesc.cuboid(
    volume.size.x / 2,
    volume.size.y / 2,
    volume.size.z / 2,
  ).setTranslation(volume.center.x, volume.center.y, volume.center.z);

  // Yaw only — volumes are authored upright, so a full quaternion would be three
  // components of zero and one opportunity to get the order wrong.
  if (volume.yaw !== 0) {
    const half = volume.yaw / 2;
    desc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
  }

  world.createCollider(desc);
  return true;
}

function toTrimesh(mesh: THREE.Mesh): { vertices: Float32Array; indices: Uint32Array } | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return null;

  // World space: node transforms carry the layout, and Rapier colliders here are
  // created without a parent body, so they must already be positioned.
  const vertices = new Float32Array(position.count * 3);
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    vertices[i * 3] = vertex.x;
    vertices[i * 3 + 1] = vertex.y;
    vertices[i * 3 + 2] = vertex.z;
  }

  const index = geometry.getIndex();
  const indices = index
    ? Uint32Array.from(index.array)
    : Uint32Array.from({ length: position.count }, (_, i) => i);

  return { vertices, indices };
}

/**
 * Camera collision.
 *
 * Without this, orbiting near a wall puts the camera outside the room and the
 * player sees through the world. Cast from the target toward the desired
 * position and pull in to just before any hit.
 */
export function clampCameraDistance(
  world: RAPIER.World,
  target: THREE.Vector3,
  direction: THREE.Vector3,
  desired: number,
  characterCollider: RAPIER.Collider,
): number {
  const ray = new RAPIER.Ray(
    { x: target.x, y: target.y, z: target.z },
    { x: direction.x, y: direction.y, z: direction.z },
  );

  const hit = world.castRay(ray, desired, true, undefined, undefined, characterCollider);
  if (!hit) return desired;

  // Stop short of the surface so the near plane does not clip into it.
  return Math.max(0.6, hit.timeOfImpact - 0.25);
}

export { RAPIER };
