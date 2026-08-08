# ADR 0006 — Media: self-hosted LiveKit SFU with selective subscription

**Status:** accepted · **Affects:** phases 2, 3, 7, 8

## Context

`FR-2.17` is unusually prescriptive for a technology-neutral spec:

> The media architecture must support many participants in one world without requiring each
> participant to stream directly to every other participant.

That sentence rules out a peer-to-peer mesh. At 50 participants a mesh would mean 49 outbound
streams per person; it collapses well before that.

The requirement underneath is subtler than "use an SFU". `FR-2.16` says a participant consumes
only the media of those currently relevant, and `FR-2.14` says connection and disconnection
happen automatically as people move. So the media layer must let subscriptions change
constantly, per-viewer, at walking speed — while `FR-2.15` insists that churn must not glitch
uninvolved participants.

Phase 7 then requires the server to force-mute someone in a way they cannot undo (`FR-7.5`), and
Phase 3 requires zones to override proximity entirely (`FR-3.8`–`FR-3.11`).

## Decision

**LiveKit**, self-hosted, Apache 2.0, single-node. One **World Instance = one LiveKit Room**.

The division of labour:

- **NestJS decides who hears whom.** The server computes proximity and zone membership on its
  tick, runs `resolveAudience()`, and pushes each participant their audience set over the game
  WebSocket.
- **The client applies it**, calling `setSubscribed()` per track. Subscription churn is a client
  operation against the SFU, so it doesn't cost a server round-trip per step.
- **NestJS mints access tokens** with `livekit-server-sdk` and owns publish permissions.

Requirements this satisfies directly:

| Requirement                         | Mechanism                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `FR-2.17` scale without mesh        | SFU by definition                                                         |
| `FR-2.16` consume only the relevant | per-track `setSubscribed()`                                               |
| `FR-2.21` "is speaking" signal      | LiveKit's `ActiveSpeakersChanged` / `isSpeaking` — no VAD to build        |
| `FR-2.18` graceful degradation      | simulcast layers + a cap on concurrent video, dropping most distant first |
| `FR-2.19` screen share              | `setScreenShareEnabled` as a distinct track source                        |
| `FR-7.5` force-mute they can't undo | `mutePublishedTrack` **and** `updateParticipant({canPublish:false})`      |
| `FR-7.7` kick                       | `removeParticipant`                                                       |
| `FR-8.6` clean map transfer         | leave room A, join room B with a fresh token                              |

Spatial gain and panning are **not** LiveKit's job — see
[0007](0007-spatial-audio-web-audio.md).

## Consequences

- Muting alone is insufficient for `FR-7.5`; the client can re-enable its own track. Revoking
  `canPublish` is what makes the mute authoritative. Both calls, always.
- Zone overrides become a subscription problem rather than a routing problem: a private zone is
  simply an audience set that excludes everyone outside it. `FR-3.9`'s symmetric isolation
  requires the server to compute it symmetrically, which `resolveAudience()` does.
- A LiveKit token has a fixed identity and room. Phase 8 map transfer therefore always issues a
  new token, which is a natural fit for the atomic leave/join `FR-8.6` demands.
- Single-node LiveKit needs no Redis — consistent with
  [0009](0009-no-redis-in-memory-pgboss.md). Multi-node would require it, and that is a
  different deployment decision.
- TURN is required for restrictive NATs. On an internal network it is usually unnecessary;
  `coturn` is declared in Compose as optional and documented.
- Another service to run and upgrade. Accepted: writing an SFU is not a reasonable alternative.

## Alternatives rejected

- **mediasoup** — a Node library rather than a server, giving finer control and no extra
  process. Rejected because we would then build token issuance, reconnection, simulcast
  management and client SDKs ourselves — all of which LiveKit ships.
- **Janus / Jitsi Videobridge** — mature and self-hostable, but oriented toward conference calls
  with a fixed roster. Per-viewer subscription churn at walking speed is not their model.
- **Peer-to-peer mesh** — trivially simple for a handful of people, and a direct violation of
  `FR-2.17`.
- **LiveKit Cloud** — the same software, operated for us. Rejected on guiding principle nº1:
  no hard requirement on a hosted third-party service.
