# Phase 8 — Rooms, Spaces & World Management

## Overview

**Goal.** Grow from one hand-authored world into a managed structure: a Space containing
multiple connected Maps, portals that move people between them, capacity handling via
instancing, and lifecycle controls.

**Value.** Real deployments aren't one room. Organizations want a campus of connected
spaces, the ability to handle crowds without one overloaded world, and tools to create,
configure, and retire spaces.

**Depends on.** Phase 1 (world instances), Phase 3 (portals reference targets), Phase 6
(ownership/membership), Phase 7 (access/capacity policy).

**Delivers.** Owners can create and configure a Space with several Maps connected by
portals; large crowds are split into instances of a Map; participants can navigate between
Maps; and Spaces can be configured, archived, and deleted.

---

## In scope

- The Space → Map hierarchy and ownership.
- Multiple Maps per Space, connected by portals (resolving Phase 3 portal targets).
- Capacity handling: multiple instances of a Map, with assignment/overflow rules.
- Space and Map lifecycle: create, configure, archive, delete.
- A default/landing Map and cross-Map presence/directory.

## Out of scope

- Authoring Map _contents_ (geometry, zones, objects) — that's the editor, Phase 9. This phase
  manages Maps as units and connects them.
- Org-above-Space hierarchy beyond "an owner owns Spaces" (kept minimal).

---

## Functional Requirements

### Hierarchy & ownership

- **FR-8.1** A Space is owned by an account (Phase 6) and contains one or more Maps.
- **FR-8.2** A Space has configuration: name, default/landing Map, access policy (Phase 7),
  guest policy (Phase 6), and its member list.
- **FR-8.3** Each Map belongs to exactly one Space and can be referenced as a portal destination.

### Multiple connected maps

- **FR-8.4** A Space can contain multiple Maps; a participant is present in one Map (instance) at a
  time.
- **FR-8.5** Portals (Phase 3) resolve their abstract targets to a concrete Map (and spawn) within
  the Space, moving the participant there.
- **FR-8.6** Moving between Maps cleanly transfers the participant: they leave one world instance and
  join another, with presence, proximity, and media re-established at the destination.
- **FR-8.7** A participant entering a Space lands on its default/landing Map at a valid spawn.

### Capacity & instancing

- **FR-8.8** Each Map has a capacity (Phase 7, FR-7.14). When a Map instance reaches capacity,
  additional participants are handled by a defined rule: refuse, or spin up/assign an additional
  **instance** of the same Map.
- **FR-8.9** When instancing is used, participants are assigned to an instance by a defined policy
  (e.g., keep invited/grouped people together, fill-then-spill, or least-loaded).
- **FR-8.10** Participants in different instances of the same Map do not see or hear each other
  (each instance is its own world), and this is made understandable to users.
- **FR-8.11** Instances are created and torn down based on demand (an empty extra instance is
  reclaimed) without disrupting occupied instances.

### Presence & directory

- **FR-8.12** A participant can see which Maps exist in the Space and, at a high level, where people
  are (e.g., counts per Map), subject to permissions.
- **FR-8.13** A participant can navigate to a chosen Map directly (where permitted), not only via
  in-world portals.
- **FR-8.14** Finding/following another member to their Map/instance is supported where permissions
  allow (e.g., "go to" a member), reusing instance-assignment rules.

### Lifecycle

- **FR-8.15** A permitted role can create a Space and add/remove Maps within it.
- **FR-8.16** A permitted role can configure a Space and its Maps (names, default Map, policies).
- **FR-8.17** A permitted role can archive a Space (made inaccessible but retained) and delete it
  (removed durably), with appropriate confirmation and permission checks.
- **FR-8.18** Archiving/deleting a Space or Map handles currently-present participants gracefully
  (e.g., notified and moved out, not left in a broken instance).

---

## Data Concepts

- **DC-8.1 Space** — owner, name, member list, default Map, policies, the Maps it contains.
- **DC-8.2 Map (managed unit)** — identity, the Space it belongs to, its capacity and instancing
  policy, its portal-target addressability. (Contents authored in Phase 9.)
- **DC-8.3 Map Instance** — a live running copy of a Map (a World Instance, DC-1.4) with its own
  participants; one of possibly several for the same Map.
- **DC-8.4 Instance Assignment Policy** — the rule for placing a participant into an instance.
- **DC-8.5 Space Directory** — the navigable view of Maps and aggregate presence within a Space.

---

## Rules & Edge Cases

- A participant is in exactly one Map instance at a time; switching is an atomic leave/join.
- Instance assignment should try to keep groups together (people who arrive via the same invite or
  who "follow" a member), within capacity.
- Splitting friends across instances must be explainable and ideally avoidable; provide a way to
  join a specific person's instance where permitted.
- Reclaiming empty instances must never disrupt a non-empty one or strand a just-arriving participant.
- Portal targets that point to a full Map must apply the capacity rule (refuse or new instance),
  consistently with Phase 3 FR-3.16 and Phase 7 capacity.
- Deleting a Map referenced by a portal must not leave dangling portals (handle/flag broken targets).

---

## Acceptance Criteria

