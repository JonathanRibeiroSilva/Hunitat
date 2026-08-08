# Convention — Tuning Defaults

**Status:** normative (defaults) · **Applies to:** all phases

The phase specs say _"configurable"_ roughly fifteen times and never give a number. That is
correct for a technology-neutral spec and useless for building. This document supplies the
defaults.

Several phases also carry a hard rule: values must be adjustable **without code changes to
feature logic** (Phase 1 Rules, `FR-2.7`, Phase 5 Rules). So these are not constants scattered
through the source. They are defined once in `packages/protocol`, exposed through
`@nestjs/config` on the server and Vite env on the client, and read by name.

Structural values that cannot be tuned — coordinate system, quantization, scale — live in
[coordinates-and-units.md](coordinates-and-units.md).

---

## Realtime and replication — Phase 1

| Key                        | Default | Range          | Requirement               |
| -------------------------- | ------- | -------------- | ------------------------- |
| `TICK_RATE_HZ`             | 20      | 10–30          | `FR-1.12`                 |
| `CLIENT_SEND_RATE_HZ`      | 20      | 10–30          | `FR-1.11`, `FR-1.12`      |
| `INTERPOLATION_BUFFER_MS`  | 100     | 60–200         | `FR-1.13`                 |
| `AOI_ENTER_RADIUS_M`       | 25      | 10–60          | `FR-1.16`                 |
| `AOI_EXIT_RADIUS_M`        | 30      | > enter        | `FR-1.17`, anti-flap rule |
| `AOI_CELL_SIZE_M`          | 25      | ≈ enter radius | `FR-1.16`                 |
| `PING_INTERVAL_MS`         | 10000   | 5000–30000     | `FR-1.6`                  |
| `STALE_SESSION_TIMEOUT_MS` | 30000   | > 2 × ping     | `FR-1.6`                  |
| `IDLE_TIMEOUT_MS`          | 60000   | 30000–300000   | `FR-1.22`                 |
| `RESUME_TOKEN_TTL_MS`      | 60000   | 15000–300000   | `FR-1.5`                  |
| `MAX_BUFFERED_BYTES`       | 65536   | 16384–262144   | backpressure              |

**`AOI_ENTER_RADIUS_M` and `AOI_EXIT_RADIUS_M` are a pair.** The gap is the hysteresis that
prevents the boundary flapping both the Phase 1 and Phase 3 rules forbid. Setting them equal
reintroduces the bug. The default 25/30 is a 20% band.

**`STALE_SESSION_TIMEOUT_MS` must strictly exceed two ping intervals**, or a single dropped pong
evicts a healthy session. The heartbeat terminates a socket that misses a full ping cycle, so
worst-case detection is 2 × the interval and this value is the documented outer bound. The server
validates the relationship at boot and refuses to start otherwise — a misconfiguration here
presents as random disconnections, which is not a symptom anyone traces back to config.

**`INTERPOLATION_BUFFER_MS` trades smoothness for lag.** At 20 Hz the tick interval is 50 ms, so
100 ms absorbs two missed updates. Below ~60 ms, normal jitter produces the stutter `AC-1.2`
prohibits.

---

## Movement — Phases 1, 4

| Key                          | Default | Range    | Requirement |
| ---------------------------- | ------- | -------- | ----------- |
| `WALK_SPEED_MPS`             | 3.0     | 1.5–5.0  | `FR-1.9`    |
| `RUN_SPEED_MPS`              | 6.0     | > walk   | `FR-4.2`    |
| `ACCELERATION_MPS2`          | 25.0    | 10–50    | `FR-1.11`   |
| `JUMP_HEIGHT_M`              | 0.9     | 0–1.5    | `FR-4.2`    |
| `GRAVITY_MPS2`               | −9.81   | —        | `FR-1.19`   |
| `CHARACTER_STEP_OFFSET_M`    | 0.35    | 0.1–0.5  | `FR-3.5`    |
| `CHARACTER_SLOPE_LIMIT_DEG`  | 45      | 30–60    | `FR-1.19`   |
| `CHARACTER_SNAP_TO_GROUND_M` | 0.2     | 0.05–0.5 | `FR-1.19`   |

3.0 m/s is faster than a real walk (~1.4 m/s). Realistic speed feels sluggish in a virtual space
where crossing a room is a chore, not a stroll.

