# Phase 3 — Spatial Zones & Interaction Rules

## Overview

**Goal.** Give the world meaningful regions that change behavior: solid obstacles, private
conversation areas, presentation/broadcast areas, teleport portals, and generic
enter/exit triggers.

**Value.** Proximity alone isn't enough for real spaces. Private zones let a group talk
without distance leaking; spotlight zones let one person address everyone; portals connect
areas; collision makes the world feel physical.

**Depends on.** Phase 1 (world, positions, movement), Phase 2 (proximity media, which zones
override).

**Delivers.** Walking into a meeting area connects only the people in it; standing on a
stage broadcasts to the whole room; stepping on a portal moves you elsewhere; furniture and
walls block movement; other systems can react to participants entering/leaving regions.

---

## In scope

- Full collision volumes for impassable areas.
- Multiple spawn points with selection logic.
- Private/huddle zones that scope media to their occupants.
- Spotlight zones that broadcast media to an entire map.
- Portals that teleport within a map or to another world/instance.
- Generic trigger volumes that emit enter/exit events.
- Precedence rules when zones overlap or combine with proximity.

## Out of scope

- The visual editor to author zones (Phase 9) — here, zones are part of the loaded map data.
- Cross-map portal targeting infrastructure beyond the local concept (full multi-map
  management is Phase 8; this phase defines portal _behavior_ and a target reference).
- Object interaction prompts (Phase 10), though triggers here are the foundation.

---

## Functional Requirements

### Zone model

- **FR-3.1** A map may define any number of zones; each zone has a type, a 3D region/volume,
  and type-specific properties.
- **FR-3.2** The system detects, continuously, which zone(s) each participant currently occupies.
- **FR-3.3** Entering or exiting a zone is detected promptly and reliably, including when a
  participant is teleported into/out of one.

### Collision zones

- **FR-3.4** Collision volumes block participant movement: a participant cannot enter a solid
  zone (walls, furniture, blocked areas), extending Phase 1's static collision to authored volumes.
- **FR-3.5** Collision response is smooth (a participant slides along/stops at a surface rather
  than getting stuck or jittering).

### Spawn zones

- **FR-3.6** A map may define multiple spawn points; joining or respawning participants are
  placed at a spawn according to a defined rule (e.g., default spawn, least-crowded, or a named
  spawn referenced by a portal).
- **FR-3.7** Spawn placement avoids dropping participants inside collision volumes or on top of
  each other when alternatives exist.

### Private / huddle zones

- **FR-3.8** While inside a private zone, a participant's audio/video is shared with the other
  occupants of that same zone **regardless of distance** within it.
- **FR-3.9** While inside a private zone, a participant does **not** share media with, and does
  not receive media from, participants **outside** the zone — even if they are physically close
  (the zone isolates).
- **FR-3.10** Leaving a private zone returns the participant to normal proximity-based media.
- **FR-3.11** Distinct private zones are isolated from each other.

### Spotlight zones

- **FR-3.12** While inside a spotlight zone, a participant's audio/video is broadcast to **all**
  participants in the map (or a defined broadcast scope), regardless of distance.
- **FR-3.13** Spotlight broadcast coexists with normal proximity media for everyone else (a
  listener hears both the spotlighted speaker and their own nearby neighbors), per precedence rules.

### Portals

- **FR-3.14** A portal zone, when entered (or activated), teleports the participant to a target:
  another location in the same map, or another map/world instance.
- **FR-3.15** A portal references its destination abstractly (a target map/spawn identifier),
  so destinations can be resolved by the world-management layer (Phase 8) without changing this spec.
- **FR-3.16** Teleporting cleanly updates the participant's proximity, zone membership, and media
  connections at the new location (no stale links to the old location).

### Trigger volumes

- **FR-3.17** A generic trigger zone emits an "entered" event and an "exited" event identifying
  the participant and the zone, consumable by other systems (objects, chat scoping, analytics, etc.).
- **FR-3.18** Trigger events are reliable (no missed enters/exits) and de-duplicated (no repeated
  enter without an intervening exit).

### Precedence & combination

- **FR-3.19** When media rules conflict, a defined precedence applies. Baseline precedence:
  **private zone** overrides proximity (isolation wins); **spotlight** is additive to whatever the
  listener already hears; outside any media zone, **proximity** (Phase 2) applies.
- **FR-3.20** The precedence rules are documented and deterministic for all combinations a
  participant can be in (e.g., a spotlighted speaker who is also inside a private zone).

---

## Data Concepts

- **DC-3.1 Zone** — type (collision | spawn | private | spotlight | portal | trigger), 3D region,
  and type-specific properties (e.g., portal target, broadcast scope, spawn rule).
- **DC-3.2 Zone Membership** — for each participant, the set of zones currently occupied.
- **DC-3.3 Trigger Event** — participant id, zone id, kind (enter | exit), timestamp.
- **DC-3.4 Portal Target** — an abstract reference to a destination map and/or spawn.

---

## Rules & Edge Cases

- A participant may occupy multiple overlapping zones; behavior is the combination defined by
  precedence (FR-3.19/3.20).
- Zone boundaries must not flap for a participant standing on an edge (apply hysteresis).
- A participant teleported by a portal must not immediately re-trigger the same portal (cooldown
  or placing them at a destination clear of the inbound portal).
- Private-zone isolation must apply symmetrically (insiders and outsiders both stop receiving each
  other).
- If a portal's destination cannot be resolved, the participant stays put and is informed, rather
  than vanishing.

---

## Acceptance Criteria

- **AC-3.1** A participant cannot walk through authored walls/furniture and slides along them naturally.
- **AC-3.2** Two participants inside the same private zone hear/see each other fully and are silent
  to a third participant standing right outside the zone.
