# ADR 0003 — Transport: native WebSocket (`ws`) inside NestJS with a custom binary protocol

**Status:** accepted · **Affects:** phases 1, 3, 5, 10

## Context

`FR-1.12` requires continuous position sharing in near-real-time, and `FR-1.16` requires each
participant to receive only their neighbours. At the target of ~50 participants in one world,
the server sends roughly 50 × 10 neighbours × 20 Hz ≈ 10,000 participant-updates per second.
The per-update byte cost is therefore not a micro-optimization; it's the difference between a
comfortable server and a saturated one.

The same connection also has to carry low-frequency events (join, leave, snapshot, later chat
and emotes), and Phase 10 needs a second protocol (Yjs) on the same server.

## Decision

**Native WebSocket via the `ws` library**, wired into NestJS with `@nestjs/platform-ws` and its
`WsAdapter`. No socket.io. The wire format is ours, defined once in `packages/protocol` and
specified in [wire-protocol.md](../../specs/protocol/wire-protocol.md).

Frames are **tagged**: the first byte is an opcode.

- **Hot path — transform batches at 20 Hz.** Hand-packed `ArrayBuffer`. Per participant:
  `id u16` + `x,y,z i16` (centimetres, ±327 m) + `yaw u8` (1.4° steps) + `flags u8` = **10
  bytes**, against roughly 40 as JSON. The `id` is an instance-local index mapped from the
  session UUID — sending a 36-character UUID 20 times a second would be pure waste.
- **Events — join, leave, snapshot, chat, emote, zone.** JSON under separate opcodes. Low
  frequency, and legibility is worth more than bytes.

## Consequences

What socket.io provided and how we replace it:

| Lost                        | Replacement                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic reconnection      | Exponential backoff plus a **resume token**. `FR-1.5` requires restoring position and presence, which socket.io's reconnect would not have done anyway — the real work was always ours. |
| Application-level heartbeat | Native WebSocket **ping/pong** frames with the `isAlive` pattern. Cheaper, and satisfies `FR-1.6`.                                                                                      |
| Rooms and broadcast         | A `Map<sessionId, WebSocket>` per world instance. Every payload is already area-of-interest filtered per recipient, so rooms were never going to carry weight.                          |
| `volatile emit`             | Check `socket.bufferedAmount` before sending a snapshot and **skip the frame** above a threshold. Dropping a stale position is correct; queueing it is not.                             |
| `@socket.io/redis-adapter`  | Nothing — see [0009](0009-no-redis-in-memory-pgboss.md). A single process is an accepted architectural constraint, and Redis alone would not have solved multi-process anyway.          |

Other consequences:

- **We do not use `@nestjs/platform-ws`.** Its `WsAdapter` routes only messages shaped
  `{event, data}` as JSON to `@SubscribeMessage` handlers; binary frames never reach them. Since
  the hot path is packed binary, working around an adapter that cannot see most of our traffic
  costs more than owning the message loop. A `ws.Server` is attached directly to Nest's HTTP
  server in a provider's `onApplicationBootstrap`, which also gives us the handshake — needed for
  subprotocol validation now and authentication in Phase 6.
- The gateway is a plain `@Injectable()`, not a `@WebSocketGateway()`. It still lives in Nest's
  DI graph and its lifecycle hooks; it simply owns its own socket server.
- `packages/protocol` is promoted from convenience to required infrastructure. It is the only
  thing keeping client and server agreeing on byte offsets.
- A message size ceiling (4 KB) and per-connection rate limits must be enforced explicitly;
  socket.io's defaults are gone.
- **Phase 10 gets easier.** `y-websocket` is built on `ws`, so it mounts on the same server
  under `/collab` with no shim, inheriting the authenticated handshake.
- Debugging is harder: binary frames aren't readable in browser devtools. A dev-mode decoder
  that logs frames as objects is part of the client.

## Alternatives rejected

- **socket.io** — rooms, reconnection and fallbacks out of the box, at the cost of protocol
  overhead on the hot path and a framing layer we'd have to fight to send packed binary through.
- **socket.io with `socket.io-msgpack-parser`** — closes most of the size gap, but msgpack still
  encodes field names and can't express a quantized `i16` position.
- **uWebSockets.js** — measurably faster than `ws`, but a native dependency with rougher NestJS
  integration. Held in reserve if profiling ever demands it; `ws` is not the bottleneck at 50
  participants.
- **WebTransport / WebRTC data channels** — genuinely unreliable-unordered delivery, which suits
  position updates. Rejected as premature: browser support is uneven and the complexity is real,
  while `bufferedAmount` skipping gets most of the benefit.
