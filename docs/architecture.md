# Architecture

This document stitches the [Architecture Decision Records](adr/README.md) into one picture. The
ADRs justify individual choices; this explains how they fit together, and resolves the design
questions that span several of them.

The [specs](../specs/README.md) remain the authority on behavior. This is the authority on
construction.

---

## Project parameters

Every decision here was made against these. Change one and several records need revisiting.

| Parameter          | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| Deployment context | Internal company tool, self-hosted                     |
| Scale target       | ~50 concurrent participants in one world               |
| Topology           | A single NestJS process: REST + WebSocket + world tick |
| Hosting            | Docker Compose on one server                           |

---

## The stack

| Layer               | Choice                                                            | ADR                                                   |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Monorepo            | Turborepo + npm workspaces, TypeScript throughout                 | [0001](adr/0001-monorepo-turborepo-npm.md)            |
| Client rendering    | Three.js + React Three Fiber, Vite, Tailwind + shadcn/ui, Zustand | [0002](adr/0002-client-threejs-r3f-vite.md)           |
| Realtime transport  | Native WebSocket (`ws`) in NestJS, custom binary protocol         | [0003](adr/0003-transport-native-websocket.md)        |
| Movement & interest | Client-authoritative, spatial hash grid with hysteresis           | [0004](adr/0004-client-authoritative-movement-aoi.md) |
| Physics             | Rapier WASM, client only                                          | [0005](adr/0005-physics-rapier-client-only.md)        |
| Voice & video       | LiveKit SFU, self-hosted single-node                              | [0006](adr/0006-media-livekit-sfu.md)                 |
| Spatial audio       | Web Audio `PannerNode` in the client                              | [0007](adr/0007-spatial-audio-web-audio.md)           |
| Durable storage     | PostgreSQL + TypeORM, `jsonb` map documents                       | [0008](adr/0008-persistence-postgres-typeorm.md)      |
| Live state & jobs   | In-memory; pg-boss queue; worker in its own process               | [0009](adr/0009-no-redis-in-memory-pgboss.md)         |
| 3D formats          | glTF/GLB worlds, VRM + Mixamo avatars, MinIO, gltf-transform      | [0010](adr/0010-3d-formats-gltf-vrm.md)               |
| Authentication      | Local accounts, argon2id, JWT + rotated refresh cookie            | [0011](adr/0011-auth-local-accounts.md)               |
| Collaborative state | Yjs CRDT over `y-websocket`                                       | [0012](adr/0012-collaborative-state-yjs.md)           |

---

## Repository layout

```
hubitat/
├── specs/                  behavior — the authority on what to build
│   ├── conventions/        coordinates & units · tuning defaults
│   ├── protocol/           wire protocol · map document
│   ├── ux/                 screens and states
│   └── nfr.md              non-functional requirements
├── docs/
│   ├── architecture.md     this file
│   ├── testing-strategy.md
│   └── adr/                the thirteen decisions
├── apps/
│   ├── web/                Vite + React + R3F — client and (phase 9) editor
│   ├── api/                NestJS — REST, WebSocket gateway, world tick
│   ├── worker/             (phase 9) pg-boss consumer, asset pipeline
│   └── harness/            headless assertive bots
├── packages/
│   ├── protocol/           opcodes, binary codecs, Zod schemas, tuning constants
│   ├── world-core/         pure logic: spatial grid, AOI, resolveAudience
│   ├── ui/                 Tailwind preset, shadcn components
│   └── config/             shared tsconfig / eslint / prettier
└── assets/world/           the phase 1 GLB and its map document
```

### Why `protocol` and `world-core` are separate packages

They are imported by three runtimes — browser, server, and bots — and that is the point. A
change to the byte layout of a movement frame breaks all three compilations at once instead of
producing silent runtime drift. Neither package may import Node or DOM APIs.

---

## Runtime topology

```
                      ┌──────────────────────────────┐
   browser  ◀────ws───┤  api  (NestJS, one process)  │
      │               │  · REST                       │
      │               │  · WebSocket gateway          │
      │               │  · world tick @ 20 Hz         │
      │               │  · in-memory live state       │
      │               └───────┬──────────────┬────────┘
      │                       │              │
      │                  PostgreSQL      pg-boss queue
      │                  (durable)       (same database)
      │                                       │
      │                                  ┌────▼─────┐
      └────webrtc────▶ LiveKit           │  worker  │──▶ MinIO
                       (SFU)             │ (phase 9)│
                                         └──────────┘
```

