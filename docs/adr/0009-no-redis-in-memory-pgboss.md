# ADR 0009 — No Redis: live state in memory, pg-boss job queue, worker outside the tick process

**Status:** accepted · **Affects:** phases 1, 4, 8, 9

## Context

Redis is the reflex answer for live state in a realtime system, and it was in the first draft of
this architecture: guest sessions with TTL, avatar appearance, the world-instance registry,
editor locks, pub/sub between processes, and a BullMQ job queue.

Examined against the actual constraints — one NestJS process, ~50 participants, Docker Compose
on one server — five of those six uses evaporate:

| Proposed use                         | Actually needed?                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Guest session with TTL               | No. An in-memory `Map` does it, and `FR-1.7` _requires_ the identity to be ephemeral.                          |
| Guest avatar appearance              | No. Same.                                                                                                      |
| Instance registry and per-map counts | No. With one process, the in-memory `Map` **is** the complete truth; `FR-8.12`'s counts read from it directly. |
| Editor lock with heartbeat           | No. `locked_by` + `lock_expires_at` columns do the same.                                                       |
| Cross-process pub/sub                | No. There is one process.                                                                                      |
| **Job queue**                        | **Yes** — but the queue does not require _Redis_, only a queue.                                                |

The argument that survived longest was "survive an API restart". It does not hold: the
WebSocket server restarts with the process, so **every client disconnects and rebuilds state on
reconnect anyway**. There is no live state worth preserving across a restart.

## Decision

**No Redis.**

- **Live state in the `api` process's memory** — participants, transforms, zone occupancy, the
  instance registry, typing indicators, rate-limit counters.
- **Durable state in PostgreSQL** — see [0008](0008-persistence-postgres-typeorm.md).
- **Jobs in `pg-boss`**, a queue backed by the PostgreSQL we already run (`SKIP LOCKED` plus
  `LISTEN/NOTIFY`).
- **The worker runs in a separate process and container** (`apps/worker`), introduced in Phase 9.

### Why a queue exists at all, given a single source of truth

The queue is not about consistency. It is about **CPU time**, and the reason is specific to this
project: the same Node process runs the **20 Hz world tick**. Optimizing an 80 MB GLB — Draco
compression, mesh simplification, texture recompression, all of `FR-9.13` — is tens of seconds
of synchronous CPU. Run inline, it **blocks the event loop and freezes everyone walking around
the 3D world.** The upload isn't slow; the world stutters because somebody uploaded a heavy
model.

Hence the rule that must not stay implicit: **the worker runs outside the process that runs the
tick.** A queue whose worker lives inside `api` would solve nothing.

Separate _process_, not a `worker_thread`: a thread would free the event loop but would not
protect against an out-of-memory kill while decompressing a large model — and an OOM in `api`
drops every WebSocket connection at once. Isolation in another container is what prevents one
heavy upload from evicting everyone from the world.

The spec asks for the queue's other property too. `DC-9.3` defines an asset as having
_"validation status, and level-of-detail variants"_ and `FR-9.12` requires rejection with a
clear reason — pending / processing / ready / rejected is a job's state, and pg-boss provides
it along with retries and concurrency limits.

## Consequences

- Compose loses a stateful service (backup, persistence, security surface) and gains a stateless
  one that is fixed by restarting. Not a wash.
- **Single-process is now an architectural constraint, not a preference.** Running two `api`
  processes would require sticky sessions _and_ a coordination layer — work Redis alone would
  never have covered, given [0003](0003-transport-native-websocket.md) already dropped the
  socket.io Redis adapter.
- One less "which copy is right?" question during every presence bug.
- pg-boss has no first-party NestJS module; a thin provider wrapping it is ours to write. That
  was the accepted cost of dropping Redis.
- Queue load competes with application queries on the same database. At this scale, immaterial.
- Single-node LiveKit needs no Redis either ([0006](0006-media-livekit-sfu.md)); multi-node
  would, and would reopen this decision.
- The `worker` container does not exist until Phase 9.

## Alternatives rejected

- **Redis for everything** (the original draft) — justified only by multi-process plans that
  don't exist, and would still not have delivered them.
- **Redis solely for BullMQ** — buys the official `@nestjs/bullmq` integration and a ready-made
  dashboard, at the price of keeping a whole service for one job type.
- **Graphile Worker** instead of pg-boss — faster and leaner, also Postgres-backed. pg-boss was
  chosen for its explicit job states, which map onto `DC-9.3`'s "validation status" with less
  glue.
- **No queue; optimize inline** — simplest of all, and it freezes the world tick. Rejected on
  the argument above.
