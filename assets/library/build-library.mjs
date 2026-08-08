/**
 * Generates the built-in asset library: assets/library/*.glb
 *
 * `FR-9.15` requires that "a default/built-in asset set is available so a Map can
 * be built without any uploads", and the only way that is true on a server with
 * **no object storage configured** is for the default set to be files in the
 * repository. So these are generated here, committed, served statically beside
 * the world GLBs, and seeded as `built_in` rows by `AssetService`.
 *
 * ── Why generated rather than modelled ──────────────────────────────────────
 *
 * The same reason `build-world.mjs` generates the starter worlds: it produces a
 * real glTF 2.0 binary, so it exercises the actual `GLTFLoader` path, the actual
 * node-naming convention and the actual asset pipeline. Swapping in modelled
 * props later is a file replacement, not a code change.
 *
 * Everything here is boxes. A prop is a list of them in its own local space,
 * origin at the floor and centred on the ground plane, so a placed object's
 * transform means what an author expects: the position is where it stands, not
 * where its middle is.
 *
 * Run:  node assets/library/build-library.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Palette
//
// Shared across every prop so a room built from the library looks like one room
// rather than a colour test. Indices are into `MATERIALS` below.
// ─────────────────────────────────────────────────────────────────────────────

const MATERIALS = [
  pbr('Wood', [0.55, 0.38, 0.24, 1], 0.7),
  pbr('Fabric', [0.32, 0.38, 0.52, 1], 0.95),
  pbr('Metal', [0.62, 0.65, 0.7, 1], 0.35),
  pbr('Foliage', [0.32, 0.52, 0.31, 1], 0.85),
  pbr('Screen', [0.09, 0.1, 0.12, 1], 0.2),
  pbr('Stone', [0.72, 0.71, 0.68, 1], 0.9),
];

const WOOD = 0;
const FABRIC = 1;
const METAL = 2;
const FOLIAGE = 3;
const SCREEN = 4;
const STONE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// The props
//
// `center` is relative to the prop's own origin, which sits on the floor. Sizes
// are metres and read correctly against a 1.7 m avatar
// (specs/conventions/coordinates-and-units.md).
// ─────────────────────────────────────────────────────────────────────────────

const PROPS = {
  desk: [
    { name: 'Top', center: [0, 0.73, 0], size: [1.6, 0.06, 0.8], material: WOOD },
    { name: 'Leg_A', center: [-0.72, 0.35, -0.32], size: [0.08, 0.7, 0.08], material: METAL },
    { name: 'Leg_B', center: [0.72, 0.35, -0.32], size: [0.08, 0.7, 0.08], material: METAL },
    { name: 'Leg_C', center: [-0.72, 0.35, 0.32], size: [0.08, 0.7, 0.08], material: METAL },
    { name: 'Leg_D', center: [0.72, 0.35, 0.32], size: [0.08, 0.7, 0.08], material: METAL },
  ],

  chair: [
    { name: 'Seat', center: [0, 0.45, 0], size: [0.46, 0.07, 0.46], material: FABRIC },
    { name: 'Back', center: [0, 0.75, -0.2], size: [0.46, 0.55, 0.06], material: FABRIC },
    { name: 'Post', center: [0, 0.22, 0], size: [0.08, 0.45, 0.08], material: METAL },
    { name: 'Base', center: [0, 0.03, 0], size: [0.44, 0.06, 0.44], material: METAL },
  ],

  'round-table': [
    { name: 'Top', center: [0, 0.72, 0], size: [1.1, 0.06, 1.1], material: WOOD },
    { name: 'Post', center: [0, 0.36, 0], size: [0.12, 0.72, 0.12], material: METAL },
    { name: 'Base', center: [0, 0.03, 0], size: [0.6, 0.06, 0.6], material: METAL },
  ],

  sofa: [
    { name: 'Seat', center: [0, 0.38, 0], size: [1.9, 0.24, 0.85], material: FABRIC },
    { name: 'Back', center: [0, 0.66, -0.34], size: [1.9, 0.56, 0.18], material: FABRIC },
    { name: 'Arm_L', center: [-0.95, 0.5, 0], size: [0.18, 0.36, 0.85], material: FABRIC },
    { name: 'Arm_R', center: [0.95, 0.5, 0], size: [0.18, 0.36, 0.85], material: FABRIC },
    { name: 'Plinth', center: [0, 0.13, 0], size: [1.86, 0.26, 0.8], material: WOOD },
  ],

  bookshelf: [
    { name: 'Side_L', center: [-0.44, 0.9, 0], size: [0.05, 1.8, 0.32], material: WOOD },
    { name: 'Side_R', center: [0.44, 0.9, 0], size: [0.05, 1.8, 0.32], material: WOOD },
    { name: 'Shelf_0', center: [0, 0.03, 0], size: [0.9, 0.05, 0.32], material: WOOD },
    { name: 'Shelf_1', center: [0, 0.48, 0], size: [0.9, 0.05, 0.32], material: WOOD },
    { name: 'Shelf_2', center: [0, 0.93, 0], size: [0.9, 0.05, 0.32], material: WOOD },
    { name: 'Shelf_3', center: [0, 1.38, 0], size: [0.9, 0.05, 0.32], material: WOOD },
    { name: 'Shelf_4', center: [0, 1.78, 0], size: [0.9, 0.05, 0.32], material: WOOD },
    { name: 'Books_1', center: [-0.12, 0.63, 0], size: [0.5, 0.26, 0.22], material: FABRIC },
    { name: 'Books_2', center: [0.16, 1.08, 0], size: [0.4, 0.26, 0.22], material: SCREEN },
  ],

  planter: [
    { name: 'Pot', center: [0, 0.22, 0], size: [0.46, 0.44, 0.46], material: STONE },
    { name: 'Stem', center: [0, 0.7, 0], size: [0.07, 0.5, 0.07], material: WOOD },
    { name: 'Leaves_A', center: [0, 1.05, 0], size: [0.8, 0.3, 0.8], material: FOLIAGE },
    { name: 'Leaves_B', center: [0.1, 1.28, -0.06], size: [0.5, 0.26, 0.5], material: FOLIAGE },
  ],

  pillar: [
    { name: 'Shaft', center: [0, 1.5, 0], size: [0.5, 3.0, 0.5], material: STONE },
    { name: 'Cap', center: [0, 2.96, 0], size: [0.7, 0.12, 0.7], material: STONE },
    { name: 'Foot', center: [0, 0.06, 0], size: [0.7, 0.12, 0.7], material: STONE },
  ],

  /** Phase 10 places content *in* objects; this is the thing that content most
   *  obviously belongs on, and it exists here so that phase has something to
   *  point at without a new asset. */
  display: [
    { name: 'Screen', center: [0, 1.5, 0], size: [1.6, 0.9, 0.06], material: SCREEN },
    { name: 'Frame', center: [0, 1.5, -0.04], size: [1.7, 1.0, 0.04], material: METAL },
    { name: 'Post', center: [0, 0.6, 0], size: [0.1, 1.2, 0.1], material: METAL },
    { name: 'Base', center: [0, 0.03, 0], size: [0.6, 0.06, 0.4], material: METAL },
  ],

  whiteboard: [
    { name: 'Board', center: [0, 1.35, 0], size: [1.8, 1.1, 0.05], material: STONE },
    { name: 'Frame', center: [0, 1.35, -0.03], size: [1.9, 1.2, 0.04], material: METAL },
    { name: 'Tray', center: [0, 0.76, 0.07], size: [1.7, 0.05, 0.12], material: METAL },
    { name: 'Leg_L', center: [-0.75, 0.38, 0], size: [0.06, 0.76, 0.06], material: METAL },
    { name: 'Leg_R', center: [0.75, 0.38, 0], size: [0.06, 0.76, 0.06], material: METAL },
  ],

  'partition-panel': [
    { name: 'Panel', center: [0, 0.85, 0], size: [1.6, 1.6, 0.08], material: FABRIC },
    { name: 'Foot_L', center: [-0.7, 0.03, 0], size: [0.2, 0.06, 0.4], material: METAL },
    { name: 'Foot_R', center: [0.7, 0.03, 0], size: [0.2, 0.06, 0.4], material: METAL },
  ],

  rug: [{ name: 'Rug', center: [0, 0.01, 0], size: [3.0, 0.02, 2.0], material: FABRIC }],

  'floor-lamp': [
    { name: 'Base', center: [0, 0.03, 0], size: [0.34, 0.06, 0.34], material: METAL },
    { name: 'Post', center: [0, 0.8, 0], size: [0.05, 1.5, 0.05], material: METAL },
    { name: 'Shade', center: [0, 1.65, 0], size: [0.4, 0.3, 0.4], material: STONE },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Unit cube — 24 vertices, so flat shading gets a normal per face
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

function buildGlb(name, boxes) {
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

  // Only the materials this prop actually uses, remapped — a library asset
  // carrying six unused materials is six extra state objects per instance for
  // nothing.
  const used = [...new Set(boxes.map((box) => box.material))].sort((a, b) => a - b);
  const remap = new Map(used.map((material, index) => [material, index]));

  const gltf = {
    asset: { version: '2.0', generator: 'hubitat build-library.mjs' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: used.map((material) => ({ ...MATERIALS[material] })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positionBytes.length / 3,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, componentType: 5126, count: normalBytes.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indexBytes.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: positionView.byteOffset, byteLength: positionView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: normalView.byteOffset, byteLength: normalView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexView.byteOffset, byteLength: indexView.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
  };

  for (const material of used) {
    gltf.meshes.push({
      name: `Cube_${MATERIALS[material].name}`,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: remap.get(material) }],
    });
  }

  for (const box of boxes) {
    gltf.nodes.push({
      name: `${name}_${box.name}`,
      mesh: remap.get(box.material),
      translation: box.center,
      scale: box.size,
    });
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }

  return packGlb(gltf, binary);
}

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

  return glb;
}

let total = 0;
for (const [name, boxes] of Object.entries(PROPS)) {
  const glb = buildGlb(name, boxes);
  writeFileSync(join(OUT_DIR, `${name}.glb`), glb);
  total += glb.byteLength;
  console.log(`  ${name}.glb — ${(glb.byteLength / 1024).toFixed(1)} KB · ${boxes.length} part(s)`);
}

console.log(
  `Wrote ${Object.keys(PROPS).length} built-in assets to ${OUT_DIR} ` +
    `(${(total / 1024).toFixed(1)} KB total)`,
);
