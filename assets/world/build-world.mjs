/**
 * Generates the starter worlds: assets/world/office.glb and assets/world/atrium.glb
 *
 * FR-1.18 requires loading a static world "authored outside this phase", and
 * says nothing about where it comes from. The plan called for assembling one
 * from a CC0 kit (Kenney / Quaternius); this generator stands in for that,
 * because it produces a real glTF 2.0 binary and therefore exercises the actual
 * GLTFLoader path, collider construction and node-naming convention — which is
 * the whole reason for not building the world from Three.js primitives in code.
 *
 * Swapping in a modelled GLB later is a file replacement, not a code change, as
 * long as it follows the naming convention in specs/protocol/map-document.md:
 *
 *   COL_*    collision geometry — becomes a trimesh collider, never rendered
 *   SPAWN_*  spawn marker — an authoring aid; the Map Document stays authoritative
 *   (none)   ordinary visual geometry
 *
 * Everything here is a box, so each solid emits a visible node and a COL_ node
 * sharing one unit-cube mesh, positioned by node TRS. In a modelled world the
 * COL_ meshes would be simplified boxes around detailed visual geometry — the
 * point of the convention is exactly that they can differ.
 *
 * ── Two worlds, from phase 8 ────────────────────────────────────────────────
 *
 * A Space holds several Maps connected by portals (`FR-8.1`, `FR-8.5`), and a
 * deployment that shipped with one would make `AC-8.1` — walk through a portal
 * into another Map — something an operator had to author before they could see
 * it work. So the starter catalogue is two rooms with a door each way: an office
 * and an atrium. `MapRegistry` seeds a Map per `*.map.json` found here.
 *
 * Run:  node assets/world/build-world.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Materials
//
// Shared by both worlds so one cube mesh per material serves everything. Units
// are metres and the world is Y-up, per specs/conventions/coordinates-and-units.md.
// A 1.7 m avatar should read correctly against every dimension here.
// ─────────────────────────────────────────────────────────────────────────────

const MATERIAL = { FLOOR: 0, WALL: 1, DESK: 2, PARTITION: 3, PLANTER: 4 };

const MATERIALS = [
  pbr('Floor', [0.42, 0.44, 0.47, 1], 0.9),
  pbr('Wall', [0.88, 0.87, 0.84, 1], 0.95),
  pbr('Desk', [0.55, 0.38, 0.24, 1], 0.7),
  pbr('Partition', [0.62, 0.72, 0.78, 1], 0.35),
  pbr('Planter', [0.36, 0.55, 0.35, 1], 0.8),
];

// ─────────────────────────────────────────────────────────────────────────────
// Layouts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 24 x 16 m office, 3 m ceiling, with a meeting room in the north-west corner.
 *
 * Unchanged from phase 1 apart from the doorway to the atrium, which is a portal
 * volume in the Map Document rather than geometry — a portal is a rule, and the
 * arch beside it is decoration.
 */
