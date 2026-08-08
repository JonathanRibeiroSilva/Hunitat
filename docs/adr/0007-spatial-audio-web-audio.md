# ADR 0007 — Spatial audio in the client via Web Audio `PannerNode`

**Status:** accepted · **Affects:** phases 2, 3, 4

## Context

`FR-2.9` requires volume to attenuate with distance along a configurable falloff. `FR-2.10`
recommends positioning audio according to the speaker's direction relative to the listener's
position _and facing_, so a voice comes from where the person is.

Both change continuously as two people walk around each other. Whatever computes them runs at
frame rate, per listener, per speaker.

That last clause decides the question. Attenuation and panning are **per-listener** values —
the same speaker is loud on the left for one person and faint behind another. A server can only
produce them by mixing a separate stream for every listener, which defeats the purpose of the
SFU chosen in [0006](0006-media-livekit-sfu.md).

## Decision

**Compute spatial audio in the browser with the Web Audio API.** The SFU relays untouched
mono/stereo tracks; the client positions them.

Per remote participant:

```
LiveKit MediaStreamTrack
  → MediaStreamAudioSourceNode
  → PannerNode  (panningModel: 'HRTF', distanceModel: 'inverse',
                 refDistance: 1, maxDistance: <audible threshold>, rolloffFactor: 1.2)
  → GainNode    (zone overrides, per-user volume, moderation mute)
  → destination
```

Each frame, the panner's position is set from the remote transform and the `AudioListener`'s
position and orientation from the local camera/avatar. `distanceModel: 'inverse'` gives
`FR-2.9`'s falloff natively; `HRTF` gives `FR-2.10`.

The extra `GainNode` after the panner is where non-geometric rules land — Phase 3 zone
overrides, Phase 7 moderation, per-user volume — so they compose with distance instead of
fighting it.

Falloff parameters live in
[tuning-defaults.md](../../specs/conventions/tuning-defaults.md), satisfying the Phase 2 rule
that thresholds be tunable independently of feature code.

## Consequences

- **The Chrome gotcha.** A WebRTC `MediaStreamTrack` does not feed Web Audio unless it is also
  attached to a playing media element. The fix is to attach each remote track to a muted,
  autoplaying `<audio>` element kept off-screen, and route the graph in parallel. Without this,
  the audio graph runs and produces silence — and it looks like a spatial-audio bug, not a
  plumbing bug. This has cost many projects a day.
- `AudioContext` starts suspended until a user gesture. Resuming it belongs in the join flow.
- Panner and listener updates run in `useFrame` and must mutate nodes directly, never through
  React state — see [0002](0002-client-threejs-r3f-vite.md).
- `FR-2.11` ("beyond the threshold their audio stream is not consumed") is _not_ satisfied by
  gain reaching zero. Silence still costs bandwidth. The subscription must be dropped too,
  which is [0006](0006-media-livekit-sfu.md)'s job. Attenuation and subscription are separate
  mechanisms with matching thresholds.
- `HRTF` is more expensive than `equalpower`. With a cap on simultaneous audible participants
  this is fine, and the mode is configurable if profiling disagrees.
- Directional audio depends on avatar facing being accurate, which is exactly what `FR-4.4`
  promises to supply.

## Alternatives rejected

- **Server-side spatial mixing** — one bespoke mixed stream per listener. Correct-sounding and
  architecturally fatal: it turns an SFU into an MCU and destroys the scaling property
  `FR-2.17` exists to protect.
- **Three.js `PositionalAudio`** — a convenient wrapper over the same `PannerNode`, tied to the
  scene graph. Rejected because the gain stage for zones and moderation is awkward to insert,
  and the WebRTC element workaround still applies.
- **Gain-only attenuation, no panning** — `FR-2.10` is explicitly optional and the Rules section
  confirms distance attenuation alone is acceptable. Rejected because `PannerNode` provides both
  at once; skipping panning would save nothing.
