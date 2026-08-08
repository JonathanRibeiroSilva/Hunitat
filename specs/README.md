# 3D Spatial Collaboration Platform — Specification Index

An open-source, self-hosted, **3D** reimagining of a Gather-style virtual space:
people move avatars through shared 3D worlds and talk to whoever is near them, with
zones, chat, customizable identities, and editable maps.

These specs describe **what** to build, broken into incremental phases. They are
intentionally **technology-agnostic** — no transport protocols, engines, media
servers, databases, or libraries are named. Those choices are decided separately and
recorded later (see [Deferred Decisions](#deferred-decisions)).

> Audience: future implementers (human or AI agents). Each phase spec is meant to be
> picked up and built largely on its own, given the phases it depends on are done.

---

## Guiding principles

1. **Open source & self-hostable.** Every feature must be implementable without a
   proprietary dependency. No hard requirement on any hosted third-party service.
2. **Spatial first.** Proximity (who is near whom in 3D) drives audio, video, and
   local chat. This is the core differentiator, not a side feature.
3. **Incremental & demoable.** Each phase ends in something a user can actually do.
4. **Technology-neutral specs.** Describe behavior, data concepts, and rules — never
   the implementation tech. Implementers choose tech to satisfy the spec.

---

## Phase roadmap

| Phase | Title                                                                     | Delivers (one line)                                                     | Depends on |
| ----: | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
|     1 | [Core Realtime World & Presence](phase-01-core-realtime-world.md)         | Multiple guests move around one shared 3D world and see each other live | —          |
|     2 | [Spatial Voice & Video](phase-02-spatial-voice-video.md)                  | Hear/see people based on 3D proximity, with distance falloff            | 1          |
|     3 | [Spatial Zones & Interaction Rules](phase-03-zones-and-interaction.md)    | Collision, private zones, spotlight, portals, trigger volumes           | 1, 2       |
|     4 | [Avatars & Identity Presentation](phase-04-avatars-identity.md)           | Animated, customizable avatars with status & speaking indicators        | 1, 2       |
|     5 | [Text Chat & Messaging](phase-05-text-chat.md)                            | Room / nearby / zone / direct text chat                                 | 1, 3       |
|     6 | [Accounts, Identity & Membership](phase-06-accounts-membership.md)        | Local accounts, guests, invites, persistent profiles (no SSO)           | 1          |
|     7 | [Permissions & Moderation](phase-07-permissions-moderation.md)            | Roles, kick/ban/mute, access locks, reporting, audit                    | 2, 5, 6    |
|     8 | [Rooms, Spaces & World Management](phase-08-rooms-spaces-world-mgmt.md)   | Multi-map spaces, portals between maps, capacity & instancing           | 1, 3, 6, 7 |
|     9 | [World / Map Editor & Asset Pipeline](phase-09-world-map-editor.md)       | Author maps visually: place objects, zones, spawns, assets              | 3, 8       |
|    10 | [Interactive Objects & Embedded Content](phase-10-interactive-objects.md) | Interact with objects holding links/images/video/notes/whiteboards      | 1, 3, 9    |

### Dependency graph

```
  1 ──┬── 2 ──┬── 3 ──┬── 5 ──────────────┐
      │       │       │                   │
      │       └── 4   ├── 8 ── 9 ── 10     │
      │               │                   │
      6 ──────────────┴── 7 ──────────────┘
```

### Built so far

**All ten.** What that means in one line each is in the repository
[README](../README.md); what it means for these specs is that every `AC-1.1`–`AC-10.6` is either
covered by a harness scenario or on the manual checklist in
[`docs/testing-strategy.md`](../docs/testing-strategy.md), with the split stated there rather than
left to be inferred.

Two limits are worth stating here rather than leaving to be discovered, because both are
consequences of decisions the ADRs made rather than of anything unfinished:

- **One live Space per process.** Spaces are created, owned, archived and deleted as `FR-8.15`–
  `FR-8.17` require, but a running server serves the one named by `SPACE_SLUG`. Access policy,
  bans, roles and chat history are Space-scoped singletons resolved once at the door (phases 6 and
  7), and making them per-connection would be a rewrite of two phases to support several tenants in
  one process — which is the case [ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)
  declined when it put live state in process memory.
- **The asset pipeline produces level-of-detail variants, not compressed geometry.** `FR-9.13` is
  met with simplification and lossless cleanup; Draco and meshopt are deliberately absent, because
  both need a decoder configured on the client and the Phase 9 notes name the pipeline's own output
  silently failing to load as the sharpest edge in that phase.

### Suggested MVP

Phases **1 → 2 → 3 → 4** give the core experience: _walk through a hand-authored 3D
world and talk naturally to people near you, with animated avatars and zones._
Everything after that (chat, accounts, moderation, multi-map, editor, objects)
extends that core.

---

## Cross-cutting concerns

Two modules are not their own phase; they are established minimally in Phase 1 and
extended by later phases:

- **Persistence.** Durable storage for whatever each phase needs (profiles, maps,
  object state, history). Each phase states what it must persist; live/transient
  session state is separate from durable state.
- **Client rendering.** The 3D client that draws the world, runs the camera, reads
  input, and smooths motion. Phase 1 sets it up; later phases add to what it renders.

---

## Supporting specifications

The phase specs describe behavior. These describe the shared ground every phase stands on —
things that must be fixed once, or the phases cannot be built consistently.

| Document                                                                     | What it fixes                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [conventions/coordinates-and-units.md](conventions/coordinates-and-units.md) | Axes, units, scale, facing, precision, and the camera model (which no phase spec defines)                 |
| [conventions/tuning-defaults.md](conventions/tuning-defaults.md)             | A value for every parameter the phases call _"configurable"_                                              |
| [protocol/wire-protocol.md](protocol/wire-protocol.md)                       | Frame layouts, opcodes, connection lifecycle, security limits                                             |
| [protocol/http-api.md](protocol/http-api.md)                                 | The REST surface accounts, invites and moderation need, which does not fit on the socket (Phase 6 onward) |
| [protocol/map-document.md](protocol/map-document.md)                         | The serializable world format (`DC-9.1`), defined early because Phases 1, 3 and 10 all depend on it       |
| [nfr.md](nfr.md)                                                             | Non-functional requirements — latency, frame rate, bandwidth, browser support                             |
| [ux/phase-01-screens.md](ux/phase-01-screens.md)                             | Phase 1 screens and states, including the failure state its Rules require                                 |

## Technology stack

Chosen against a fixed context: an internal company tool, ~50 concurrent participants per world,
one server. Full reasoning in [`docs/adr/`](../docs/adr/README.md); the narrative that connects
them is [`docs/architecture.md`](../docs/architecture.md).

| Layer               | Choice                                                             |
| ------------------- | ------------------------------------------------------------------ |
| Monorepo            | Turborepo + npm workspaces, TypeScript throughout                  |
| Client              | Vite + React + Three.js / React Three Fiber, Tailwind + shadcn/ui  |
| Physics             | Rapier (WASM), client-side only                                    |
| Server              | NestJS — REST, WebSocket gateway and the world tick in one process |
| Realtime            | Native WebSocket (`ws`) with a custom binary protocol              |
| Voice & video       | LiveKit SFU, self-hosted                                           |
| Spatial audio       | Web Audio `PannerNode`, computed per listener in the browser       |
| Durable storage     | PostgreSQL + TypeORM                                               |
| Live state          | Process memory — no Redis                                          |
| Jobs                | pg-boss, with the worker in its own process                        |
| Files               | MinIO (S3-compatible)                                              |
| Formats             | glTF/GLB worlds, VRM + Mixamo avatars                              |
| Collaborative state | Yjs (CRDT)                                                         |
| Deployment          | Docker Compose                                                     |

---

## Spec conventions

Each phase file uses the same structure:

- **Overview** — goal, value, dependencies, what it delivers.
- **In / Out of scope** — explicit boundaries.
- **Functional Requirements** — `FR-<phase>.<n>`, the testable behaviors to build.
- **Data Concepts** — `DC-<phase>.<n>`, abstract entities (no schema/tech).
- **Rules & Edge Cases** — precedence, conflicts, failure handling.
- **Acceptance Criteria** — `AC-<phase>.<n>`, the definition of done.
- **Non-Goals & Deferred** — what is intentionally excluded or pushed later.

Requirement IDs are stable references; don't renumber existing ones when editing.

---

## Glossary

- **Space** — a top-level container owned by someone; holds one or more Maps and its
  members. (Formalized in Phase 8.)
- **Map / Room** — a single authored 3D world a user can be present in. Early phases
  use one hand-authored Map.
- **World Instance** — a live, running copy of a Map that participants share. A Map may
  run as multiple instances for capacity (Phase 8).
- **Participant / Player** — a user currently present in a World Instance.
- **Session** — one connected client's live link to a World Instance.
- **Proximity** — 3D nearness between participants; the basis for spatial media and
  local chat.
- **Area of Interest (AOI)** — the region around a participant whose entities/events
  they actually receive; used to avoid sending everyone everything.
- **Zone** — an authored region of a Map with special rules (collision, private,
  spotlight, portal, trigger).
- **Avatar** — the visible 3D representation of a participant.

---

## Out of scope for the whole project (for now)

These were explicitly deferred during planning and appear in **no** phase:

- **Single sign-on (SSO) / external identity providers / social login.** Phase 6 covers
  only local accounts and guests.
- **Generic embedded-app framework** (sandboxed third-party apps and a host↔app message
  bridge). Phase 10 covers built-in content types only.
- **Notifications, calendar, events, desk reservations, and third-party product
  integrations** (the former "integrations" module). Removed entirely for now.

<a name="deferred-decisions"></a>

## Decisions made

All six originally-deferred decisions are settled. Each is recorded as an Architecture Decision
Record in [`docs/adr/`](../docs/adr/README.md).

| Originally deferred                                 | Decision                                                                                                                                       | Record                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime transport & networking topology            | Native WebSocket (`ws`) in a single NestJS process with a custom binary protocol; client-authoritative movement, spatial-grid area of interest | [0003](../docs/adr/0003-transport-native-websocket.md), [0004](../docs/adr/0004-client-authoritative-movement-aoi.md)                                                |
| Media routing approach for voice/video at scale     | Self-hosted LiveKit SFU with selective subscription; spatial gain and panning computed in the client                                           | [0006](../docs/adr/0006-media-livekit-sfu.md), [0007](../docs/adr/0007-spatial-audio-web-audio.md)                                                                   |
| 3D rendering approach on the client                 | Three.js + React Three Fiber on Vite; Rapier physics in the browser only                                                                       | [0002](../docs/adr/0002-client-threejs-r3f-vite.md), [0005](../docs/adr/0005-physics-rapier-client-only.md)                                                          |
| 3D asset & avatar formats / standards               | glTF/GLB for worlds, VRM + Mixamo for avatars, MinIO + gltf-transform for the pipeline                                                         | [0010](../docs/adr/0010-3d-formats-gltf-vrm.md)                                                                                                                      |
| Storage technologies (durable + live session state) | PostgreSQL + TypeORM for durable state, process memory for live state, Yjs for collaborative state                                             | [0008](../docs/adr/0008-persistence-postgres-typeorm.md), [0009](../docs/adr/0009-no-redis-in-memory-pgboss.md), [0012](../docs/adr/0012-collaborative-state-yjs.md) |
| Hosting / deployment model                          | Docker Compose on a single server; no Redis; asset worker in its own process                                                                   | [0001](../docs/adr/0001-monorepo-turborepo-npm.md), [0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)                                                            |

Phase 7 deferred three of its own — how authorization is enforced, how bans key off identity, and
where the audit log lives. All three are settled in
[0013](../docs/adr/0013-roles-capabilities-and-audit.md): one capability matrix in
`packages/protocol` read by both transports, bans exact for accounts and documented as weak for
guests, and an `audit_log` made append-only by a grant and a trigger.

> When a decision is made, record it as a short Architecture Decision entry and link
> it from the affected phase(s). Specs stay technology-neutral; decisions live here.

Each phase file ends with a non-normative **Implementation Notes** section mapping its
requirements onto these decisions. The requirements themselves stay technology-neutral, as
principle 4 requires.
