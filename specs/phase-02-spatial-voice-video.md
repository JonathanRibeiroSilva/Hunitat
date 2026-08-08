# Phase 2 — Spatial Voice & Video

## Overview

**Goal.** Participants hear and see each other based on 3D proximity: nearby people are
loud and visible, distant people fade out and drop off.

**Value.** This is _the_ defining feature of a Gather-style space — conversations form
naturally by walking up to people. Without it, the product is just a 3D chat room.

**Depends on.** Phase 1 (presence, positions, proximity inputs).

**Delivers.** When two participants walk near each other, their microphones and cameras
connect; volume rises as they approach and falls as they part; beyond a threshold they
disconnect. Many participants can be in the same world without everyone streaming to
everyone.

---

## In scope

- Capturing and publishing local microphone and camera.
- Determining who can hear/see whom from 3D positions.
- Distance-based volume falloff and optional directional audio.
- Dynamically connecting/disconnecting media streams as people move.
- Scaling beyond a tiny group (not every participant streams to every other).
- Screen sharing.
- Producing the "is speaking" signal other phases visualize.

## Out of scope

- Zone-based overrides of proximity (private/spotlight) — Phase 3.
- Avatar speaking-indicator visuals — Phase 4 (this phase only emits the signal).
- Recording, transcription, virtual backgrounds.
- Force-mute / moderation controls — Phase 7.

---

## Functional Requirements

### Local capture & device control

- **FR-2.1** A user can grant access to and publish their microphone and camera.
- **FR-2.2** A user can select among available input devices (microphone, camera) and
  switch them while connected.
- **FR-2.3** A user can mute/unmute their microphone and turn their camera on/off at any
  time, with immediate local feedback.
- **FR-2.4** A user sees a self-view of their own camera.
- **FR-2.5** The system surfaces a clear state when device permission is denied or no device
  is available, without breaking presence.

### Proximity determination

- **FR-2.6** The system continuously determines, for each participant, the set of other
  participants currently within hearing/seeing range based on 3D distance.
- **FR-2.7** Range thresholds are configurable (e.g., a max audible distance and a max
  visible distance, which may differ).
- **FR-2.8** As participants move, membership of these proximity sets updates promptly.

### Spatial audio behavior

- **FR-2.9** A remote participant's audio volume attenuates with distance following a
  configurable falloff (full volume when close, fading to silence at the threshold).
- **FR-2.10** (Optional, recommended) Audio is positioned/panned according to the remote
  participant's direction relative to the listener's position and facing, for a sense of
  where a voice comes from.
- **FR-2.11** Beyond the audible threshold a remote participant is inaudible and their audio
  stream is not consumed.

### Spatial video behavior

- **FR-2.12** A remote participant's video is presented when within visible range and removed
  when out of range.
- **FR-2.13** Video presentation (e.g., participant tiles and/or near-avatar display) reflects
  who is currently within visible range.

### Dynamic connection management

- **FR-2.14** When two participants come within range, their media connects automatically
  (no manual "call"); when they leave range, it disconnects automatically.
- **FR-2.15** Connecting/disconnecting media as people move must not cause audible/visible
  glitches for unrelated participants.
- **FR-2.16** A participant only consumes the media of those currently relevant to them, not
  of everyone in the world.

### Scalability

- **FR-2.17** The media architecture must support many participants in one world without
  requiring each participant to stream directly to every other participant.
- **FR-2.18** Under constrained bandwidth or many nearby participants, the system degrades
  gracefully (e.g., reduce video quality, prioritize audio, drop the most distant video first)
  rather than failing the whole session.

### Screen sharing

- **FR-2.19** A participant can share a screen/window as an additional stream, subject to the
  same proximity visibility rules (or to zone rules once Phase 3 exists).
- **FR-2.20** Only one obvious presenter stream per participant is required; viewers within
  range receive it.

### Signals for other phases

- **FR-2.21** The system emits a per-participant "currently speaking" signal derived from
  microphone activity, consumable by other phases (e.g., avatar indicators, UI).

---

## Data Concepts

- **DC-2.1 Media Session** — a participant's live publishing state: which tracks are on
  (mic/cam/screen), device selection, mute/camera state.
- **DC-2.2 Track** — one stream of a kind (audio, camera video, screen video) belonging to a
  participant.
- **DC-2.3 Proximity Set** — for a given listener/viewer, the current set of other
  participants in audible range and in visible range, with per-target attenuation factors.
- **DC-2.4 Speaking Signal** — per-participant boolean/level indicating active speech.

---

## Rules & Edge Cases

- A muted microphone must publish nothing and must never produce a speaking signal.
- Falloff and thresholds must be tunable independently of feature code.
- Rapid in/out at a range boundary must not thrash connections (apply hysteresis).
- Self audio is never played back to the speaker.
- If media for one remote participant fails, it must not tear down media with others.
- Directional audio (FR-2.10) is optional; if omitted, distance attenuation (FR-2.9) is still
  required.

---

## Acceptance Criteria

- **AC-2.1** Two participants walking toward each other hear each other get louder; walking
  apart, quieter; past the threshold, silent.
- **AC-2.2** Video for a remote participant appears within visible range and disappears beyond it.
- **AC-2.3** No manual call/accept step is needed — proximity alone connects and disconnects media.
- **AC-2.4** With many participants spread out, any one client is only sending/receiving media
  for nearby participants (verified by inspecting active streams).
- **AC-2.5** Muting the mic stops outbound audio and clears the speaking signal immediately.
- **AC-2.6** A screen share is visible to in-range participants and stops cleanly when ended.
- **AC-2.7** Moving through a crowd does not cause audio dropouts for bystanders.

---

## Non-Goals & Deferred