Six Compose services: `web` · `api` · `postgres` · `livekit` · `minio` · `mailpit`.
`worker` joins at Phase 9. `coturn` is optional and usually unnecessary on an internal network.

**Phases 1–4 exercise `web`, `api` and `livekit`.** Nothing about the world is persisted, and
still is not — `FR-1.7` requires guest identity to be ephemeral, so a world instance dies with the
process. **Phase 5 is where `postgres` starts earning its place**, with the first two tables
(`messages`, `read_state`) and the first migration; TypeORM arrives with them. **Phase 6 is where it
becomes the thing you cannot lose**: seven more tables holding accounts, profiles, spaces,
memberships, invites and sessions, and the first data whose loss is not recoverable by reconnecting.
Mailpit joins it for password recovery. MinIO stays declared and idle until Phase 9.

`postgres` and `livekit` are the two services whose absence is a supported configuration rather
than a failure, and they degrade differently because the loss means different things:
with no credentials set, the API mints no token, `JOINED` carries `media: null`, and the client
renders the media controls as unavailable while presence and movement carry on. That is the
FR-2.5 rule about not breaking presence, applied to a missing SFU for the same reason it applies
to a missing microphone.

An unreachable database is governed by two settings with the same shape, `CHAT_PERSISTENCE` and
`ACCOUNTS`. Under `auto` — the default, and what the no-Docker development flow runs on — chat
history falls back to an in-memory store, accounts turn themselves off, and the server says both at
boot and on `/health`. Under `postgres` / `required`, which is what Compose sets, it refuses to
boot. The asymmetry against LiveKit is deliberate: a missing SFU is _visibly_ missing, while a
durable channel quietly degraded to one that empties on restart is a failure nobody notices until
they go looking for a conversation that is no longer there — and a deployment that meant to require
accounts and instead admits everybody as a guest is `FR-6.8` inverted.

From phase 6 there is **one connection**, opened in `api/src/persistence/` and lent to both chat and
the account services. Two pools against one Postgres would be two connection limits to size, two
migration runners racing on first boot, and two different answers to "is the database up".

---

## Where each kind of state lives

The boundary that causes bugs when it stays implicit:

| Kind                                                                                                                                  | Home                     | Rationale                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live** — participants, transforms, zone occupancy, instance registry, typing, rate-limit counters, force-mute state, kick cooldowns | `api` process memory     | Dies with the WebSocket connections on restart. Clients reconnect and rebuild from nothing, so there is no state worth preserving. A force-mute is the one entry here that also exists durably — the world holds it so the tick can read it, and the LiveKit grant is rebuilt from it on every join. |
| **Durable** — accounts, spaces, roles, bans, blocks, audit log, persistent messages, map versions, asset metadata, Yjs snapshots      | PostgreSQL               | Must survive restart and redeploy.                                                                                                                                                                                                                                                                   |
| **Large binary** — GLB, textures, images, documents                                                                                   | MinIO                    | Does not belong in the database or its backups.                                                                                                                                                                                                                                                      |
| **Jobs** — asset optimization (`FR-9.13`)                                                                                             | pg-boss, same PostgreSQL | Transactional queue beside the data it mutates, without a second server.                                                                                                                                                                                                                             |

**Accepted consequence:** live state in memory makes "one `api` process" an architectural
constraint rather than a preference. Two processes would need sticky sessions _and_ a
coordination layer.

---

## The realtime loop

```
Client                                    api
──────                                    ───
input → Rapier (AUTHORITY)
resolves collision locally
        │
        │ transform @ 20 Hz, binary
        ├────────────────────────────────▶ store in memory
        │                                  (no physics server-side)
        │                                          │
        │                                          ▼  tick @ 20 Hz
        │                                  spatial grid → AOI + hysteresis
        │                                  resolveAudience()
        │                                          │
        │ ◀───── batch, neighbours only ───────────┤
        │        (skipped if bufferedAmount high)  │
        ▼
interpolate over 100 ms
```

The client owns its transform; the server never corrects ordinary movement. It retains the
power to **force** a transform — Phase 3 portals, Phase 7 respawn — which the client obeys.

The tick exists to decouple client send rate from broadcast rate and to batch each recipient's
neighbours into a single frame.

### Frame shapes

Tagged frames: first byte is the opcode. Full definition in
[wire-protocol.md](../specs/protocol/wire-protocol.md).

- **Hot path** — transform batches, hand-packed. Per participant: `id u16` + `x,y,z i16`
  (centimetres) + `yaw u8` + `flags u8` = **10 bytes**, versus roughly 40 as JSON. The `id` is
  an instance-local index mapped from the session UUID.