`CHARACTER_STEP_OFFSET_M` lets the controller climb small ledges without a jump. Too low and
avatars snag on door thresholds; too high and they walk up walls.

---

## Spatial media — Phase 2

| Key                      | Default   | Range                            | Requirement              |
| ------------------------ | --------- | -------------------------------- | ------------------------ |
| `MAX_AUDIBLE_DISTANCE_M` | 12        | 5–30                             | `FR-2.7`, `FR-2.11`      |
| `MAX_VISIBLE_DISTANCE_M` | 8         | 3–20                             | `FR-2.7`, `FR-2.12`      |
| `AUDIO_HYSTERESIS_M`     | 2         | 1–5                              | Phase 2 anti-thrash rule |
| `AUDIO_DISTANCE_MODEL`   | `inverse` | `inverse`/`linear`/`exponential` | `FR-2.9`                 |
| `AUDIO_REF_DISTANCE_M`   | 1.0       | 0.5–3.0                          | `FR-2.9`                 |
| `AUDIO_ROLLOFF_FACTOR`   | 1.2       | 0.5–3.0                          | `FR-2.9`                 |
| `AUDIO_PANNING_MODEL`    | `HRTF`    | `HRTF`/`equalpower`              | `FR-2.10`                |
| `MAX_CONCURRENT_AUDIO`   | 12        | 4–24                             | `FR-2.18`                |
| `MAX_CONCURRENT_VIDEO`   | 6         | 2–12                             | `FR-2.18`                |
| `SPEAKING_THRESHOLD_DB`  | −45       | −60 to −30                       | `FR-2.21`                |

Audible exceeds visible deliberately: you hear a conversation before you can make out faces,
which is how a room works and how people find each other.

`MAX_CONCURRENT_VIDEO` is the primary degradation lever for `FR-2.18`. When exceeded, the most
distant video is dropped first; audio is never dropped for video.

---

## Zones — Phase 3

| Key                       | Default | Range    | Requirement             |
| ------------------------- | ------- | -------- | ----------------------- |
| `ZONE_HYSTERESIS_M`       | 0.3     | 0.1–1.0  | Phase 3 edge-flap rule  |
| `PORTAL_COOLDOWN_MS`      | 1500    | 500–5000 | Phase 3 re-trigger rule |
| `PORTAL_EXIT_CLEARANCE_M` | 1.5     | 0.5–3.0  | Phase 3 re-trigger rule |
| `SPOTLIGHT_GAIN`          | 1.0     | 0.5–1.0  | `FR-3.12`               |
| `PRIVATE_ZONE_GAIN`       | 1.0     | 0.5–1.0  | `FR-3.8`                |

`PORTAL_COOLDOWN_MS` and `PORTAL_EXIT_CLEARANCE_M` both address the same rule — a participant
must not immediately re-trigger the portal they arrived through. Clearance is the primary
mechanism; the cooldown is the safety net for tightly-placed portals.

---

## Avatars — Phase 4

| Key                           | Default | Range                | Requirement         |
| ----------------------------- | ------- | -------------------- | ------------------- |
| `EMOTE_MIN_INTERVAL_MS`       | 2000    | 500–10000            | `FR-4.16` anti-spam |
| `EMOTE_MAX_DURATION_MS`       | 5000    | 1000–15000           | `FR-4.16`           |
| `ANIMATION_CROSSFADE_MS`      | 200     | 100–400              | `FR-4.3`            |
| `RUN_ANIMATION_THRESHOLD_MPS` | 4.0     | between walk and run | `FR-4.2`            |
| `NAMEPLATE_FADE_START_M`      | 15      | 5–30                 | `FR-4.9`            |
| `NAMEPLATE_HIDE_M`            | 25      | ≤ AOI enter radius   | `FR-4.9`            |

`EMOTE_MIN_INTERVAL_MS` is enforced **on the server**. Client-side throttling is a courtesy; the
anti-spam rule is a guarantee.

---

## Chat — Phase 5

