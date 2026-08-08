# ADR 0004 — Client-authoritative movement; area of interest via spatial grid with hysteresis

**Status:** accepted · **Affects:** phases 1, 3, 7

## Context

Phase 1 asks for two things that usually pull against each other. `FR-1.11` wants movement to
feel immediate, with no server round-trip. `FR-1.10` wants collision to actually stop people.
The textbook answer is server-authoritative movement with client-side prediction and
reconciliation — and reconciliation is the hardest part of netcode to get right.

The spec pre-empts that. Phase 1's Non-Goals say:

> Anti-cheat / authoritative movement validation is out of scope; a trusting model is
> acceptable for now (revisit alongside moderation in Phase 7 if needed).

Separately, `FR-1.16` requires interest management, and the Rules section forbids the set from
flapping at a boundary.

## Decision

**The client is authoritative over its own transform.** It runs physics locally, resolves
collision, and reports the resulting position and yaw at 20 Hz. The server stores it, filters
it by area of interest, and fans it out. The server runs no physics — see
[0005](0005-physics-rapier-client-only.md).

The server keeps one power the client cannot override: it can **force** a transform. Portals
(`FR-3.14`) and moderator respawn (`FR-7.9`) are server-issued teleport commands the client
obeys.

**Area of interest** is a uniform spatial hash grid in `world-core`, cell size ≈ the interest
radius, so a query touches 9 cells. Hysteresis is two radii: **enter at 25 m, leave at 30 m**.
Once you are in someone's set you stay until you cross the larger radius, which is what stops
the boundary flapping the Rules forbid.

The server ticks at **20 Hz**, decoupling client send rate from broadcast rate and batching all
of a recipient's neighbours into one frame.

## Consequences

- Phase 1 loses reconciliation entirely — no rollback, no replay, no server correction of
  ordinary movement. This is a large reduction in the hardest code in the project.
- No physics engine on the server: no WASM in Node, no collision meshes server-side, and the
  tick stays cheap enough to share a process with everything else.
- **A tampered client can walk through walls and teleport.** This is the accepted cost, and the
  spec authorises it explicitly. Note what it does _not_ affect: zone occupancy, media
  routing and chat scoping are all computed server-side from the reported position, so a
  cheater can move illegally but cannot listen where they shouldn't be — they'd have to _be_
  there, which the server would then honour. Revisit in Phase 7 if it matters.
- Zone occupancy (`FR-3.2`) is computed on the server from reported transforms. It needs
  geometry, not physics — point-in-volume tests, which `world-core` does without Rapier.
- Hysteresis means the two radii must be configured as a pair. A single radius reintroduces
  flapping.
- Entering and leaving an area of interest must emit explicit appear/disappear events
  (`FR-1.17`) so the client can drop remote state cleanly rather than leaving stale copies.

## Alternatives rejected

- **Server-authoritative with prediction and reconciliation** — correct, cheat-resistant, and
  the right answer for a public game. Rejected for Phase 1 as several times the work for a
  property the spec explicitly does not require.
- **Client-authoritative with server-side sanity checks** (speed caps, teleport detection) — a
  cheap middle ground worth revisiting in Phase 7, but it needs the server to model movement
  limits, which is the beginning of server-side physics.
- **Broadcast everything, filter on the client** — simplest possible server, and directly
  violates `FR-1.16`.
- **Distance sort instead of a grid** — O(n²) per tick. Fine at 50, wrong by construction, and
  the grid is not meaningfully harder to write.
