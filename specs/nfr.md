# Non-Functional Requirements

**Status:** normative · **Applies to:** all phases

The phase specs are precise about behavior and silent about quality. `AC-1.2` asks for movement
that is _"smooth, not teleporting, under normal network jitter"_ without saying what normal is.
`FR-2.18` asks for graceful degradation without a trigger point. `AC-1.5` asks for _"many
simulated participants"_ without a number.

Unmeasurable acceptance criteria get argued about instead of tested. This document supplies the
numbers.

IDs are `NFR-<n>` and are referenced from Implementation Notes the same way `FR-` ids are.

---

## Scale

- **NFR-1** One world instance supports **50 concurrent participants** with all targets in this
  document met. This is the figure the architecture was designed and verified against; beyond it
  nothing has been validated.
- **NFR-2** One `api` process supports **200 concurrent participants** across all instances.
- **NFR-3** A participant's area of interest typically contains **10–15 others**. Interest
  management (`FR-1.16`) is what keeps per-client cost flat as `NFR-1` grows.
- **NFR-4** Exceeding capacity must degrade predictably — refuse with a clear reason, or shard
  to a new instance per `FR-8.8` — never by slowing everyone down.

---

## Latency

Measured on a local network. Add real-world RTT for remote participants.

| ID         | Path                                      | Target              | Ceiling |
| ---------- | ----------------------------------------- | ------------------- | ------- |
| **NFR-5**  | Local input → local avatar moves          | < 16 ms (one frame) | 33 ms   |
| **NFR-6**  | Local movement → remote client renders it | < 150 ms            | 250 ms  |
| **NFR-7**  | Server tick processing, 50 participants   | < 10 ms             | 25 ms   |
| **NFR-8**  | Chat send → delivered                     | < 200 ms            | 500 ms  |
| **NFR-9**  | Entering audible range → audio flowing    | < 500 ms            | 1500 ms |
| **NFR-10** | Zone enter/exit → media reconfigured      | < 300 ms            | 800 ms  |

**NFR-5** is `FR-1.11` made measurable, and it is why movement is client-authoritative
([ADR 0004](../docs/adr/0004-client-authoritative-movement-aoi.md)) — no round-trip can fit in
one frame.

**NFR-6** decomposes as: client send interval (≤50 ms) + network + server tick (≤50 ms) +
interpolation buffer (100 ms). The buffer is the largest term and is deliberate: it is what buys
`AC-1.2`'s smoothness.

**NFR-7** must stay well under the 50 ms tick interval. A tick that overruns compounds, and the
world stutters for everyone at once. This is also the budget that
[ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md) protects by keeping asset processing
out of this process.

---

## Client performance

| ID         | Metric                                           | Target  | Minimum |
| ---------- | ------------------------------------------------ | ------- | ------- |
| **NFR-11** | Frame rate, 15 visible avatars, mid-range laptop | 60 fps  | 30 fps  |
| **NFR-12** | Frame time budget                                | < 16 ms | 33 ms   |
| **NFR-13** | Time to interactive, cold load                   | < 8 s   | 20 s    |
| **NFR-14** | Client memory after 1 hour                       | < 1 GB  | 2 GB    |
| **NFR-15** | Draw calls, typical scene                        | < 300   | 800     |

**Reference hardware** for "mid-range laptop": integrated GPU (Intel Iris Xe or equivalent),
16 GB RAM, 1920×1080. If it works there, it works on the machines an internal tool actually runs
on.

**NFR-13** includes WASM initialisation, GLB fetch and parse, and collider construction — all of
which happen behind the loading screen described in [ux/phase-01-screens.md](ux/phase-01-screens.md).

**NFR-14** is a leak check. Avatars, textures and audio nodes must be disposed when participants
leave area of interest (`FR-1.17`); Three.js does not free GPU resources on garbage collection,
so this only holds if disposal is explicit.

---

## Network

| ID         | Metric                                | Target     | Ceiling |
| ---------- | ------------------------------------- | ---------- | ------- |
| **NFR-16** | Game protocol, per client, downstream | < 15 KB/s  | 40 KB/s |
| **NFR-17** | Game protocol, per client, upstream   | < 2 KB/s   | 5 KB/s  |
| **NFR-18** | Audio, per subscribed stream          | ~32 kbps   | 64 kbps |
| **NFR-19** | Video, per subscribed stream          | ~300 kbps  | 1 Mbps  |
| **NFR-20** | Total per client, 6 video + 12 audio  | < 2.5 Mbps | 4 Mbps  |

