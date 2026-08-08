# Architecture Decision Records

The [specification index](../../specs/README.md) is deliberately technology-neutral and defers
every technology choice to this directory:

> When a decision is made, record it as a short Architecture Decision entry and link it from
> the affected phase(s). Specs stay technology-neutral; decisions live here.

These are those entries. Each one states the context, the decision, the consequences we accept,
and the alternatives we rejected. The specs remain the authority on _behavior_; these records
are the authority on _how we build it_.

For the narrative that stitches them together, see [architecture.md](../architecture.md).

## Index

| ADR                                               | Title                                                                                 | Affects phases |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| [0001](0001-monorepo-turborepo-npm.md)            | TypeScript monorepo with Turborepo and npm workspaces                                 | all            |
| [0002](0002-client-threejs-r3f-vite.md)           | 3D client: Three.js + React Three Fiber on Vite; UI in Tailwind + shadcn/ui           | 1, 4, 9, 10    |
| [0003](0003-transport-native-websocket.md)        | Transport: native WebSocket (`ws`) inside NestJS with a custom binary protocol        | 1, 3, 5, 10    |
| [0004](0004-client-authoritative-movement-aoi.md) | Client-authoritative movement; area of interest via spatial grid with hysteresis      | 1, 3, 7        |
| [0005](0005-physics-rapier-client-only.md)        | Physics: Rapier WASM on the client only                                               | 1, 3, 9        |
| [0006](0006-media-livekit-sfu.md)                 | Media: self-hosted LiveKit SFU with selective subscription                            | 2, 3, 7, 8     |
| [0007](0007-spatial-audio-web-audio.md)           | Spatial audio in the client via Web Audio `PannerNode`                                | 2, 3, 4        |
| [0008](0008-persistence-postgres-typeorm.md)      | Persistence: PostgreSQL + TypeORM, `jsonb` for the Map Document, versioned migrations | 5–10           |
| [0009](0009-no-redis-in-memory-pgboss.md)         | No Redis: live state in memory, pg-boss job queue, worker outside the tick process    | 1, 4, 8, 9     |
| [0010](0010-3d-formats-gltf-vrm.md)               | 3D formats: glTF/GLB for worlds, VRM + Mixamo for avatars, MinIO + gltf-transform     | 1, 4, 9        |
| [0011](0011-auth-local-accounts.md)               | Authentication: local accounts, argon2id, JWT + rotated refresh cookie (no SSO)       | 6, 7           |
| [0012](0012-collaborative-state-yjs.md)           | Collaborative state: Yjs (CRDT) for whiteboards, notes and synchronized video         | 10             |

## Deferred decisions, resolved

The six items the spec index left open map onto these records:

| Deferred item                                       | Resolved by                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Realtime transport & networking topology            | [0003](0003-transport-native-websocket.md), [0004](0004-client-authoritative-movement-aoi.md)                                    |
| Media routing approach for voice/video at scale     | [0006](0006-media-livekit-sfu.md), [0007](0007-spatial-audio-web-audio.md)                                                       |
| 3D rendering approach on the client                 | [0002](0002-client-threejs-r3f-vite.md), [0005](0005-physics-rapier-client-only.md)                                              |
| 3D asset & avatar formats / standards               | [0010](0010-3d-formats-gltf-vrm.md)                                                                                              |
| Storage technologies (durable + live session state) | [0008](0008-persistence-postgres-typeorm.md), [0009](0009-no-redis-in-memory-pgboss.md), [0012](0012-collaborative-state-yjs.md) |
| Hosting / deployment model                          | [0001](0001-monorepo-turborepo-npm.md), [0009](0009-no-redis-in-memory-pgboss.md)                                                |

Phase 7 defers three more of its own — how enforcement is implemented authoritatively, how bans key
off identity, and where the audit log lives. All three are settled in
[0013](0013-roles-capabilities-and-audit.md).

## Project parameters these decisions were made against

Changing any of these invalidates several records at once:

- **Deployment context** — internal company tool, self-hosted.
- **Scale target** — ~50 concurrent participants in one world.
- **Topology** — a single NestJS process serving REST, WebSocket and the world tick.