| Key                           | Default | Range                      | Requirement              |
| ----------------------------- | ------- | -------------------------- | ------------------------ |
| `CHAT_NEARBY_RADIUS_M`        | 12      | = `MAX_AUDIBLE_DISTANCE_M` | Phase 5 consistency rule |
| `CHAT_MAX_MESSAGE_CHARS`      | 2000    | 500–8000                   | —                        |
| `CHAT_HISTORY_LIMIT`          | 200     | 50–1000                    | `FR-5.12`                |
| `CHAT_HISTORY_RETENTION_DAYS` | 90      | 1–3650                     | `FR-5.11`                |
| `TYPING_INDICATOR_TTL_MS`     | 5000    | 2000–10000                 | `FR-5.10`                |
| `CHAT_RATE_LIMIT_PER_MIN`     | 30      | 10–120                     | —                        |

**`CHAT_NEARBY_RADIUS_M` defaults to `MAX_AUDIBLE_DISTANCE_M` and should track it.** The Phase 5
rule requires _"people I can talk to" ≈ "people my local chat reaches"_. Diverging them
knowingly is allowed; diverging them by accident is a bug.

---

## Accounts and sessions — Phase 6

| Key                        | Default | Range   | Requirement              |
| -------------------------- | ------- | ------- | ------------------------ |
| `ACCESS_TOKEN_TTL_MIN`     | 15      | 5–60    | `FR-6.17`                |
| `REFRESH_TOKEN_TTL_DAYS`   | 30      | 1–90    | `FR-6.17`                |
| `PASSWORD_MIN_LENGTH`      | 12      | ≥ 8     | `FR-6.3`                 |
| `ARGON2_MEMORY_KIB`        | 19456   | ≥ 19456 | `FR-6.3` (OWASP minimum) |
| `ARGON2_ITERATIONS`        | 2       | ≥ 2     | `FR-6.3`                 |
| `ARGON2_PARALLELISM`       | 1       | 1–4     | `FR-6.3`                 |
| `INVITE_DEFAULT_TTL_HOURS` | 168     | 1–8760  | `FR-6.14`                |
| `RESET_TOKEN_TTL_MIN`      | 30      | 10–120  | `FR-6.5`                 |

The argon2 parameters are the OWASP-recommended argon2id floor. Lowering them weakens `FR-6.3`.

---

## Capacity and instancing — Phases 7, 8

| Key                          | Default           | Range                            | Requirement         |
| ---------------------------- | ----------------- | -------------------------------- | ------------------- |
| `DEFAULT_MAP_CAPACITY`       | 50                | 2–200                            | `FR-7.14`, `FR-8.8` |
| `INSTANCE_ASSIGNMENT_POLICY` | `fill-then-spill` | `fill-then-spill`/`least-loaded` | `DC-8.4`            |
| `INSTANCE_REAP_AFTER_MS`     | 120000            | 30000–600000                     | `FR-8.11`           |
| `MAX_INSTANCES_PER_MAP`      | 8                 | 1–32                             | `FR-8.8`            |

`DEFAULT_MAP_CAPACITY` of 50 matches the scale this architecture was designed and verified
against. Raising it beyond that has not been validated — the server warns rather than refusing,
because raising it may well have been measured and the failure it produces (a tick over budget) is
visible on `/health`. Below **2** it refuses: a world nobody can ever be joined in is not a capacity
limit.

A Space may override it (`spaces.capacity`), which is why this is a default rather than the value.
The environment variable seeds the ceiling; a decision made through the moderation API wins, exactly
as `SPACE_ALLOW_GUESTS` relates to `spaces.allow_guests`.

Two more phase 7 values live in `packages/protocol` and deliberately have **no** environment
variable, for the reason `REFRESH_REUSE_LEEWAY_MS` has none:

