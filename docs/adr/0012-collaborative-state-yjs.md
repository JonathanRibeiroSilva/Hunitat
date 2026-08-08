# ADR 0012 — Collaborative state: Yjs (CRDT) for whiteboards, notes and synchronized video

**Status:** accepted · **Affects:** phase 10

## Context

Phase 10 asks for something none of the earlier phases need. `FR-10.11` requires objects holding
shared state that updates live for everyone interacting — whiteboard strokes, sticky notes,
video playback position. Then two requirements that are much harder than they look:

> **FR-10.12** Concurrent edits to shared state by multiple participants are merged/ordered
> coherently so everyone converges on the same result.
>
> **FR-10.13** A participant joining an in-progress shared object sees its current state, not an
> empty or stale one.

And the Rules section adds: _"Shared-state merging must converge under concurrent edits and
out-of-order/late updates."_

Convergence under concurrent, out-of-order edits is a distributed-systems problem with a small
set of correct answers. Two people drawing on a whiteboard at once, one on a slow connection,
must end up with identical results — and a "last write wins" field would silently lose strokes.
Locking the object would make collaboration feel broken.

The late-joiner requirement is the second half: a client arriving mid-session needs the accumulated
state before it can apply subsequent updates, and it must not miss updates that arrive during the
handover.

## Decision

**Yjs**, a mature CRDT implementation, served by **`y-websocket`** mounted at `/collab` on the
**same `ws` server** as the game protocol ([0003](0003-transport-native-websocket.md)), so it
inherits the authenticated handshake and Phase 7 role checks.

- One `Y.Doc` per interactive object. Whiteboard strokes as a `Y.Array`, sticky notes as a
  `Y.Map`, video playback as a `Y.Map` of `{state, positionAt, updatedAt}` with client-side
  drift correction.
- `FR-10.12` is what a CRDT _is_ — convergence under concurrent and reordered updates is the
  data structure's guarantee, not application logic.
- `FR-10.13` is Yjs's state-vector sync: a joining client exchanges vectors and receives exactly
  the updates it lacks, with no gap during handover.
- **Persistence** (`FR-10.16`): the encoded document state is written as `bytea` to an
  `object_states` table, debounced during activity and flushed when the last participant leaves.
  On first subscriber, the snapshot is loaded back into a `Y.Doc`.
- `FR-10.14` scoping is enforced at subscription time — the server refuses `/collab` connections
  for objects the participant is not in range of or permitted to use.

## Consequences

- The two hardest requirements in Phase 10 are satisfied by choosing the right data structure
  rather than by writing merge logic. This is the whole argument.
- `FR-10.17` ("closing/leaving never corrupts shared state for others") follows from CRDT
  semantics — there is no state to corrupt on disconnect.
- **`y-websocket` is built on `ws`**, so it mounts on the existing server with no adapter. Had
  the transport been socket.io, this would have needed a shim.
- CRDT documents accumulate history and grow. Long-lived whiteboards need periodic compaction
  (`Y.encodeStateAsUpdate` of a fresh doc), or `bytea` snapshots grow without bound. Not urgent,
  but it does not fix itself.
- Yjs updates are opaque binary. Server-side moderation of whiteboard _content_ would require
  materialising the document, which is possible but not planned.
- Yjs is a second synchronization mechanism alongside the game protocol. They serve genuinely
  different problems — transforms need speed and tolerate loss, collaborative state needs
  convergence and tolerates latency — but the split must be documented so nobody tries to unify
  them.
- Snapshots load lazily on first subscriber, so the first interaction with a dormant object pays
  a small database read.

## Alternatives rejected

- **Server-authoritative state with a mutation log** — every edit ordered through the server and
  broadcast. Workable for sticky notes, poor for freehand drawing, where round-trip latency is
  felt directly. And convergence logic under reordering becomes ours to prove.
- **Automerge** — a capable CRDT with a nicer API. Yjs was chosen for its maturity in exactly
  this application, better performance on large sequences, and the ready-made `y-websocket`
  transport.
- **Operational transformation** — the classic answer, and it requires a central server that
  transforms every operation. More machinery than a CRDT for the same guarantee.
- **Last-write-wins fields** — trivial, and loses concurrent strokes, which is precisely what
  `FR-10.12` forbids.
- **tldraw with its Yjs binding** — a full whiteboard product for free, and a heavy dependency
  carrying its own UI opinions into an in-world panel. A hand-rolled stroke array over Yjs is
  small and fits the 3D context.