**NFR-16** falls out of the wire format: 15 neighbours × 10 bytes × 20 Hz ≈ 3 KB/s of
transforms, with headroom for events. The binary encoding in
[wire-protocol.md](protocol/wire-protocol.md) is what makes this comfortable rather than tight.

**NFR-20** is the ceiling that `FR-2.18`'s degradation defends. When it is approached, video is
shed before audio, most distant first.

---

## Resilience

- **NFR-21** _Normal jitter_, for `AC-1.2`, means **±50 ms of variance and up to 2% packet loss**.
  Movement must remain visually smooth under this. The 100 ms interpolation buffer absorbs two
  missed updates at 20 Hz.
- **NFR-22** A connection dropped for less than `RESUME_TOKEN_TTL_MS` (60 s) restores without
  manual rejoin (`FR-1.5`).
- **NFR-23** Reconnection uses exponential backoff — 500 ms doubling to a 10 s cap, ±20% jitter —
  so a server restart does not produce a synchronised stampede.
- **NFR-24** One participant's media failure must not disturb anyone else's (Phase 2 rules).
- **NFR-25** An `api` restart is recoverable without user action: clients reconnect and rebuild.
  This is the property that makes in-memory live state acceptable
  ([ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)).
- **NFR-26** A failed world load shows a clear error state, never an empty void (Phase 1 rules).

---

## Browser support

| ID                               | Requirement                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **NFR-27** Supported             | Chrome / Edge ≥ 111, Firefox ≥ 113, Safari ≥ 16.4 — the last two major versions of each                         |
| **NFR-28** Required capabilities | WebGL 2, WebAssembly, WebSocket binary, WebRTC, Web Audio, `AudioContext.setPosition`/`AudioListener`           |
| **NFR-29** Unsupported           | Internet Explorer, and any browser missing WebGL 2 — detected at load with a clear message, not a broken canvas |
| **NFR-30** Mobile                | Out of scope. Touch input, thermal limits and mobile GPUs are a separate design problem.                        |

Safari's Web Audio implementation has historically diverged on `PannerNode` orientation. Spatial
audio ([ADR 0007](../docs/adr/0007-spatial-audio-web-audio.md)) must be verified there
specifically rather than assumed from Chrome.

---

## Security

Phase 1 has no authentication, so these apply from the first line of code.

- **NFR-31** Every inbound frame is size-checked before parsing and schema-validated before use
  ([wire-protocol.md](protocol/wire-protocol.md#security-limits)).
- **NFR-32** Per-connection rate limits are enforced server-side.
- **NFR-33** Uploaded assets are parsed only in the isolated worker process, never in `api`
  ([ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)).
- **NFR-34** From Phase 7, authorization is enforced on **both** HTTP and WebSocket paths. A
  capability hidden in the UI is not enforced.
- **NFR-35** Movement is trusted by design ([ADR 0004](../docs/adr/0004-client-authoritative-movement-aoi.md)).
  A tampered client can move illegally. It cannot escape server-side decisions — zone occupancy,
  audience resolution and chat scoping are all computed from the reported position on the
  server.

---

## Operability

- **NFR-36** `docker compose up` on a clean machine produces a working system using only
  `.env.example` and the README.
- **NFR-37** Structured JSON logs with a correlation id per session.
- **NFR-38** `api` exposes a health endpoint reporting instance count, participant count, and
  observed tick duration — enough to see `NFR-7` degrading before users report it.
- **NFR-39** Configuration is environment variables only; no rebuild to change any value in
  [tuning-defaults.md](conventions/tuning-defaults.md).

---

## How these are verified

| Group                  | Method                                                     |
| ---------------------- | ---------------------------------------------------------- |
| NFR-1, 2, 3, 7, 16, 17 | `apps/harness` at scale, reporting measured values         |
| NFR-5, 6, 21           | harness with injected latency and loss                     |
| NFR-11–15              | manual profiling against the reference hardware            |
| NFR-18–20              | LiveKit statistics and browser WebRTC internals            |
| NFR-22, 23, 25, 26     | harness scenarios `reconnect-resume` and `session-reaping` |
| NFR-27–29              | manual matrix check per release                            |
| NFR-31, 32             | harness sends oversized, malformed and flooding frames     |
| NFR-36                 | clean-machine install, following the README only           |

See [testing-strategy.md](../docs/testing-strategy.md).
