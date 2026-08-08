# Phase 4 — Avatars & Identity Presentation

## Overview

**Goal.** Replace placeholder representations with expressive 3D avatars: animated,
customizable, with nameplates, status, speaking indicators, and emotes.

**Value.** Avatars are how presence becomes personal. Movement reads as walking, speaking
is visible, status is legible, and people can express themselves — all of which make the
space feel alive and socially usable.

**Depends on.** Phase 1 (participants, transforms, status), Phase 2 (speaking signal).

**Delivers.** Each participant is a recognizable 3D character that walks/idles/runs with
animation, shows who's talking, displays a name and status, can be customized, and can play
emotes/reactions that others see.

---

## In scope

- 3D avatar representation and locomotion animation.
- Avatar customization (selectable appearance).
- Nameplates and status indicators.
- Visual speaking indicator (consuming Phase 2's signal).
- Emotes/reactions, replicated to others.
- Facing/look direction that supports directional audio and natural orientation.
- Persisting a participant's chosen avatar to their (ephemeral or, later, durable) identity.

## Out of scope

- Avatar authoring/upload pipeline for custom models (asset pipeline is Phase 9).
- Identity accounts/profiles persistence backend (Phase 6) — this phase defines what an
  avatar selection _is_ and that it persists where identity persists.

---

## Functional Requirements

### Avatar representation & animation

- **FR-4.1** Each participant is rendered as a 3D avatar at their replicated transform.
- **FR-4.2** The avatar plays appropriate animation states driven by movement: at minimum
  idle and walk; recommended: run and an in-air/jump state if movement supports it.
- **FR-4.3** Animation transitions are smooth (no popping between states) and stay in sync
  with the avatar's actual motion (feet match speed/direction reasonably).
- **FR-4.4** The avatar's facing/heading reflects the participant's orientation from Phase 1,
  and is precise enough to drive directional audio (Phase 2, FR-2.10).

### Customization

- **FR-4.5** A user can customize their avatar's appearance from a set of options (e.g., body,
  hair, clothing, color — exact option taxonomy left to design).
- **FR-4.6** A user's customization is reflected to all other participants who can see them.
- **FR-4.7** Customization changes can be made and take effect without leaving the world (a
  re-spawn or instant swap is acceptable).
- **FR-4.8** A participant's chosen customization persists with their identity: for guests, for
  the session; once accounts exist (Phase 6), across sessions.

### Nameplates & status

- **FR-4.9** Each avatar displays a nameplate with the participant's display name, legible at a
  reasonable distance and unobtrusive when far.
- **FR-4.10** The avatar visibly reflects activity status (e.g., active vs. idle) and a
  do-not-disturb/away status if set.
- **FR-4.11** A participant can set themselves to a status such as available / away /
  do-not-disturb, visible to others via the avatar/nameplate.

### Speaking indicator

- **FR-4.12** When a participant is speaking (Phase 2 signal), their avatar/nameplate shows a
  clear speaking indicator to nearby viewers.
- **FR-4.13** A muted participant never shows the speaking indicator.

### Emotes & reactions

- **FR-4.14** A participant can trigger an emote/reaction (e.g., wave, thumbs-up, dance,
  emoji burst).
- **FR-4.15** Emotes are replicated to and visible by other participants who can see the avatar.
- **FR-4.16** Emotes are time-bounded (play and end) and do not permanently alter the avatar or
  block normal movement/animation.

---

## Data Concepts

- **DC-4.1 Avatar Appearance** — the set of customization selections defining how a participant
  looks; attached to identity.
- **DC-4.2 Animation State** — the current locomotion/expression state derived from movement and
  triggered actions.
- **DC-4.3 Presence Status** — available | away | do-not-disturb | idle, shown on the avatar.
- **DC-4.4 Emote** — a named, time-bounded expressive action that can be triggered and replicated.

---

## Rules & Edge Cases

- Avatar appearance must replicate to participants who enter another's area of interest after a
  customization change (late joiners see the current look).
- Speaking indicators must track the real-time signal without noticeable lag or sticking "on."
- Emote spam must be reasonable to manage (e.g., a minimum interval) so it can't flood others.
- Nameplates and indicators must remain readable in crowds (avoid total overlap occlusion where
  feasible).
- Status changes replicate like any other participant state.

---

## Acceptance Criteria

- **AC-4.1** A walking avatar shows walk animation; a standing one shows idle; transitions look smooth.
- **AC-4.2** Changing customization is visible to other participants promptly, including to someone
  who walks up afterward.
- **AC-4.3** Speaking shows an indicator on the speaker's avatar for nearby viewers; muting removes it.
- **AC-4.4** Setting do-not-disturb/away is reflected on the avatar/nameplate to others.
- **AC-4.5** Triggering an emote plays it on the local avatar and on remote views of that avatar,
  then ends cleanly.
- **AC-4.6** Avatar facing visibly matches movement/look direction and is consistent with where the
  participant's audio is panned (if directional audio is enabled).

---

## Non-Goals & Deferred

- Uploading fully custom avatar models/skeletons (depends on the asset pipeline, Phase 9).
- Durable cross-session persistence of appearance requires accounts (Phase 6); until then,
  per-session persistence is sufficient.
