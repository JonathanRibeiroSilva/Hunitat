# Phase 10 — Interactive Objects & Embedded Content

## Overview

**Goal.** Make the world useful, not just walkable: objects you can interact with that hold
content — links, images, video, notes/documents — and shared objects whose state everyone
sees update together (e.g., a collaborative whiteboard or sticky notes).

**Value.** This is what turns a 3D space into a place to _work and play_: a poster you can
read, a video you can watch together, a whiteboard you brainstorm on, a sign that links out.
It's the Gather "embeddable object" idea, limited to built-in content types.

**Depends on.** Phase 1 (state sync), Phase 3 (proximity/trigger volumes for "interact"),
Phase 9 (objects are placed and configured in the editor).

**Delivers.** Walk up to an object, get an interact prompt, open its content (link, image,
video, note/document), and — for shared objects — collaborate on state that updates live for
everyone interacting.

> **Explicitly excluded:** a generic embedded-app framework with sandboxed third-party apps
> and a host↔app message bridge. This phase covers only the built-in content types below.
> The general app framework is deferred for the whole project.

---

## In scope

- Interactive objects with a proximity-based "interact" prompt.
- Built-in content types: links, images, video, text notes, documents.
- Shared, synchronized object state (e.g., collaborative whiteboard, sticky notes).
- The interaction lifecycle (open/close a content panel).
- Persistence of object configuration and shared state within a Map.

## Out of scope

- **Generic third-party embedded-app framework + sandbox + message bridge — deferred for the
  whole project.**
- Arbitrary external website embedding as a general capability (only the explicit built-in types
  here; a plain outbound _link_ is allowed, full third-party app hosting is not).

---

## Functional Requirements

### Interactive objects & prompts

- **FR-10.1** An object placed in the editor (Phase 9) can be marked interactive and configured with
  a content type and its content.
- **FR-10.2** When a participant comes within an object's interaction range (using Phase 3 proximity/
  trigger volumes), an "interact" affordance is shown.
- **FR-10.3** Activating the affordance opens the object's content for that participant; closing it
  returns them to normal play.
- **FR-10.4** Interaction range and the affordance are consistent and discoverable across object types.

### Built-in content types

- **FR-10.5** **Link** — an object can present an outbound link the participant can follow.
- **FR-10.6** **Image** — an object can display an image (e.g., a poster/screen) to the interacting
  participant, and/or render it in-world.
- **FR-10.7** **Video** — an object can play a video; for shared viewing, see synced state (FR-10.10).
- **FR-10.8** **Note / Text** — an object can hold readable (and, if configured, editable) text.
- **FR-10.9** **Document** — an object can present a viewable document.
- **FR-10.10** Where a content type benefits from togetherness (e.g., video), an optional **shared**
  mode keeps interacting participants in sync (see shared state below); otherwise content is presented
  per-participant.

### Shared / synchronized objects

- **FR-10.11** An object can hold **shared state** that updates live for all participants currently
  interacting with it (e.g., a whiteboard's strokes, sticky notes, a video's play/pause/position).
- **FR-10.12** Concurrent edits to shared state by multiple participants are merged/ordered coherently
  so everyone converges on the same result.
- **FR-10.13** A participant joining an in-progress shared object sees its current state, not an empty
  or stale one.
- **FR-10.14** Shared-object updates are scoped to the relevant participants (those interacting / in
  range), consistent with the platform's interest-management approach.

### Lifecycle & persistence

- **FR-10.15** An object's configuration (type, content, interaction range, shared/per-participant
  mode) is part of the Map (Phase 9) and persists with it.
- **FR-10.16** Shared-object _state_ that is meant to endure (e.g., whiteboard contents, sticky notes)
  persists across sessions where configured; ephemeral state (e.g., a transient video position) need
  not.
- **FR-10.17** Closing/leaving an object never corrupts its shared state for others still using it.

---

## Data Concepts

- **DC-10.1 Interactive Object** — a placed object marked interactive: content type, content/config,
  interaction range, and whether it is shared or per-participant.
- **DC-10.2 Content** — the payload for a content type (link target, image, video, note text, document).
- **DC-10.3 Shared Object State** — the live, synchronized state of a shared object (e.g., whiteboard
  strokes, notes, playback state), with persistence flag.
- **DC-10.4 Interaction Session** — a participant's open engagement with an object (open/close lifecycle).

---

## Rules & Edge Cases

- Interact prompts must not clutter: show for the nearest/targeted object, not every object at once.
- Per-participant content (e.g., a private link follow) must not leak into others' views; shared content
  must reach all eligible participants.
- Shared-state merging must converge under concurrent edits and out-of-order/late updates.
- A late joiner must receive a correct snapshot of shared state before applying subsequent updates.
- Following an outbound link must be clearly an outbound action (the participant understands they're
  leaving to an external destination).
- Persisted shared state must survive the last participant leaving and be present on the next visit
  where configured.

---

## Acceptance Criteria

- **AC-10.1** Walking up to an interactive object shows an interact prompt; activating it opens the
  configured content; closing returns to normal.
- **AC-10.2** Each built-in type works: a link can be followed, an image is shown, a video plays, a note
  is readable (and editable if configured), a document is viewable.
- **AC-10.3** Two participants on a shared whiteboard see each other's strokes appear live and converge on
  the same final state.
- **AC-10.4** A participant joining an in-progress shared object immediately sees its current state.
- **AC-10.5** Persistent shared state (e.g., whiteboard/sticky notes) is still there after everyone leaves
  and someone returns.
- **AC-10.6** No generic third-party app hosting exists — only the built-in content types — confirming the
  deferred-framework boundary.