| Constant               | Value  | Why it is not tunable                                                                                                                                    |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICK_COOLDOWN_MS`     | 10 000 | It is a debounce on a reconnect loop, not a sentence. Raised, it becomes a ban nobody recorded; lowered, `FR-7.7` loses to `NFR-23`'s 500 ms first retry |
| `MODERATION_PAGE_SIZE` | 100    | `FR-7.20` asks for review, not archaeology. An unbounded read of an append-only table gets slower for the life of the deployment                         |

`INSTANCE_REAP_AFTER_MS` prevents thrashing: an instance that briefly empties is not torn down
immediately. Instance index 0 is never reaped.

---

## Assets and editor — Phase 9

| Key                        | Default            | Range        | Requirement          |
| -------------------------- | ------------------ | ------------ | -------------------- |
| `ASSET_MAX_BYTES`          | 104857600 (100 MB) | 1–500 MB     | `FR-9.12`            |
| `ASSET_MAX_TRIANGLES`      | 500000             | —            | `FR-9.12`, `FR-9.13` |
| `ASSET_MAX_TEXTURE_PX`     | 2048               | 512–4096     | `FR-9.13`            |
| `ASSET_LOD_RATIOS`         | `[1.0, 0.5, 0.15]` | —            | `FR-9.13`            |
| `EDITOR_LOCK_TTL_MS`       | 60000              | 15000–300000 | `FR-9.22`            |
| `EDITOR_LOCK_HEARTBEAT_MS` | 20000              | ≤ TTL/2      | `FR-9.22`            |
| `MAP_VERSIONS_RETAINED`    | 50                 | 5–500        | `FR-9.19`            |
| `MAP_DOCUMENT_WARN_BYTES`  | 524288 (512 KB)    | —            | `FR-9.17`            |

`ASSET_MAX_BYTES` is a byte count rather than a megabyte count because it is checked in three
places that all deal in bytes — the presign call, the object HEAD after upload, and the worker's
parse — and a unit conversion at each would be three chances to be off by 1024.

The LOD ladder **includes the original as `1.0`**, so the array describes every level rather than
only the extra ones; the pipeline skips any ratio at or above one. `ASSET_LOD_LEVELS` is therefore
`ASSET_LOD_RATIOS.length` and is not a separate value that could disagree with it.

`MAP_DOCUMENT_WARN_BYTES` is where the editor starts saying a document is getting large. A
warning rather than a refusal: a big map may be deliberate, and the document is read on every
arrival and sent to every client, so the number needs to be on screen before it becomes a problem
nobody saw coming. The hard refusal is eight times it.

---

## Interactive objects — Phase 10

| Key                             | Default         | Range      | Requirement          |
| ------------------------------- | --------------- | ---------- | -------------------- |
| `INTERACT_RANGE_M`              | 2.5             | 1.0–6.0    | `FR-10.2`, `FR-10.4` |
| `YJS_PERSIST_DEBOUNCE_MS`       | 5000            | 1000–30000 | `FR-10.16`           |
| `VIDEO_SYNC_DRIFT_TOLERANCE_MS` | 500             | 200–2000   | `FR-10.10`           |
| `YJS_COMPACT_ABOVE_BYTES`       | 524288 (512 KB) | —          | `FR-10.16`           |

`INTERACT_RANGE_M` is a default; `DC-10.1` allows per-object overrides. `FR-10.4` requires it to
feel consistent, so overrides should be rare and deliberate. The **channel** check at `/collab`
uses the range plus one metre, so stepping back mid-stroke does not close the socket under
somebody.

`YJS_COMPACT_ABOVE_BYTES` is the size at which a shared object's snapshot is re-encoded through a
fresh document before being written. A CRDT retains history, so a long-lived whiteboard's snapshot
grows without bound and nothing about the data structure will ever shrink it — compaction discards
the history (cross-session undo goes with it, which nobody expects to survive a week) and keeps the
content.

---

## Limits and safety — all phases

| Key                        | Default | Range      | Rationale                              |
| -------------------------- | ------- | ---------- | -------------------------------------- |
| `MAX_MESSAGE_BYTES`        | 4096    | 1024–65536 | reject oversized frames before parsing |
| `MAX_INBOUND_MSGS_PER_SEC` | 60      | 20–200     | per connection                         |
| `MAX_DISPLAY_NAME_CHARS`   | 32      | 8–64       | `FR-1.2`                               |
| `WS_HANDSHAKE_TIMEOUT_MS`  | 10000   | 3000–30000 | drop connections that never join       |

The transport is binary and the movement model is trusting ([ADR 0004](../../docs/adr/0004-client-authoritative-movement-aoi.md)),
so these limits are the only thing standing between the gateway and a malformed or hostile
client. They apply even though Phase 1 has no authentication.

---

## Related

- [coordinates-and-units.md](coordinates-and-units.md) — the values that are _not_ tunable
- [nfr.md](../nfr.md) — the performance targets these defaults are meant to achieve
- [wire-protocol.md](../protocol/wire-protocol.md)
