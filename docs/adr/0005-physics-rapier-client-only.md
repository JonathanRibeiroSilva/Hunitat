# ADR 0005 — Physics: Rapier WASM on the client only

**Status:** accepted · **Affects:** phases 1, 3, 9

## Context

`FR-1.10` requires participants to be stopped by static geometry, `FR-1.19` requires gravity and
ground constraints, and `FR-3.5` requires collision response to be smooth — _"a participant
slides along/stops at a surface rather than getting stuck or jittering"_.

Sliding along a wall instead of sticking to it is the part people underestimate. A naive
"if colliding, don't move" check produces exactly the jitter the spec forbids. Doing it properly
means a character controller that decomposes movement against the contact normal, handles step
offsets and slope limits, and does depenetration.

[ADR 0004](0004-client-authoritative-movement-aoi.md) established that the client owns its own
transform, so only one side needs to answer these questions.

## Decision

**Rapier** (`@dimforge/rapier3d-compat`, Rust compiled to WASM) **in the browser only.** No
physics engine on the server.

Movement uses Rapier's built-in `KinematicCharacterController`, which provides sliding, step
offset, slope limit and snap-to-ground directly. `FR-1.10`, `FR-1.19` and `FR-3.5` are
configuration of that controller rather than code we write.

Colliders are built from the loaded Map Document: a trimesh from geometry nodes named by the
collision convention, and cuboids/cylinders from Phase 3 authored collision volumes.

The server answers spatial questions **geometrically, not physically** — point-in-volume tests
for zone occupancy and distance checks for area of interest, both plain maths in `world-core`.

The `-compat` build is chosen because it inlines the WASM, avoiding a separate asset fetch and
the bundler configuration that goes with it.

## Consequences

- One physics implementation to tune, in one place. No risk of client and server disagreeing
  about whether someone is inside a wall.
- Rapier's WASM must initialise (`await RAPIER.init()`) before the world is interactive. This
  belongs in the loading screen, alongside the GLB fetch — see
  [phase-01-screens.md](../../specs/ux/phase-01-screens.md).
- Collider construction from a trimesh is the expensive part of map loading. It happens once,
  and shows in the loading state.
- **`-compat` costs bundle size.** Base64-inlining the WASM inflates it by roughly a third: the
  Rapier chunk measures 2.06 MB raw, 761 KB gzipped, which is larger than Three.js. It is a
  separate chunk and cached across deploys, so it is a first-load cost only, and on the internal
  network this deployment targets that is acceptable. If it ever isn't, the escape is the plain
  `@dimforge/rapier3d` package with `vite-plugin-wasm`, which ships a real `.wasm` file — smaller,
  at the price of the bundler configuration this decision set out to avoid.
- The Phase 9 editor gets collision preview for free by building the same colliders from the
  draft document.
- A tampered client can disable its own collision. Inherited from
  [0004](0004-client-authoritative-movement-aoi.md), not a new exposure.
- If movement ever becomes server-authoritative, Rapier runs in Node too — the `-compat` build
  works there. `world-core` must therefore keep the controller free of DOM APIs so it can move
  without a rewrite.

## Alternatives rejected

- **Rapier on both client and server** — the natural pairing with server authority, and the
  right choice if [0004](0004-client-authoritative-movement-aoi.md) is ever reversed. Rejected
  now as work with no benefit under a trusting model.
- **cannon-es / ammo.js** — pure JS or older Emscripten builds; slower, and neither ships a
  character controller of Rapier's quality. Sliding would be ours to write.
- **Hand-rolled capsule-vs-trimesh collision** — tempting because the world is simple, and a
  trap: step offsets, slope limits and depenetration are exactly where hand-rolled controllers
  produce the jitter `FR-3.5` prohibits.
- **Three.js `Octree` with a sphere collider** (from the examples) — genuinely lightweight and
  enough for a flat floor, but it does not survive authored collision volumes and slopes in
  Phase 3.