- **Deferred decisions:** avatar/animation format and the customization option taxonomy are
  chosen later; this spec fixes behavior, not representation.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### Format

**VRM** via `@pixiv/three-vrm`, with **Mixamo** animations retargeted onto it
([ADR 0010](../docs/adr/0010-3d-formats-gltf-vrm.md)).

VRM is an open standard layered on glTF that fixes the humanoid bone hierarchy — and that fixed
hierarchy is the whole point: it is what makes one animation set drive every avatar. VRoid Studio
lets non-artists create models, and a large free library already exists.

Phase 1 shipped a placeholder capsule. This phase replaces it.

The third-person camera chosen in
[coordinates-and-units.md](conventions/coordinates-and-units.md#camera) is what makes this phase
worth building — you see your own avatar, so customization and emotes are visible to their owner.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-4.1`             | VRM instance per participant at the replicated transform                                                                                                                                                                                                                                      |
| `FR-4.2`             | `AnimationMixer` with idle / walk / run / jump clips, selected by planar speed against `RUN_ANIMATION_THRESHOLD_MPS`                                                                                                                                                                          |
| `FR-4.3`             | `crossFadeTo` over `ANIMATION_CROSSFADE_MS` (200 ms); playback rate scaled to actual speed so feet don't skate                                                                                                                                                                                |
| `FR-4.4`             | Yaw from the Phase 1 transform — already 1.4° precision, which is far finer than panning needs ([coordinates-and-units.md](conventions/coordinates-and-units.md))                                                                                                                             |
| `FR-4.5`             | `AvatarAppearance` = `{ baseModel, colors, accessories }`. Customization is base-model choice plus material and texture swaps on the VRM                                                                                                                                                      |
| `FR-4.6`             | Appearance travels on `PARTICIPANT_UPDATE` (JSON), never the hot path                                                                                                                                                                                                                         |
| `FR-4.7`             | Instant swap — dispose the old VRM, instantiate the new one at the current transform. No respawn needed                                                                                                                                                                                       |
| `FR-4.8`             | Session memory for guests now; `profiles.avatar_appearance jsonb` once Phase 6 exists. This is exactly the progression the requirement describes                                                                                                                                              |
| `FR-4.9`             | drei `<Billboard>` + `<Text>` (troika), fading from `NAMEPLATE_FADE_START_M` (15 m) and hidden past `NAMEPLATE_HIDE_M` (25 m). GPU text rather than `<Html>`: a DOM overlay costs a layout recalculation per avatar per frame, which is measurable at the 15 visible avatars `NFR-11` targets |
| `FR-4.10`, `FR-4.11` | `SET_STATUS` frame; `idle` remains server-derived and unsettable by clients (`FR-1.22`)                                                                                                                                                                                                       |
| `FR-4.12`, `FR-4.13` | LiveKit `isSpeaking` drives a ring on the nameplate. A muted mic publishes no track at all, so no signal can exist — `FR-4.13` holds structurally rather than by a check                                                                                                                      |
| `FR-4.14`–`FR-4.16`  | `EMOTE` frame → server throttle → `EMOTE_PLAY` broadcast. Time-bounded by `EMOTE_MAX_DURATION_MS`; plays on an additive layer so movement animation is not blocked                                                                                                                            |

### Rules

- **Appearance replicates to late arrivals.** It is part of the `SNAPSHOT` and
  `PARTICIPANT_ADD` payloads, so someone walking up after a change sees the current look.
- **Emote throttling is enforced on the server.** `EMOTE_MIN_INTERVAL_MS` (2 s) is checked in
  `api`; excess is dropped silently rather than errored. Client-side throttling is a courtesy —
  the anti-spam rule is a guarantee, and guarantees do not live in the client.
- **Nameplate occlusion in crowds:** sort by distance and fade the further ones; do not attempt
  full de-overlap layout, which is expensive and jitters.
- **Speaking indicator must not stick on.** Drive it from LiveKit's event, with a short decay, not
  a manual timer.

### Risks and sharp edges

1. **Mixamo → VRM retargeting is manual.** Different bone names, different rest pose, different
   hip height. The mapping and scaling are written once and documented — this is the known sharp
   edge of the phase and it is better hit deliberately than discovered.
2. **VRM instances are expensive.** Load each base model once and clone with `SkeletonUtils.clone`;
   never re-parse the file per participant.
3. **Dispose on removal.** When someone leaves area of interest, dispose their VRM's geometries,
   materials and textures. Fifteen avatars appearing and disappearing without disposal breaches
   `NFR-14` within the hour.
4. **`vrm.update(delta)` must run every frame** for spring bones and look-at. Missing it produces
   avatars that look subtly dead.
5. **VRM constrains avatars to bipeds.** Acceptable for a virtual office; worth knowing before
   someone asks for a robot dog.

### References

[ADR 0010](../docs/adr/0010-3d-formats-gltf-vrm.md) ·
[ADR 0002](../docs/adr/0002-client-threejs-r3f-vite.md) ·
[coordinates-and-units.md](conventions/coordinates-and-units.md#camera) ·
[tuning-defaults.md](conventions/tuning-defaults.md) ·
[wire-protocol.md](protocol/wire-protocol.md)