const OFFICE = [
  { name: 'Floor', center: [0, -0.1, 0], size: [24.4, 0.2, 16.4], material: MATERIAL.FLOOR, collides: true },

  { name: 'Wall_North', center: [0, 1.5, -8.1], size: [24.4, 3, 0.2], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_South', center: [0, 1.5, 8.1], size: [24.4, 3, 0.2], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_West', center: [-12.1, 1.5, 0], size: [0.2, 3, 16.4], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_East', center: [12.1, 1.5, 0], size: [0.2, 3, 16.4], material: MATERIAL.WALL, collides: true },

  // Meeting room. The gap between Partition_B's east end (x = -6.9) and
  // Partition_A (x = -5) is the doorway — 1.9 m, comfortably over the 1.0 m
  // clearance the authoring guidance asks for.
  { name: 'Partition_A', center: [-5, 1.5, -5.5], size: [0.2, 3, 5.2], material: MATERIAL.PARTITION, collides: true },
  { name: 'Partition_B', center: [-9.5, 1.5, -2.9], size: [5.2, 3, 0.2], material: MATERIAL.PARTITION, collides: true },

  { name: 'Pillar', center: [0, 1.5, 0], size: [0.6, 3, 0.6], material: MATERIAL.WALL, collides: true },

  { name: 'Desk_1', center: [3, 0.375, -3], size: [1.6, 0.75, 0.8], material: MATERIAL.DESK, collides: true },
  { name: 'Desk_2', center: [6, 0.375, -3], size: [1.6, 0.75, 0.8], material: MATERIAL.DESK, collides: true },
  { name: 'Desk_3', center: [3, 0.375, 1], size: [1.6, 0.75, 0.8], material: MATERIAL.DESK, collides: true },
  { name: 'Desk_4', center: [6, 0.375, 1], size: [1.6, 0.75, 0.8], material: MATERIAL.DESK, collides: true },
  { name: 'Table_Meeting', center: [-8.5, 0.375, -5.5], size: [3, 0.75, 1.4], material: MATERIAL.DESK, collides: true },

  // The doorway to the atrium (phase 8). An arch rather than a gap in the wall:
  // the wall it sits in is solid, and the portal volume in front of it is what
  // actually moves anybody. Making the geometry a hole would let somebody walk
  // "through" it into nothing when the destination map is archived.
  { name: 'Arch_West_Left', center: [-11.6, 1.5, 4.0], size: [0.8, 3, 0.3], material: MATERIAL.PARTITION, collides: false },
  { name: 'Arch_West_Right', center: [-11.6, 1.5, 6.0], size: [0.8, 3, 0.3], material: MATERIAL.PARTITION, collides: false },
  { name: 'Arch_West_Top', center: [-11.6, 2.85, 5.0], size: [0.8, 0.3, 2.3], material: MATERIAL.PARTITION, collides: false },
];

const OFFICE_SPAWNS = [
  { name: 'SPAWN_main', position: [0, 0, 5] },
  { name: 'SPAWN_east', position: [8, 0, 5] },
  { name: 'SPAWN_from-atrium', position: [-9.5, 0, 5] },
];

/**
 * A 20 x 20 m atrium, 5 m ceiling, with a planted island in the middle.
 *
 * Deliberately a different shape and a different height from the office: two
 * Maps that looked alike would make `FR-8.10`'s "which copy of which room am I
 * in" harder to reason about while testing, and a portal that appears to do
 * nothing is the failure this map exists to make visible.
 */
const ATRIUM = [
  { name: 'Floor', center: [0, -0.1, 0], size: [20.4, 0.2, 20.4], material: MATERIAL.FLOOR, collides: true },

  { name: 'Wall_North', center: [0, 2.5, -10.1], size: [20.4, 5, 0.2], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_South', center: [0, 2.5, 10.1], size: [20.4, 5, 0.2], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_West', center: [-10.1, 2.5, 0], size: [0.2, 5, 20.4], material: MATERIAL.WALL, collides: true },
  { name: 'Wall_East', center: [10.1, 2.5, 0], size: [0.2, 5, 20.4], material: MATERIAL.WALL, collides: true },

  // The planted island. Four low planters around a raised bed — something to
  // walk around, so collision is doing visible work in this map too.
  { name: 'Planter_N', center: [0, 0.3, -2.2], size: [4.4, 0.6, 0.6], material: MATERIAL.PLANTER, collides: true },
  { name: 'Planter_S', center: [0, 0.3, 2.2], size: [4.4, 0.6, 0.6], material: MATERIAL.PLANTER, collides: true },
  { name: 'Planter_W', center: [-2.2, 0.3, 0], size: [0.6, 0.6, 4.4], material: MATERIAL.PLANTER, collides: true },
  { name: 'Planter_E', center: [2.2, 0.3, 0], size: [0.6, 0.6, 4.4], material: MATERIAL.PLANTER, collides: true },
  { name: 'Tree_Trunk', center: [0, 1.6, 0], size: [0.5, 3.2, 0.5], material: MATERIAL.DESK, collides: true },
  { name: 'Tree_Canopy', center: [0, 3.6, 0], size: [3.6, 1.2, 3.6], material: MATERIAL.PLANTER, collides: false },

  // Benches along the north wall.
  { name: 'Bench_1', center: [-6, 0.22, -8.2], size: [2.4, 0.45, 0.6], material: MATERIAL.DESK, collides: true },
  { name: 'Bench_2', center: [6, 0.22, -8.2], size: [2.4, 0.45, 0.6], material: MATERIAL.DESK, collides: true },

  // The doorway back to the office, mirrored from the arch on the other side.
  { name: 'Arch_East_Left', center: [9.6, 2, -1.0], size: [0.8, 4, 0.3], material: MATERIAL.PARTITION, collides: false },
  { name: 'Arch_East_Right', center: [9.6, 2, 1.0], size: [0.8, 4, 0.3], material: MATERIAL.PARTITION, collides: false },
  { name: 'Arch_East_Top', center: [9.6, 3.85, 0], size: [0.8, 0.3, 2.3], material: MATERIAL.PARTITION, collides: false },
];

const ATRIUM_SPAWNS = [
  { name: 'SPAWN_main', position: [0, 0, 6] },
  { name: 'SPAWN_from-office', position: [7.5, 0, 0] },
];

const WORLDS = [
  { id: 'office', solids: OFFICE, spawns: OFFICE_SPAWNS },
  { id: 'atrium', solids: ATRIUM, spawns: ATRIUM_SPAWNS },
];

// ─────────────────────────────────────────────────────────────────────────────
// Unit cube geometry
//
// 24 vertices rather than 8: flat shading needs a distinct normal per face, and
// sharing corner vertices would average them into something round-looking.
// ─────────────────────────────────────────────────────────────────────────────

function unitCube() {
  const faces = [
    { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { normal: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];

  const positions = [];
  const normals = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    const base = faceIndex * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return { positions, normals, indices };
}

function pbr(name, baseColorFactor, roughnessFactor) {
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0.0, roughnessFactor },
    doubleSided: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// glTF assembly
//
// One function per world rather than one global document, because phase 8 needs
// several: sharing mutable module state between two builds is how the second
// world ends up containing the first one's nodes.
// ─────────────────────────────────────────────────────────────────────────────

function buildGlb(solids, spawnMarkers) {
  const cube = unitCube();

  const positionBytes = Float32Array.from(cube.positions);
  const normalBytes = Float32Array.from(cube.normals);
  const indexBytes = Uint16Array.from(cube.indices);

  const chunks = [];
  let offset = 0;

  function append(typedArray) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const start = offset;
    chunks.push(bytes);
    offset += bytes.byteLength;
    // Every bufferView must start on a 4-byte boundary, or accessors of 4-byte
    // components read misaligned data.
    const padding = (4 - (offset % 4)) % 4;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      offset += padding;
    }
    return { byteOffset: start, byteLength: bytes.byteLength };
  }

  const positionView = append(positionBytes);
  const normalView = append(normalBytes);
  const indexView = append(indexBytes);

  const binary = new Uint8Array(offset);
  {
    let cursor = 0;
    for (const chunk of chunks) {
      binary.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
  }

  const gltf = {
    asset: { version: '2.0', generator: 'hubitat build-world.mjs' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: MATERIALS.map((material) => ({ ...material })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: positionBytes.length / 3,
        type: 'VEC3',
        // Required by the spec for POSITION, and loaders use it for bounds.
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, componentType: 5126, count: normalBytes.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indexBytes.length, type: 'SCALAR' }, // UNSIGNED_SHORT
    ],
    bufferViews: [
      { buffer: 0, byteOffset: positionView.byteOffset, byteLength: positionView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: normalView.byteOffset, byteLength: normalView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexView.byteOffset, byteLength: indexView.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
  };

  // One mesh per material, all sharing the single cube's accessors. Geometry is
  // instanced by node transform, which keeps the file tiny.
  for (let materialIndex = 0; materialIndex < gltf.materials.length; materialIndex++) {
    gltf.meshes.push({
      name: `Cube_${gltf.materials[materialIndex].name}`,
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: materialIndex,
        },
      ],
    });
  }

  function addNode(node) {
    gltf.nodes.push(node);
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }

  for (const solid of solids) {
    addNode({
      name: solid.name,
      mesh: solid.material,
      translation: solid.center,
      scale: solid.size,
    });

    if (solid.collides) {
      // Same geometry, different name. The COL_ prefix is what makes the runtime
      // turn it into a collider and keep it out of the render.
      addNode({
        name: `COL_${solid.name}`,
        mesh: solid.material,
        translation: solid.center,
        scale: solid.size,
      });
    }
  }

  for (const marker of spawnMarkers) {
    // No mesh: an empty node carrying only a transform.
    addNode({ name: marker.name, translation: marker.position });
  }

  return packGlb(gltf, binary);
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB container
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function padTo4(bytes, padByte) {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.byteLength + (4 - remainder));
  padded.set(bytes);
  padded.fill(padByte, bytes.byteLength);
  return padded;
}

function packGlb(gltf, binary) {
  // JSON pads with spaces, BIN pads with zeros — required by the GLB spec.
  const jsonChunk = padTo4(encoder.encode(JSON.stringify(gltf)), 0x20);
  const binChunk = padTo4(binary, 0x00);

  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);

  let cursor = 0;
  view.setUint32(cursor, 0x46546c67, true); // 'glTF'
  view.setUint32(cursor + 4, 2, true);
  view.setUint32(cursor + 8, totalLength, true);
  cursor += 12;

  view.setUint32(cursor, jsonChunk.byteLength, true);
  view.setUint32(cursor + 4, 0x4e4f534a, true); // 'JSON'
  cursor += 8;
  glb.set(jsonChunk, cursor);
  cursor += jsonChunk.byteLength;

  view.setUint32(cursor, binChunk.byteLength, true);
  view.setUint32(cursor + 4, 0x004e4942, true); // 'BIN\0'
  cursor += 8;
  glb.set(binChunk, cursor);

  return { glb, gltf };
}

for (const world of WORLDS) {
  const { glb, gltf } = buildGlb(world.solids, world.spawns);
  const outPath = join(OUT_DIR, `${world.id}.glb`);
  writeFileSync(outPath, glb);

  const collisionNodes = gltf.nodes.filter((n) => n.name.startsWith('COL_')).length;
  console.log(
    `Wrote ${outPath}\n` +
      `  ${(glb.byteLength / 1024).toFixed(1)} KB · ${gltf.nodes.length} nodes ` +
      `(${collisionNodes} collision, ${world.spawns.length} spawn markers) · ` +
      `${gltf.meshes.length} meshes sharing one cube`,
  );
}
