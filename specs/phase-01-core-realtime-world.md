# Phase 1 — Core Realtime World & Presence

## Overview

**Goal.** Multiple users connect to a single shared, hand-authored 3D world and see
each other move around in real time.

**Value.** This is the spine everything else hangs on: live presence and movement
replication in 3D. Nothing in later phases works without it.

**Depends on.** Nothing.

**Delivers.** A user opens the client, picks a display name, appears in a 3D world,
walks/turns with input, and sees other connected users moving smoothly at the same
time. They can leave and rejoin.

---

## In scope

- Connecting to and being present in one shared world instance.
- Ephemeral guest identity (no accounts yet).
- Local movement and replication of everyone's position/orientation.
- Smooth rendering of remote participants despite network gaps.
- Receiving only what's relevant (area-of-interest), so the world can hold many people.
- A live presence list.
- Loading and colliding with one static, hand-authored world.

## Out of scope

- Audio/video (Phase 2), zones/portals (Phase 3), avatar customization & animation
  polish (Phase 4), chat (Phase 5), accounts (Phase 6), multiple maps (Phase 8),
  editing the world (Phase 9).

---

## Functional Requirements

### Session & connection lifecycle

- **FR-1.1** A user can join the shared world instance and become a visible participant.
- **FR-1.2** On join, a user provides a display name; if none is given, one is generated.
- **FR-1.3** Each participant receives a unique identifier for the duration of their session.
- **FR-1.4** A user can leave; their participant is removed from everyone else's view promptly.
- **FR-1.5** If a connection drops, the client attempts to reconnect and restore the
  participant's presence and last-known position without a full manual rejoin.
- **FR-1.6** The system detects stale/abandoned sessions (no signal within a timeout) and
  removes them so ghost participants don't accumulate.

### Identity (ephemeral, this phase only)

- **FR-1.7** Guest identity is ephemeral: it exists only for the session and is not stored
  durably. (Durable accounts come in Phase 6.)
- **FR-1.8** Display names need not be unique, but each participant is distinguishable by
  their session identifier.

### Movement & input

- **FR-1.9** A user moves their participant through the world via input (at minimum:
  move in the horizontal plane and change facing/heading).
- **FR-1.10** Movement is bounded by the world's walkable area and static collision (see
  FR-1.18); a participant cannot pass through solid static geometry or leave the world bounds.
- **FR-1.11** Movement feels responsive locally (the local participant reacts to input
  immediately, without waiting for a server round-trip).

### State replication

- **FR-1.12** Each participant's position and orientation are continuously shared with
  other relevant participants in near-real-time.
- **FR-1.13** Remote participants' motion is rendered smoothly (interpolated) so that
  network update gaps do not appear as teleporting/stutter.
- **FR-1.14** Replicated per-participant state includes at least: identifier, display name,
  position, orientation, and a basic activity status (active/idle).
- **FR-1.15** A newly joined participant quickly receives the current state of all other
  relevant participants (a join/snapshot), not just future updates.

### Area of interest (scalability)

- **FR-1.16** A participant only receives updates for other participants/entities within a
  configurable region of interest around them, rather than for the entire world. As a
  participant moves, the set of received others updates accordingly.
- **FR-1.17** Entering and leaving another participant's area of interest produces a clean
  appear/disappear, with no lingering stale copies.

### World loading & collision

- **FR-1.18** The client loads a single, predefined static 3D world (authored outside this
  phase) including its visual geometry and its collision surfaces (ground, walls, obstacles).
- **FR-1.19** The participant is subject to gravity/ground constraints so they stay on
  walkable surfaces (no flying/falling through the floor) at a baseline level.
- **FR-1.20** One or more fixed spawn locations exist; joining participants appear at a spawn.

### Presence

- **FR-1.21** A user can see a list of who is currently present in the world instance
  (at least those within their area of interest, plus optionally a total count).
- **FR-1.22** Activity status transitions to "idle" after a period of no input and back to
  "active" on input.

---

## Data Concepts

- **DC-1.1 Session** — one connected client's live link: session id, joined-at,
  connection state, last-seen.
- **DC-1.2 Participant** — a present user: identifier, display name, transform
  (position + orientation), activity status. Transient this phase.
- **DC-1.3 Transform** — position and orientation in 3D space; the unit of movement
  replication.