- **AC-8.1** An owner creates a Space with two Maps connected by a portal; walking through the portal
  moves a participant to the other Map with media/presence correctly re-established.
- **AC-8.2** Entering the Space lands the participant on the default Map at a valid spawn.
- **AC-8.3** Exceeding a Map's capacity either refuses entry clearly or places the participant into a
  second instance per the configured policy.
- **AC-8.4** Participants in different instances of the same Map cannot see/hear each other, and the
  UI makes the separation understandable.
- **AC-8.5** A participant can view Maps and per-Map presence counts and navigate to a permitted Map
  directly; "go to a member" lands them in that member's instance where allowed.
- **AC-8.6** Archiving/deleting a Space or Map moves out present participants gracefully and enforces
  permissions and confirmation.

---

## Non-Goals & Deferred

- Authoring Map contents (Phase 9).
- Deep organization hierarchies, billing, or quota systems.
- **Deferred decisions:** how instances are provisioned/scaled and where Space/Map metadata is stored
  are chosen later; this spec fixes structure, navigation, and capacity behavior.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### Instances are in-process objects, not containers

"Spin up an instance" reads like provisioning. It is not. A Map Instance is an object in the
`api` process's memory holding a participant registry and a tick
([ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)). Creating one is an allocation;
reaping one is dropping a reference.

That makes `FR-8.11` ("created and torn down based on demand") cheap, and it makes the registry
authoritative without coordination — with one process, the in-memory map **is** the complete
truth, so `FR-8.12`'s per-map counts are read directly rather than aggregated.

The accepted cost is the standing one: this only holds while there is a single `api` process.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FR-8.1`–`FR-8.3`    | `Space`, `Map` entities in PostgreSQL; a Map belongs to exactly one Space and is addressable as a portal target                                                                                                                                              |
| `FR-8.4`, `FR-8.7`   | A participant holds exactly one instance reference; entry resolves to the Space's default Map                                                                                                                                                                |
| `FR-8.5`             | Phase 3's abstract `{ mapId, spawnId }` resolved here against the Space                                                                                                                                                                                      |
| `FR-8.6`             | **Atomic leave/join orchestrated server-side:** remove from instance A, leave LiveKit room A, join instance B, issue a fresh LiveKit token for room B, `FORCE_TRANSFORM` to the target spawn, then `SNAPSHOT`. Never dual presence, never a stale media link |
| `FR-8.8`             | Capacity from `FR-7.14`; on overflow, refuse or allocate per policy                                                                                                                                                                                          |
| `FR-8.9`             | `DC-8.4` as strategy classes: `FillThenSpill` (default), `LeastLoaded`, `FollowMember`                                                                                                                                                                       |
| `FR-8.10`            | Instances share nothing — separate registries, separate LiveKit rooms. Isolation is structural. The UI must name the instance so the separation is understandable rather than mysterious                                                                     |
| `FR-8.11`            | Reaped after `INSTANCE_REAP_AFTER_MS` (120 s) of emptiness. **Instance 0 is never reaped**                                                                                                                                                                   |
| `FR-8.12`, `FR-8.13` | Directory reads the in-memory registry; direct navigation subject to `FR-7.x` access checks                                                                                                                                                                  |
| `FR-8.14`            | "Go to a member" resolves their instance and reuses the assignment path, so it respects capacity like any other entry                                                                                                                                        |
| `FR-8.15`–`FR-8.17`  | CRUD with role checks; archive sets a flag, delete is durable removal, both confirmed                                                                                                                                                                        |
| `FR-8.18`            | Present participants are notified and moved to the default Map, or ejected to the directory if the Space itself is going                                                                                                                                     |

### Rules

- **The reap delay prevents thrashing.** An instance that momentarily empties as people walk
  through a portal must not be torn down and immediately recreated.
- **Never reap while someone is arriving.** Assignment takes a reference before the sweep can see
  the instance as empty, or a joiner lands in a reference that is being dropped.
- **Keep groups together.** `FollowMember` and same-invite arrivals bias toward the same
  instance, within capacity. Splitting colleagues is the failure mode users notice most.
- **Deleting a Map must not leave dangling portals.** Scan `map_versions` documents for portals
  targeting it and flag them; `jsonb` gives no foreign key, so this is an explicit query — the
  main cost of storing the document as a blob ([ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md)).

### Risks and sharp edges

1. **Map transfer is the riskiest operation in the phase.** Four things move at once — instance
   membership, LiveKit room, transform, and area of interest. A partial failure leaves a
   participant present in two places or none. It should be a single orchestrated method with
   explicit rollback, not four call sites.
2. **The LiveKit token is per-room.** Reusing the old token on the new room fails in a way that
   looks like a media bug rather than an auth bug.
3. **Capacity is checked in two places** — `FR-7.14` at Space entry and `FR-8.8` at instance
   assignment. One configured policy, evaluated by one function, or they will disagree.
4. **`FR-8.10` is a UX problem as much as a technical one.** Two people in different instances of
   the same room, unable to see each other, is baffling unless the interface says so plainly.

### References

[ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[ADR 0006](../docs/adr/0006-media-livekit-sfu.md) ·
[map-document.md](protocol/map-document.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md)
