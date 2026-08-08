# ADR 0010 — 3D formats: glTF/GLB for worlds, VRM + Mixamo for avatars, MinIO + gltf-transform

**Status:** accepted · **Affects:** phases 1, 4, 9

## Context

Three asset problems, related but not identical.

**Worlds.** `FR-1.18` loads a static world with geometry and collision surfaces, authored
outside the phase. Phase 9 then lets users upload their own, with `FR-9.12` demanding validation
and `FR-9.13` demanding level-of-detail treatment so large scenes stay performant.

**Avatars.** Phase 4 wants animated, customizable humanoids: idle/walk/run states with smooth
transitions (`FR-4.2`, `FR-4.3`), appearance customization (`FR-4.5`), and facing precise enough
to drive directional audio (`FR-4.4`). Rigging and animating humanoids from scratch is a
specialist job this project cannot absorb.

**Storage.** Uploaded models and textures are large binaries that must not live in the database.

## Decision

**glTF 2.0 / GLB** for worlds and props. Three.js loads it natively via `GLTFLoader`; it carries
meshes, materials, textures and node hierarchy in one binary file.

**VRM** for avatars, via `@pixiv/three-vrm`. VRM is an open standard layered on glTF that
specifies a fixed humanoid bone hierarchy — which is precisely what makes retargeting possible.
Free avatars exist in quantity, and **VRoid Studio** lets non-artists create them.

**Mixamo** FBX animations retargeted onto the VRM humanoid rig. Because VRM standardises the
bone names, one animation set drives every avatar. Locomotion blends idle/walk/run through
`AnimationMixer` cross-fades weighted by planar speed (`FR-4.3`).

**MinIO** (S3-compatible, self-hostable) for uploaded binaries, with presigned PUT so uploads
bypass the API process entirely.

**`@gltf-transform/core` and `/functions`** for the Phase 9 pipeline: parse-and-validate on
ingest (`FR-9.12`), then `draco` compression, `simplify` for LOD variants, and `textureCompress`
(`FR-9.13`) — all in the worker described in [0009](0009-no-redis-in-memory-pgboss.md).

**Phase 1 uses a placeholder avatar** — a capsule with a facing cone. VRM belongs to Phase 4,
and Phase 1 is about movement replication.

**The Phase 1 world** is assembled from a CC0 kit (Kenney / Quaternius) into one GLB. Node
naming carries the semantics: collision meshes and spawn points are identified by a prefix
convention documented in [map-document.md](../../specs/protocol/map-document.md). This exercises
the real GLB loading path rather than deferring it.

## Consequences

- Third-person camera ([0002](0002-client-threejs-r3f-vite.md)) means you see your own avatar,
  which is what makes Phase 4's customization and emotes worth building.
- **Mixamo→VRM retargeting is not automatic.** Mixamo rigs use their own bone names and a
  different rest pose; the mapping and hip-height scaling must be written once and documented.
  This is the known sharp edge of Phase 4 and it is better to hit it deliberately.
- Draco decoding needs a decoder in the client. `GLTFLoader` supports it, but the decoder path
  must be configured or Phase 9's compressed output silently fails to load.
- glTF carries no notion of "this mesh is collision". The naming convention is load-bearing: get
  it wrong and either the world has no collision or invisible geometry renders.
- MinIO is another service, but it is the S3 API, so moving to real S3 later is a config change.
- VRM's humanoid constraint limits avatars to bipeds. Acceptable for a virtual office.
- Uploaded assets are untrusted input parsed by a library. Parsing happens in the isolated
  worker process, which is a second reason for the isolation
  [0009](0009-no-redis-in-memory-pgboss.md) requires.

## Alternatives rejected

- **FBX for everything** — universal in DCC tools, but proprietary, larger, and poorly suited to
  the web. glTF was designed for this transport.
- **Ready Player Me avatars** — excellent quality and a hosted creator, and a hosted third-party
  dependency, which guiding principle nº1 forbids.
- **Custom glTF avatars with a bespoke rig** — full control of the company's visual identity,
  and it requires a 3D artist plus a customization system built from nothing.
- **Storing assets in PostgreSQL as `bytea`** — one less service, and it bloats the database,
  its backups, and every dump.
- **Building the Phase 1 world from Three.js primitives in code** — fastest route to two
  browsers seeing each other, and it skips the GLB loading path `FR-1.18` actually specifies and
  Phase 9 depends on.