- **Events** — join, leave, snapshot, chat, emote, zone crossings. JSON under separate opcodes.

---

## Media precedence — resolving FR-3.19 and FR-3.20

`FR-3.20` requires the rules to be _"documented and deterministic for all combinations a
participant can be in"_, and names the awkward case: a spotlighted speaker who is also inside a
private zone. `FR-3.19` gives a baseline but not a total order. This section is that total
order.

### The rule

Rather than a precedence list, the model is a **two-step computation**. It is simpler and
covers every combination by construction.

**Step 1 — isolation defines a universe.** For each participant:

- In a private zone `Z` → their universe is _the occupants of `Z`_.
- Not in any private zone → their universe is _all participants who are not in any private zone_.

**Step 2 — within that universe, audience is a union.**

```
audience(L) = { S ∈ universe(L) ∩ universe(S)
                | proximity(L,S) OR spotlight_reaches(L,S) }
              minus blocked(L,S)
```

with gain: full and distance-independent inside a shared private zone or via spotlight;
distance falloff otherwise.

### Why this is the right shape

| Requirement                                                       | Satisfied by                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `FR-3.8` in-zone occupants hear each other regardless of distance | shared universe, distance-independent gain                                            |
| `FR-3.9` symmetric isolation from outsiders                       | intersecting `universe(L) ∩ universe(S)` — symmetry is structural, not enforced twice |
| `FR-3.11` distinct private zones isolated from each other         | universes are disjoint                                                                |
| `FR-3.13` listener hears the spotlight _and_ their neighbours     | step 2 is a union, not a choice                                                       |
| `FR-3.19` private overrides proximity; spotlight is additive      | step 1 constrains, step 2 adds                                                        |
| `FR-7.16` blocks                                                  | a subtraction on the final set                                                        |

### The named ambiguous case, decided

**A spotlighted speaker standing inside a private zone broadcasts only to that private zone.**

Isolation is computed first and is absolute; the spotlight operates within it. The spec does not
settle this, so it is decided here on the principle of **failing closed**: a privacy leak is a
serious harm, a spotlight that does not reach is a visible and reportable annoyance. Choosing
the other way would let a map author silently defeat a huddle room's isolation.

The reverse case follows from the same rule: a listener inside a private zone does **not** hear
a spotlight originating outside it.

Overlapping private and spotlight zones is almost certainly an authoring mistake, so the Phase 9
editor should flag the overlap as a warning.

### One function

All of this is `resolveAudience()` in `packages/world-core` — a pure function of
`(participant, allParticipants, zones, blocks)`. It is consumed by **Phase 2** (proximity and
falloff), **Phase 3** (zone precedence), **Phase 5** (recipients for `nearby` and `zone` chat)
and **Phase 7** (blocks).

Phase 5's rule that chat recipients must match media recipients is met by construction: it is
the same call, not a parallel implementation. This is the highest-leverage design decision in
the project.

Built, that turned out to mean **there is no distance check anywhere in the chat code**.
`resolveNearbyRecipients` in `world-core` builds an `AudienceConfig` at `CHAT_NEARBY_RADIUS_M` and
delegates; the chat service knows how to look up a zone's occupants and nothing else about space.

One inversion was needed and is worth knowing about. `resolveAudience(listener, …)` answers _"who
can this listener hear"_, and chat asks the transpose: _"who can hear this speaker"_. For proximity
and private zones the relation is symmetric and either direction would do — but for a spotlight it
is not, and asking what a speaker on a stage can hear returns the few people standing next to the
stage rather than the whole map. So each candidate is asked, as a listener, whether the sender is
in _their_ audience. That is the literal reading of "people my local chat reaches", and it inherits
spotlight reach and private-zone isolation without restating either.

Phase 7 added the fourth consumer and changed nothing else. `FR-7.16` is a `BlockLookup` argument
that was already in the signature, and the symmetry rule — a block cuts both directions — is a
`symmetricBlocks` helper in the same package, so the media path and the chat path cannot form
different opinions about what a block means. The payoff is the one the Phase 7 implementation notes
predicted: a blocked person stops being heard and stops being read at the same instant, and neither
half of the code knows the other exists.

The alternative it rules out is worth naming, because it is the obvious implementation. Filtering
blocked participants where they are _rendered_ leaves the WebRTC subscription up and the audio
flowing — it hides a person rather than silencing them, and the difference is inaudible from the
outside until somebody checks `chrome://webrtc-internals`.