- **DC-1.4 World Instance** — the running shared world: which Map it represents, the set
  of current participants, spawn locations.
- **DC-1.5 Static World Definition** — the authored geometry, collision surfaces, bounds,
  and spawn points loaded by the client (produced externally for now).

---

## Rules & Edge Cases

- Two participants may occupy overlapping positions; collision **between participants** is
  not required this phase (avatar-vs-avatar pushing is optional and not specified here).
- If the static world fails to load, the client must show a clear failure state rather than
  dropping the user into an empty void.
- Reconnect must not duplicate a participant (the old session is reconciled or replaced).
- Area-of-interest changes must not flap rapidly at a boundary (apply hysteresis or a buffer).
- Replication frequency and AOI radius must be tunable without code changes to feature logic.

---

## Acceptance Criteria

- **AC-1.1** Two or more clients connected to the same instance each see the others' avatars
  move in real time as they move.
- **AC-1.2** Remote movement appears smooth, not teleporting, under normal network jitter.
- **AC-1.3** A participant cannot walk through static walls or off the world; they stay grounded.
- **AC-1.4** Closing/refreshing one client removes that participant from the others within the
  stale-session timeout; reopening rejoins cleanly with no ghost left behind.
- **AC-1.5** With many simulated participants spread across the world, a single client only
  receives updates for those near it (verified by inspecting received update volume).
- **AC-1.6** A freshly joined client immediately sees the already-present nearby participants,
  not just ones who move afterward.
- **AC-1.7** The presence list reflects joins and leaves within a few seconds.

---

## Non-Goals & Deferred

- No spatial audio/video, no chat, no zones/portals, no avatar customization, no persistence
  of identity, no editing, no multiple worlds. Those are later phases.
- Anti-cheat / authoritative movement validation is out of scope; a trusting model is
  acceptable for now (revisit alongside moderation in Phase 7 if needed).
- **Deferred decisions:** realtime transport, networking topology, how area-of-interest is
  partitioned, rendering approach, and world/asset format are all chosen later.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior. This section records
> how we build them, and is safe to disagree with when a better approach appears.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The decision that shapes this phase

The Non-Goals above authorise a trusting model, and we take it. **The client is authoritative
over its own transform** ([ADR 0004](../docs/adr/0004-client-authoritative-movement-aoi.md)): it
runs physics locally, resolves collision, and reports the result. The server stores it, filters
by area of interest, and fans it out.

This removes prediction reconciliation — the hardest part of netcode — and means **no physics
engine on the server** ([ADR 0005](../docs/adr/0005-physics-rapier-client-only.md)). The server
keeps one override: `FORCE_TRANSFORM`, used later by portals (`FR-3.14`) and moderator respawn
(`FR-7.9`).