---

## Non-Goals & Deferred

- **Generic embedded-app framework, sandboxing, and host↔app message bridge — deferred for the whole
  project.**
- General arbitrary website embedding as a hosted capability (beyond plain outbound links).
- File attachment management beyond what content types need (revisit with the asset pipeline if desired).
- **Deferred decisions:** how shared state is synchronized/merged and how content is stored are chosen
  later; this spec fixes the interaction model, content types, and the framework exclusion.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The two hard requirements are solved by picking the right data structure

`FR-10.12` (concurrent edits converge) and `FR-10.13` (a late joiner sees current state), plus
the Rules clause about _"out-of-order/late updates"_, describe a distributed-systems problem with
a small set of correct answers. Two people drawing on a whiteboard at once, one on a slow link,
must end up with identical results — a last-write-wins field would silently lose strokes, and
locking the object would make collaboration feel broken.

**Yjs** ([ADR 0012](../docs/adr/0012-collaborative-state-yjs.md)) makes both requirements
properties of the data structure rather than logic we write and have to prove:

- `FR-10.12` — convergence under concurrent and reordered updates is what a CRDT _is_.
- `FR-10.13` — state-vector sync delivers exactly the updates a joiner lacks, with no gap during
  handover.
- `FR-10.17` (closing never corrupts state for others) — there is no state to corrupt on
  disconnect.

`y-websocket` is built on `ws`, so it mounts at `/collab` on the **same server** as the game
protocol ([ADR 0003](../docs/adr/0003-transport-native-websocket.md)) and inherits the
authenticated handshake and Phase 7 role checks. Had the transport been socket.io, this would
have needed a shim.

### Requirement mapping

| Requirement            | Implementation                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-10.1`              | The `interactive` block on a placed object in the Map Document — **already specified** in [map-document.md](protocol/map-document.md). Its presence is what makes an object interactive |
| `FR-10.2`              | Distance test against `INTERACT_RANGE_M` (2.5), reusing Phase 3 trigger volumes where authored                                                                                          |
| `FR-10.3`              | Open/close a content panel; closing returns control to movement                                                                                                                         |
| `FR-10.4`              | One shared prompt component and one default range for every content type                                                                                                                |
| `FR-10.5`              | Outbound link, opened in a new tab with an explicit "leaving" affordance                                                                                                                |
| `FR-10.6`              | Image via MinIO URL, shown in-panel and optionally as an in-world texture                                                                                                               |
| `FR-10.7`, `FR-10.10`  | Video element; in shared mode a Yjs map holds `{state, positionAt, updatedAt}` with drift correction against `VIDEO_SYNC_DRIFT_TOLERANCE_MS`                                            |
| `FR-10.8`              | Note text as a `Y.Text` when editable, plain document field when not                                                                                                                    |
| `FR-10.9`              | Document rendered in-panel from MinIO                                                                                                                                                   |
| `FR-10.11`             | One `Y.Doc` per interactive object. Whiteboard strokes as a `Y.Array`, sticky notes as a `Y.Map`                                                                                        |
| `FR-10.12`, `FR-10.13` | CRDT semantics, as above                                                                                                                                                                |
| `FR-10.14`             | Enforced at subscription: the server refuses `/collab` for objects the participant is not in range of or not permitted to use                                                           |
| `FR-10.15`             | Configuration lives in the Map Document and versions with it                                                                                                                            |
| `FR-10.16`             | `Y.encodeStateAsUpdate` written as `bytea` to `object_states`, debounced at `YJS_PERSIST_DEBOUNCE_MS` and flushed when the last participant leaves                                      |
| `FR-10.17`             | Inherent to the CRDT                                                                                                                                                                    |

### The boundary the spec draws

`AC-10.6` asks us to confirm that **no generic third-party app hosting exists**. That is an
architectural commitment, not a feature flag: there is no sandbox, no `postMessage` bridge, and
no arbitrary iframe embedding. Content types are a closed enum validated by Zod, and adding one
is a code change with a schema bump. A plain outbound link is allowed; hosting someone else's
application is not.

### Rules

- **One prompt at a time** — the nearest interactive object only, or a room of posters becomes
  unreadable.
- **Per-participant content must not leak.** Following a link is local; only `shared: true`
  objects route through Yjs.
- **Configuration versions with the map; content does not.** The document holds config, the CRDT
  holds state. Reverting a map version must not silently erase a whiteboard.

### Risks and sharp edges

1. **CRDT documents grow without bound.** Yjs retains history, so a long-lived whiteboard's
   `bytea` snapshot keeps expanding. Periodic compaction — re-encoding into a fresh doc — is
   needed eventually. It does not fix itself, and it is easy to forget until a load is slow.
2. **Yjs updates are opaque binary.** Server-side moderation of whiteboard _content_ would
   require materialising the document. Possible, not planned — worth knowing before someone
   assumes Phase 7 covers it.
3. **Two synchronization mechanisms now coexist.** The game protocol optimises for speed and
   tolerates loss; Yjs optimises for convergence and tolerates latency. They solve genuinely
   different problems and must not be unified.
4. **Snapshots load lazily**, so the first interaction with a dormant object pays a database
   read. Show a brief loading state rather than an empty whiteboard, which reads as data loss.
5. **`persistShared: false` means gone on last leave** — make that visible in the editor, because
   discovering it after a workshop is not recoverable.

### References

[ADR 0012](../docs/adr/0012-collaborative-state-yjs.md) ·
[ADR 0003](../docs/adr/0003-transport-native-websocket.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[map-document.md](protocol/map-document.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md)