---

## Data concepts to implementation

Where each `DC-x.y` from the specs lives.

| Data concept                                                                 | Implementation                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DC-1.1` Session · `DC-1.2` Participant                                      | in-memory registry in `api`, keyed by session UUID with an instance-local `u16`                                 |
| `DC-1.3` Transform                                                           | binary codec in `packages/protocol`                                                                             |
| `DC-1.4` World Instance                                                      | `WorldInstanceService` in `api`; registry in memory                                                             |
| `DC-1.5` Static World Definition                                             | GLB in `assets/world/` + Map Document                                                                           |
| `DC-2.1` Media Session · `DC-2.2` Track                                      | LiveKit room and track state                                                                                    |
| `DC-2.3` Proximity Set                                                       | output of `resolveAudience()`                                                                                   |
| `DC-2.4` Speaking Signal                                                     | LiveKit `ActiveSpeakersChanged`                                                                                 |
| `DC-3.1` Zone · `DC-3.4` Portal Target                                       | Map Document, `jsonb` (Zod-validated)                                                                           |
| `DC-3.2` Zone Membership · `DC-3.3` Trigger Event                            | computed per tick in `world-core`, held in memory                                                               |
| `DC-4.1` Avatar Appearance                                                   | session memory (guest) → `profiles.avatar_appearance jsonb` (account)                                           |
| `DC-4.2` Animation State                                                     | client-side, derived from planar speed                                                                          |
| `DC-4.3` Presence Status                                                     | replicated participant field                                                                                    |
| `DC-4.4` Emote                                                               | JSON event, server-throttled                                                                                    |
| `DC-5.1` Channel · `DC-5.2` Message                                          | `messages` table for `room`/`direct`; `nearby`/`zone` never persisted                                           |
| `DC-5.3` Typing State                                                        | forwarded, never held — the server keeps none, and the receiving client expires it from a TTL the frame carries |
| `DC-5.4` Read State                                                          | `read_state` table                                                                                              |
| `DC-6.1`–`DC-6.6` accounts, profiles, guests, memberships, invites, sessions | `accounts` · `profiles` · `spaces` · `memberships` · `invites` · `refresh_tokens`; a guest is session memory    |
| `DC-7.1` Role                                                                | `memberships.role`; `guest` is the absence of the row, never a stored value                                     |
| `DC-7.2` Capability Matrix                                                   | computed constant in `packages/protocol`, read by `RolesGuard` on HTTP **and** by the gateway's frame dispatch  |
| `DC-7.3` Moderation Action                                                   | socket frames for live sessions, HTTP for durable ones; recorded in `audit_log`                                 |
| `DC-7.4` Access Policy                                                       | columns on `spaces` + the `space_allowlist` table; evaluated at the door on every join, including a resume      |
| `DC-7.5` Block                                                               | `blocks`, keyed by the phase 6 identity string on both sides — which is what makes `FR-7.18` fall out           |
| `DC-7.6` Report                                                              | `reports`, with the position captured server-side at filing time                                                |
| `DC-7.7` Audit Log                                                           | `audit_log` — insert-only by grant **and** by trigger; the grant stops the app, the trigger stops the owner     |
| `DC-8.1` Space · `DC-8.2` Map · `DC-8.5` Directory                           | PostgreSQL                                                                                                      |
| `DC-8.3` Map Instance · `DC-8.4` Assignment Policy                           | in-memory registry; strategy classes                                                                            |
| `DC-9.1` Map Document · `DC-9.5` Map Version                                 | `map_versions.document jsonb`, copy-forward versioning                                                          |
| `DC-9.2` Placed Object                                                       | node in the Map Document                                                                                        |
| `DC-9.3` Asset · `DC-9.4` Asset Library                                      | metadata in PostgreSQL, bytes in MinIO, status from the pg-boss job                                             |
| `DC-10.1` Interactive Object · `DC-10.2` Content                             | Map Document                                                                                                    |
| `DC-10.3` Shared Object State                                                | Yjs document, snapshot as `bytea` in `object_states`                                                            |
| `DC-10.4` Interaction Session                                                | client-side, ephemeral                                                                                          |

---

## Known sharp edges

Collected here because each has cost someone a day somewhere.

1. **NestJS's `WsAdapter` cannot see binary frames.** It routes only JSON shaped `{event, data}`
   to `@SubscribeMessage`. We therefore skip `@nestjs/platform-ws` entirely and attach a
   `ws.Server` to Nest's HTTP server from a provider, owning the message loop and the handshake.
   [0003](adr/0003-transport-native-websocket.md)
2. **Chrome will not feed a WebRTC track into Web Audio** unless it is also attached to a
   playing media element. Attach each remote track to a muted off-screen `<audio>` and route the
   graph in parallel, or spatial audio produces silence that looks like a maths bug.
   [0007](adr/0007-spatial-audio-web-audio.md)
3. **Never `setState` inside `useFrame`.** Per-frame interpolation and camera updates mutate refs
   directly. Getting this wrong turns 60fps into 10fps.
   [0002](adr/0002-client-threejs-r3f-vite.md)
4. **Force-mute needs two LiveKit calls.** `mutePublishedTrack` alone can be undone by the
   client; `updateParticipant({canPublish:false})` is what makes `FR-7.5` authoritative.
   [0006](adr/0006-media-livekit-sfu.md)
5. **Silence still costs bandwidth.** `FR-2.11` requires the stream not be consumed beyond the
   threshold — gain reaching zero is not enough; the subscription must drop.
   [0007](adr/0007-spatial-audio-web-audio.md)
6. **Mixamo→VRM retargeting is manual.** Different bone names and rest pose; the mapping and hip
   scaling are written once and documented. [0010](adr/0010-3d-formats-gltf-vrm.md)
7. **Area-of-interest hysteresis is two radii.** A single radius reintroduces the boundary
   flapping the Phase 1 and 3 rules forbid.
   [0004](adr/0004-client-authoritative-movement-aoi.md)
8. **`synchronize: true` is never enabled**, including in development, so the migration path is
   exercised continuously. [0008](adr/0008-persistence-postgres-typeorm.md)
9. **Invite redemption is a check-then-act.** Reading `uses`, comparing it to `max_uses` and then
   incrementing lets two people clicking one single-use link at the same moment both pass. The
   whole redemption runs in a transaction with `SELECT … FOR UPDATE` on the invite row.
   [0011](adr/0011-auth-local-accounts.md)
10. **Refresh-token rotation needs reuse detection _and_ leeway.** Without detection, a stolen
    token stays valid alongside the legitimate one and nothing notices. Without leeway, two
    browser tabs restored at the same instant present the same cookie and sign the user out of
    both — so a token re-presented within `REFRESH_REUSE_LEEWAY_MS` is treated as a client racing
    itself, and only a later replay revokes the family.
    [0011](adr/0011-auth-local-accounts.md)
11. **A token that does not resolve is refused, never downgraded to a guest.** Silently continuing
    as somebody else is the failure with no symptom: the person keeps walking around, and their
    profile edits, direct messages and membership all land on an identity that evaporates when
    they close the tab.
12. **`credentials: 'include'` on the client and a reflected CORS origin on the server.** The
    refresh cookie is the whole of `FR-6.17`, and it is not sent cross-origin without the first;
    the second is required because `Access-Control-Allow-Origin: *` and credentials are
    incompatible in every browser.
13. **The WebSocket carries moderation frames, so it needs the same guard the controllers have.**
    `NFR-34` says so and the Phase 7 notes call it the single most likely way that phase ships
    broken: an unguarded handler for `MODERATE` is a complete bypass of every role check in the
    product, and it is invisible to any test that only exercises REST.
    [0013](adr/0013-roles-capabilities-and-audit.md)
14. **A role must not be carried on the access token.** It would keep working for
    `ACCESS_TOKEN_TTL_MIN` after being revoked, which makes `FR-7.3` advisory. Resolved per request
    from `memberships`. [0013](adr/0013-roles-capabilities-and-audit.md)
15. **An append-only grant does not stop a superuser**, and the default Compose deployment connects
    as one. `audit_log` therefore has a `REVOKE` _and_ a `BEFORE UPDATE OR DELETE OR TRUNCATE`
    trigger; the grant stops the application, the trigger stops the owner.
    [0013](adr/0013-roles-capabilities-and-audit.md)
16. **The ban check belongs in the resume path, not only in fresh joins.** A ban guarded on one
    branch lasts exactly until its target's client reconnects — and reconnecting is what a client
    that has just been disconnected does.
    [0013](adr/0013-roles-capabilities-and-audit.md)
17. **`ORDER BY reviewed_at ASC` puts handled reports first.** Postgres sorts nulls _last_ for
    ascending order, so the obvious spelling buries the queue under everything already dealt with.
    `NULLS FIRST` is load-bearing.