Accepted cost: a tampered client can walk through walls. It still cannot escape server-side
decisions — zone occupancy, audience and chat scoping are computed from the reported position on
the server.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-1.1`, `FR-1.3`   | `JOIN` → `JOINED` handshake; session UUID plus an instance-local `u16` for the hot path                                                                                             |
| `FR-1.2`             | Optional display name; generated when blank. Not validated for uniqueness                                                                                                           |
| `FR-1.4`             | `LEAVE` frame on `beforeunload`; broadcast `PARTICIPANT_REMOVE`                                                                                                                     |
| `FR-1.5`             | Resume token in `JOINED`, valid 60 s. Reconnect rebinds the **existing** participant to the new socket rather than creating a second — this is what satisfies the no-duplicate rule |
| `FR-1.6`             | Native WebSocket **ping/pong** with the `isAlive` pattern. Two missed pings terminate and reap. `STALE_SESSION_TIMEOUT_MS` must exceed twice `PING_INTERVAL_MS`                     |
| `FR-1.7`, `FR-1.8`   | Guest identity in an in-memory `Map`, never persisted. Phase 1 writes nothing to the database — the spec _requires_ ephemerality                                                    |
| `FR-1.9`             | WASD, camera-relative; avatar yaw follows movement direction, not camera yaw, so orbiting does not spin other people's audio panning                                                |
| `FR-1.10`, `FR-1.19` | Rapier `KinematicCharacterController` — gravity, slope limit, step offset and snap-to-ground are configuration, not code                                                            |
| `FR-1.11`            | Local physics runs before any network call. `NFR-5` budgets one frame                                                                                                               |
| `FR-1.12`            | `TRANSFORM` at 20 Hz up, `TRANSFORM_BATCH` at 20 Hz down                                                                                                                            |
| `FR-1.13`            | 100 ms interpolation buffer; remote transforms are interpolated in `useFrame` by mutating refs, **never** through React state                                                       |
| `FR-1.14`            | Transform on the binary path; name, status and activity on the JSON path (`PARTICIPANT_UPDATE`)                                                                                     |
| `FR-1.15`            | `SNAPSHOT` immediately after `JOINED`                                                                                                                                               |
| `FR-1.16`            | Uniform spatial hash grid in `world-core`, cell ≈ interest radius, so a query touches 9 cells                                                                                       |
| `FR-1.17`            | Explicit `PARTICIPANT_ADD` / `PARTICIPANT_REMOVE`. **Hysteresis is two radii** — enter 25 m, leave 30 m. A single radius reintroduces the flapping the Rules forbid                 |
| `FR-1.18`            | GLB via `useGLTF`; `COL_`-prefixed nodes become trimesh colliders and are not rendered ([map-document.md](protocol/map-document.md))                                                |
| `FR-1.20`            | Spawns from the Map Document; arrivals offset within the spawn area so they don't stack                                                                                             |
| `FR-1.21`            | Presence list from the area-of-interest set plus an instance total                                                                                                                  |
| `FR-1.22`            | Server-derived idle after `IDLE_TIMEOUT_MS`; cleared on input. Clients cannot set `idle` themselves                                                                                 |

### Where the code lives

| Package               | Contents                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/protocol`   | Opcodes, `encodeTransform*`/`decodeTransform*`, Zod schemas, tuning constants                    |
| `packages/world-core` | Spatial grid, area-of-interest query with hysteresis, interpolation buffer, character controller |
| `apps/api`            | WebSocket gateway, `WorldInstanceService`, 20 Hz tick, UUID→`u16` mapping, backpressure          |
| `apps/web`            | R3F scene, third-person camera, input, HUD, connection state machine                             |
| `apps/harness`        | The assertive bot scenarios that verify most of the acceptance criteria                          |

### Risks and sharp edges

1. **NestJS's `WsAdapter` cannot see binary frames.** It routes only JSON shaped `{event, data}`
   to `@SubscribeMessage`. So `@nestjs/platform-ws` is not used at all: a `ws.Server` is attached
   to Nest's HTTP server from an `@Injectable()` provider, which owns the message loop and the
   handshake. Discovering this after building on the adapter costs a rewrite of the hot path.
2. **Never call `setState` inside `useFrame`.** Interpolating 15 remote avatars through React
   state turns 60fps into 10fps. Mutate refs.
3. **Dispose GPU resources when participants leave interest.** Three.js does not free geometries,
   materials or textures on garbage collection. `NFR-14` only holds with explicit disposal.
4. **Quantize before comparing.** Interest membership is computed from the _received,
   already-quantized_ position. Comparing against an unquantized local value disagrees at
   boundaries.
5. **Retained sessions are invisible to others.** During the 60 s resume window the participant
   is removed from everyone's view; leaving a ghost standing would violate `FR-1.4`.
6. **Collider construction is the slow part of loading**, not the download. It belongs behind the
   loading screen ([ux/phase-01-screens.md](ux/phase-01-screens.md)).

### Verification

`AC-1.4`, `AC-1.5`, `AC-1.6` and `AC-1.7` are covered by `apps/harness` scenarios
(`session-reaping`, `aoi-coverage`, `late-join-snapshot`, `presence-churn`), plus
`aoi-boundary-walk` for `FR-1.17` and `reconnect-resume` for `FR-1.5`.

`AC-1.1`, `AC-1.2` and `AC-1.3` are verified manually with two browsers — there is no automated
browser test. See [`docs/testing-strategy.md`](../docs/testing-strategy.md).

### References

[ADR 0003](../docs/adr/0003-transport-native-websocket.md) ·
[ADR 0004](../docs/adr/0004-client-authoritative-movement-aoi.md) ·
[ADR 0005](../docs/adr/0005-physics-rapier-client-only.md) ·
[wire-protocol.md](protocol/wire-protocol.md) ·
[map-document.md](protocol/map-document.md) ·
[coordinates-and-units.md](conventions/coordinates-and-units.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md) ·
[ux/phase-01-screens.md](ux/phase-01-screens.md)