- Private/spotlight zone overrides (Phase 3) — here, proximity is the only rule.
- Visual speaking indicators on avatars (Phase 4).
- Moderation mute/disable (Phase 7).
- Recording/transcription/backgrounds — not planned.
- **Deferred decisions:** how media is routed/relayed at scale, codecs, and quality-adaptation
  mechanisms are chosen later. This spec only requires the _behavior_.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The split that makes this work

`FR-2.17` rules out a peer-to-peer mesh, so an SFU is required: **LiveKit**, self-hosted
([ADR 0006](../docs/adr/0006-media-livekit-sfu.md)). One World Instance = one LiveKit Room.

The division of labour matters more than the choice of SFU:

- **The server decides who hears whom.** Proximity is computed on the 20 Hz tick by
  `resolveAudience()` in `world-core`, and pushed to each client as an `AUDIENCE` frame.
- **The client applies it**, calling `setSubscribed()` per track. Subscription churn is a client
  operation against the SFU, so walking past someone doesn't cost a server round-trip.
- **Gain and panning are computed in the browser** via Web Audio
  ([ADR 0007](../docs/adr/0007-spatial-audio-web-audio.md)) — because attenuation is
  _per-listener_, and a server could only produce it by mixing a separate stream per person,
  which would turn the SFU into an MCU and destroy the property `FR-2.17` exists to protect.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-2.1`, `FR-2.2`   | LiveKit `createLocalTracks`; device switching via `switchActiveDevice`                                                                                                       |
| `FR-2.3`             | `setMicrophoneEnabled` / `setCameraEnabled`, with local UI state updated optimistically                                                                                      |
| `FR-2.4`             | Local track rendered without going through the SFU                                                                                                                           |
| `FR-2.5`             | `NotAllowedError` and `NotFoundError` from `getUserMedia` map to distinct UI states; presence is unaffected                                                                  |
| `FR-2.6`, `FR-2.8`   | `resolveAudience()` on the server tick, from already-quantized positions                                                                                                     |
| `FR-2.7`             | `MAX_AUDIBLE_DISTANCE_M` (12) and `MAX_VISIBLE_DISTANCE_M` (8), independent, in [tuning-defaults.md](conventions/tuning-defaults.md)                                         |
| `FR-2.9`             | `PannerNode` with `distanceModel: 'inverse'`, `refDistance` 1 m, `rolloffFactor` 1.2                                                                                         |
| `FR-2.10`            | `panningModel: 'HRTF'`; panner position from the remote transform, `AudioListener` from the local avatar and camera, updated per frame                                       |
| `FR-2.11`            | **Both** the subscription is dropped _and_ gain reaches zero. Gain alone leaves the stream flowing — silence still costs bandwidth                                           |
| `FR-2.12`, `FR-2.13` | Video subscription follows the visible set; tiles and near-avatar display read the same set                                                                                  |
| `FR-2.14`            | No call/accept step exists in the protocol at all                                                                                                                            |
| `FR-2.15`            | Subscription changes are per-viewer against the SFU; unrelated participants are untouched by construction                                                                    |
| `FR-2.16`            | Selective subscription — the whole reason for choosing LiveKit                                                                                                               |
| `FR-2.17`            | SFU by definition                                                                                                                                                            |
| `FR-2.18`            | Simulcast layers chosen by distance, plus `MAX_CONCURRENT_VIDEO` (6) and `MAX_CONCURRENT_AUDIO` (12). Most distant video is shed first; **audio is never dropped for video** |
| `FR-2.19`, `FR-2.20` | `setScreenShareEnabled` as a distinct track source, subject to the same audience set                                                                                         |
| `FR-2.21`            | LiveKit `ActiveSpeakersChanged` / `isSpeaking` — no voice-activity detection to build                                                                                        |

### Rules

- **A muted mic publishes nothing.** `setMicrophoneEnabled(false)` unpublishes the track rather
  than gating it, so no speaking signal can be produced — which is what the rule requires.
- **Hysteresis on range**, `AUDIO_HYSTERESIS_M` (2 m), or standing at 12 m thrashes subscriptions.
- **Self audio is never played back**; the local track is rendered for self-view video only.
- **One participant's media failure is isolated** — per-track error handling, never a room-level
  teardown.

### Risks and sharp edges

1. **Chrome will not feed a WebRTC track into Web Audio** unless the track is also attached to a
   playing media element. Attach every remote audio track to a muted, autoplaying, off-screen
   `<audio>` element and route the graph in parallel. Without this the audio graph runs and
   produces silence — and it presents as a spatial-audio maths bug, not a plumbing bug.
2. **`AudioContext` starts suspended** until a user gesture. Resume it in the join flow.
3. **Panner and listener updates belong in `useFrame`**, mutating nodes directly. Never through
   React state.
4. **Safari's `PannerNode` orientation has historically diverged** from Chrome. Verify spatial
   audio there specifically (`NFR-27`).
5. **`resolveAudience()` is shared, not duplicated.** Phase 3 extends it with zones and Phase 5
   reuses it for chat scoping. Writing a second proximity check anywhere breaks the consistency
   guarantee those phases depend on.
6. **TURN** is needed on restrictive NATs. `coturn` is declared optional in Compose.

### Verification

`AC-2.1`–`AC-2.7` are verified manually — automated testing of spatial audio quality is not
practical. The harness can assert the _server's_ audience computation (who should hear whom at
given positions), which is where the logic errors actually live; whether it _sounds_ right is a
human check.

### References

[ADR 0006](../docs/adr/0006-media-livekit-sfu.md) ·
[ADR 0007](../docs/adr/0007-spatial-audio-web-audio.md) ·
[architecture.md](../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320) ·
[tuning-defaults.md](conventions/tuning-defaults.md) ·
[nfr.md](nfr.md)
