# Convention — Coordinates, Units and Camera

**Status:** normative · **Applies to:** all phases

The phase specs describe positions, distances, facing and movement without ever fixing what a
unit is or which way is up. Two implementers can satisfy every functional requirement and still
produce incompatible systems. This document fixes those conventions, plus the camera model,
which no phase spec defines at all.

Values that are _tunable_ live in [tuning-defaults.md](tuning-defaults.md). What is here is
_structural_ — changing it invalidates assets and stored data.

---

## Coordinate system

**Right-handed, Y-up, metres.**

| Axis | Direction                                            |
| ---- | ---------------------------------------------------- |
| +X   | right                                                |
| +Y   | up                                                   |
| −Z   | forward (the direction a participant faces at yaw 0) |

This is the Three.js and glTF default, and matches Rapier. Choosing anything else would mean
converting on every asset load and every physics step.

- **Unit:** 1.0 = one metre. Assets must be authored or exported at this scale.
- **Rotation:** radians. Positive rotation is counter-clockwise when viewed from the positive
  axis toward the origin.
- **Ground plane:** the XZ plane. "Horizontal movement" in `FR-1.9` means movement in XZ.

### Facing

A participant's orientation is a single **yaw** angle about the +Y axis, in radians, normalised
to `[0, 2π)`.

Pitch and roll are deliberately not replicated. `FR-1.14` requires only position and
orientation; `FR-4.4` requires facing precise enough to drive directional audio, which yaw
provides. Head pitch, if ever added for avatars, is presentation and does not belong on the hot
path.

**Yaw 0 faces −Z.** Yaw increases counter-clockwise, so π/2 faces −X.

### Position origin and bounds

The origin is wherever the map author placed it; it carries no meaning. World bounds are
declared in the Map Document.

**Bounds are constrained by the wire format.** Positions are quantized to `i16` centimetres
(see [wire-protocol.md](../protocol/wire-protocol.md)), giving a hard range of **±327.67 m** on
each axis. A map exceeding that cannot be represented. The Phase 9 editor must reject or warn on
out-of-range geometry.

---

## Scale reference

| Quantity                                           | Value                      |
| -------------------------------------------------- | -------------------------- |
| Avatar height                                      | 1.7 m                      |
| Avatar collision radius                            | 0.3 m                      |
| Eye height (first-person reference, camera target) | 1.6 m                      |
| Doorway clearance (authoring guidance)             | ≥ 1.0 m wide, ≥ 2.1 m tall |
| Comfortable corridor width                         | ≥ 1.5 m                    |

Assets authored against these read correctly next to an avatar. A world modelled at the wrong
scale is the most common and most disorienting asset defect, and it is not obvious until
somebody stands next to a door.

---

## Precision and quantization

The wire format trades precision for bandwidth. Both sides must agree on the error budget.

| Quantity            | Wire type          | Resolution                 | Range       |
| ------------------- | ------------------ | -------------------------- | ----------- |
| Position (per axis) | `i16`, centimetres | 0.01 m                     | ±327.67 m   |
| Yaw                 | `u8`               | 2π/256 ≈ 0.0245 rad ≈ 1.4° | full circle |

Consequences that must be designed around, not discovered:

- A remote avatar's position is never more accurate than 1 cm. Anything requiring finer
  agreement — precise object alignment, for instance — cannot rely on replicated transforms.
- 1.4° of yaw error is inaudible for spatial panning and invisible at conversational distance.
- **Quantize before comparing.** Interest-set membership and zone occupancy are computed
  server-side from the _received, already-quantized_ value. Computing locally from an
  unquantized value can produce a different answer at a boundary.

---

## Time

- **Wall-clock timestamps** are UTC, milliseconds since the Unix epoch, transmitted as JSON
  numbers. Used for chat (`FR-5.7`) and audit records (`FR-7.19`).
- **Simulation timing** uses monotonic time. The client interpolation buffer and the server tick
  must never depend on wall-clock, which can jump.
- **Clock skew is not corrected.** Clients are not assumed to agree on time. Nothing in Phases
  1–5 requires it; interpolation is driven by arrival order and local monotonic time.

---

## Camera

No phase spec defines the camera. `FR-1.9` requires moving in the horizontal plane and changing
facing; `FR-4.4` requires facing to drive directional audio. What the user actually _sees_ is
undefined, and it determines the input mapping, the framing of nameplates, and whether Phase 4's
avatar customization is worth building at all.

### Decision: third-person orbital

The camera orbits a target at eye height on the local avatar.

| Property         | Value                                 |
| ---------------- | ------------------------------------- |
| Target           | local avatar, 1.6 m above ground      |
| Default distance | 4.0 m                                 |
| Distance range   | 1.5 m – 8.0 m (mouse wheel)           |
| Default pitch    | 15° below horizontal                  |
| Pitch clamp      | −5° to +60° (positive = looking down) |
| Yaw              | free, 360°                            |
| Field of view    | 60° vertical                          |
| Near / far plane | 0.1 m / 500 m                         |

**Rationale.** You see your own avatar, which is what makes Phase 4's customization, emotes and
speaking indicator meaningful. It also gives the peripheral awareness a social space needs —
noticing someone approaching from the side is how proximity conversation starts.

### Input mapping

| Input                     | Action                       |
| ------------------------- | ---------------------------- |
| `W` `A` `S` `D` / arrows  | move, relative to camera yaw |
| `Shift` (held)            | run                          |
| `Space`                   | jump, if enabled by the map  |
| Mouse drag / pointer lock | orbit camera                 |
| Mouse wheel               | zoom                         |
| `Esc`                     | release pointer lock         |

Movement is **camera-relative**: pressing forward moves the avatar away from the camera, and the
avatar turns to face its movement direction. Avatar yaw follows movement direction, not camera
yaw, so standing still and orbiting the camera does not spin the avatar — and therefore does not
spin other people's spatial audio panning.

### Camera collision

The camera must not pass through geometry. Cast from the target toward the desired position; on
a hit, pull in to just before the contact point. Without this, orbiting near a wall puts the
camera outside the room and the player sees through the world.

### Open for later phases

First-person is a plausible future toggle — it suits `FR-2.10`'s directional audio especially
well. It is not in scope now: it doubles the camera, nameplate-framing and camera-collision test
surface, and it hides the avatar that Phase 4 exists to make expressive.

---

## Related

- [tuning-defaults.md](tuning-defaults.md) — the numbers that are meant to change
- [wire-protocol.md](../protocol/wire-protocol.md) — how these values are encoded
- [map-document.md](../protocol/map-document.md) — how worlds declare bounds and spawns
- [ADR 0004](../../docs/adr/0004-client-authoritative-movement-aoi.md) · [ADR 0005](../../docs/adr/0005-physics-rapier-client-only.md)