- **AC-3.3** A participant on a spotlight zone is heard by everyone in the map, while listeners still
  hear their own neighbors.
- **AC-3.4** Stepping onto a portal moves the participant to the correct destination with media and
  zone state correctly re-established and no echo from the old spot.
- **AC-3.5** A trigger zone fires exactly one enter and one exit per pass-through, delivered to a
  subscribed system.
- **AC-3.6** Respawn/spawn logic places participants at valid, non-overlapping, non-blocked spawns.

---

## Non-Goals & Deferred

- Authoring zones visually (Phase 9); cross-map routing/instance selection (Phase 8).
- Object-specific interactions (Phase 10) build on trigger volumes but are separate.
- **Deferred decisions:** how zone occupancy is computed and how media re-routing is implemented
  are chosen later; this spec fixes only the behavior and precedence.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### Precedence: FR-3.19 and FR-3.20, resolved

`FR-3.20` demands rules _"documented and deterministic for all combinations"_ and names the hard
case — a spotlighted speaker who is also inside a private zone. `FR-3.19` gives a baseline but
not a total order.

The full resolution lives in
[architecture.md](../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320). The
shape of it: rather than a precedence list, **a two-step computation** that covers every
combination by construction.

**Step 1 — isolation defines a universe.** In a private zone → your universe is that zone's
occupants. Otherwise → everyone not in a private zone.

**Step 2 — within the intersection of both universes, audience is a union** of proximity and
spotlight reach, minus blocks.

This yields `FR-3.8` (in-zone regardless of distance), `FR-3.9` (symmetric isolation — symmetry
is structural, since `universe(L) ∩ universe(S)` is commutative), `FR-3.11` (disjoint universes)
and `FR-3.13` (a union, so a listener hears the spotlight _and_ their neighbours).

**The named ambiguous case is decided as: a spotlighted speaker inside a private zone broadcasts
only to that private zone.** Isolation is computed first and is absolute. The spec does not
settle this; we decide it by **failing closed**, because a privacy leak is a serious harm and a
spotlight that doesn't carry is a visible, reportable annoyance. The Phase 9 editor should warn
when `private` and `spotlight` volumes overlap — it is almost always an authoring mistake.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FR-3.1`             | Zones in the Map Document as box or cylinder volumes ([map-document.md](protocol/map-document.md))                                                                                         |
| `FR-3.2`, `FR-3.3`   | Point-in-volume tests on the server tick, from reported transforms. **Geometry, not physics** — no Rapier on the server ([ADR 0005](../docs/adr/0005-physics-rapier-client-only.md))       |
| `FR-3.4`, `FR-3.5`   | `collision` zones become Rapier colliders **in the client**; the `KinematicCharacterController` provides sliding, which is exactly what `FR-3.5` asks for                                  |
| `FR-3.6`, `FR-3.7`   | Spawn rule from zone properties; arrivals offset within the spawn area and validated against collision volumes                                                                             |
| `FR-3.8`–`FR-3.11`   | Step 1 of the precedence model above                                                                                                                                                       |
| `FR-3.12`, `FR-3.13` | Step 2: spotlight reach unioned with proximity                                                                                                                                             |
| `FR-3.14`, `FR-3.16` | Server issues `FORCE_TRANSFORM` with `reason: "portal"`. Because the server owns zone occupancy and audience, the new location's media is re-established on the next tick — no stale links |
| `FR-3.15`            | `target: { mapId?, spawnId }`. `mapId` omitted means same-map; when present, Phase 8 resolves it                                                                                           |
| `FR-3.17`, `FR-3.18` | Enter/exit derived by diffing the occupancy set between ticks — de-duplication is inherent to a set diff, so no repeated enter is possible                                                 |
| `FR-3.19`, `FR-3.20` | `resolveAudience()` in `world-core`, per the model above                                                                                                                                   |

### Rules

- **Zone hysteresis** is `ZONE_HYSTERESIS_M` (0.3 m): the exit test uses a slightly larger
  volume than the enter test. Standing on an edge must not toggle private-zone isolation.
- **Portal re-trigger** is prevented primarily by `PORTAL_EXIT_CLEARANCE_M` (1.5 m) — placing the
  arrival clear of any inbound portal — with `PORTAL_COOLDOWN_MS` (1500) as the safety net for
  tightly-placed portals.
- **Unresolvable portal target:** the participant stays put and receives an `ERROR` frame. Never
  a teleport into nowhere.
- **Teleport resets client prediction.** `FORCE_TRANSFORM` must clear the interpolation buffer,
  or the avatar visibly slides across the map.

### Risks and sharp edges

1. **`resolveAudience()` gains zones here and must stay one function.** Phase 5 reuses it for
   chat scoping and Phase 7 adds blocks. A second proximity implementation anywhere silently
   breaks Phase 5's consistency rule.
2. **Zone occupancy is computed from quantized positions.** The client's local view of which zone
   it is in can disagree with the server's at a 1 cm boundary. The server's answer is
   authoritative for media; the client's is presentation only.
3. **Private-zone isolation must be verified from the outside.** The natural test is "can the two
   people inside hear each other" — the requirement that actually breaks is `FR-3.9`, whether
   someone standing just outside is properly cut off, in both directions.
4. **Overlapping zones are legal and common.** Every combination resolves through the model
   above; none should be special-cased in feature code.

### References

[architecture.md](../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320) ·
[map-document.md](protocol/map-document.md) ·
[ADR 0004](../docs/adr/0004-client-authoritative-movement-aoi.md) ·
[ADR 0005](../docs/adr/0005-physics-rapier-client-only.md) ·
[ADR 0006](../docs/adr/0006-media-livekit-sfu.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md)
