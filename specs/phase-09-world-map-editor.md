# Phase 9 — World / Map Editor & Asset Pipeline

## Overview

**Goal.** Let people build their own 3D worlds without writing code: place and arrange
objects, paint collision, define zones/spawns/portals, manage assets, set lighting, and
publish a Map that the platform can run.

**Value.** Until now, worlds are hand-authored externally. The editor turns the platform into
a product anyone can shape — the equivalent of Gather's Mapmaker, but in 3D.

**Depends on.** Phase 3 (zones/collision/spawns/portals are what's being authored), Phase 8
(Maps live inside Spaces and are published as managed units).

**Delivers.** An in-app editor where a permitted user composes a 3D scene, defines all the
spatial rules from Phase 3, uploads and manages 3D assets, configures lighting/environment,
and publishes a versioned Map that participants can enter.

---

## In scope

- Visual scene composition (place/move/rotate/scale objects).
- Authoring all Phase 3 zone types: collision, spawn, private, spotlight, portal, trigger.
- Asset upload & management (3D models, textures, thumbnails) with validation and
  level-of-detail handling for performance.
- Lighting and environment settings.
- A serializable Map document with versioning and publish/draft states.
- Editor permissions tied to roles.

## Out of scope

- The interactive content placed _in_ objects (links, video, whiteboards) — that's Phase 10,
  which uses this editor to place such objects.
- Avatar authoring (the avatar customization taxonomy is Phase 4; custom avatar uploads could
  reuse this asset pipeline later but aren't specified here).

---

## Functional Requirements

### Scene composition

- **FR-9.1** A permitted user can place objects from an asset library into a Map and position,
  rotate, and scale them in 3D.
- **FR-9.2** Objects can be selected, duplicated, grouped, deleted, and re-arranged, with undo/redo.
- **FR-9.3** The editor shows the scene as participants will see it (an accurate preview), and the
  author can move through it as a participant would to test.
- **FR-9.4** Editing is non-destructive to the live published Map until explicitly published (drafts).

### Authoring spatial rules (Phase 3 zones)

- **FR-9.5** The author can define and shape **collision** volumes (impassable areas).
- **FR-9.6** The author can place one or more **spawn** points and set spawn rules.
- **FR-9.7** The author can define **private** zones and **spotlight** zones and set their
  properties (e.g., spotlight broadcast scope).
- **FR-9.8** The author can place **portal** zones and set their targets (another Map/spawn within
  the Space, resolving the abstract target from Phase 3 / Phase 8).
- **FR-9.9** The author can place generic **trigger** zones for later use (e.g., by Phase 10 objects).
- **FR-9.10** Authored zones behave at runtime exactly as specified in Phase 3.

### Asset management & pipeline

- **FR-9.11** A permitted user can upload 3D models, textures, and thumbnails to a Space's asset
  library.
- **FR-9.12** Uploaded assets are validated (format/size/integrity) and rejected with a clear reason
  if unusable.
- **FR-9.13** The pipeline handles performance: assets get level-of-detail / optimization treatment
  so large scenes remain performant for participants.
- **FR-9.14** Assets can be browsed, searched, previewed, reused across Maps in the Space, and removed
  (with safeguards if in use).
- **FR-9.15** A default/built-in asset set is available so a Map can be built without any uploads.

### Lighting & environment

- **FR-9.16** The author can configure lighting and environment settings (e.g., ambient/scene
  lighting, sky/background, basic atmosphere) affecting how the Map looks at runtime.

### Map document, versioning & publish

- **FR-9.17** A Map is captured as a serializable document containing its scene graph, zones, spawns,
  portals, lighting, and asset references.
- **FR-9.18** Maps support draft vs. published states; publishing makes the new version live for
  participants.
- **FR-9.19** Map versions are retained so an author can review and revert to a previous version.
- **FR-9.20** Publishing handles participants currently in the Map gracefully (e.g., apply on next
  entry or coordinate a smooth reload, not a hard break).

### Editor permissions

- **FR-9.21** Only roles permitted by Phase 7 can edit, manage assets, and publish; others cannot
  modify a Map.
- **FR-9.22** Concurrent editing is handled safely (at minimum, prevent conflicting overwrites; ideally
  support multi-author editing with conflict handling).

---

## Data Concepts

- **DC-9.1 Map Document** — the serializable definition: scene graph (placed objects with transforms),
  zones, spawns, portals, lighting/environment, and asset references; with version and draft/published
  state.
- **DC-9.2 Placed Object** — an instance of an asset in the scene with transform and grouping.
- **DC-9.3 Asset** — an uploaded or built-in resource (model/texture/thumbnail) with metadata,
  validation status, and level-of-detail variants.
- **DC-9.4 Asset Library** — the collection of assets available within a Space.
- **DC-9.5 Map Version** — a retained snapshot of a Map Document enabling review/revert.

---

## Rules & Edge Cases

- A draft must never affect participants in the live Map until published.
- Removing an asset still referenced by a Map must be prevented or clearly warned, and must not break
  published Maps.
- Validation must protect runtime performance and safety (reject malformed/oversized assets).
- Portals authored here must resolve to valid Maps/spawns; broken targets must be flagged in the editor.
- Versioning must let an author revert without losing the ability to return to the newer version.
- Concurrent edits must not silently clobber another author's work.

---

## Acceptance Criteria

- **AC-9.1** A permitted user composes a Map by placing/moving/scaling objects, with working undo/redo,
  and previews it as a participant.
- **AC-9.2** The author defines collision, spawns, private/spotlight zones, portals, and triggers, and
  they behave at runtime exactly per Phase 3.
- **AC-9.3** A 3D asset can be uploaded, validated, optimized for performance, reused, and removed
  safely; a Map can also be built entirely from built-in assets.
- **AC-9.4** Lighting/environment settings change the runtime look as configured.
- **AC-9.5** A Map can be drafted, published, versioned, and reverted; publishing doesn't hard-break
  participants currently inside.
- **AC-9.6** Only permitted roles can edit/publish; concurrent edits don't clobber each other.

---

## Non-Goals & Deferred

- Interactive object _content_ (Phase 10) — this phase only places objects and triggers.
- Custom avatar uploads (could reuse this pipeline later; not specified here).
- A marketplace / sharing of assets between Spaces.
- **Deferred decisions:** asset formats, optimization/level-of-detail techniques, the Map document
  serialization format, and storage are chosen later; this spec fixes the authoring capabilities and
  runtime fidelity.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The format already exists

`DC-9.1` is the Map Document — and it was **defined before Phase 1**, in
[map-document.md](protocol/map-document.md), because Phase 1 loads one (`FR-1.18`), Phase 3
stores zones in one (`FR-3.1`), and Phase 10 stores object configuration in one (`FR-10.15`).
Inventing it here would have broken everything built in between.

So this phase does not design a format. It builds the editor that writes the existing one, and
the fields marked _(phase 9)_ and _(phase 10)_ in that document become live.

### The editor is the runtime client

`FR-9.3` asks for a preview accurate to what participants see. Rather than building a separate
preview, **the editor is a route in `apps/web` reusing the same R3F scene and the same
`world-core`** ([ADR 0002](../docs/adr/0002-client-threejs-r3f-vite.md)). Play-mode is the same
character controller against colliders built from the draft document. Fidelity is structural, not
maintained.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-9.1`             | Asset library → placed object; `TransformControls` gizmo for translate / rotate / scale                                                                                                                     |
| `FR-9.2`             | Command-stack undo/redo in Zustand; every mutation is a reversible command, no direct state edits                                                                                                           |
| `FR-9.3`             | Same scene, same physics, same tuning constants as the runtime                                                                                                                                              |
| `FR-9.4`, `FR-9.18`  | Draft rows in `map_versions`; publishing moves `maps.published_version_id`                                                                                                                                  |
| `FR-9.5`–`FR-9.9`    | Zone authoring writes the volume shapes and per-type properties already specified in [map-document.md](protocol/map-document.md)                                                                            |
| `FR-9.10`            | Guaranteed by reuse — the editor writes what the runtime already reads                                                                                                                                      |
| `FR-9.11`            | **Presigned PUT direct to MinIO.** Bytes never pass through `api`                                                                                                                                           |
| `FR-9.12`            | Parse and validate with `@gltf-transform/core`; reject on size, triangle count, texture dimensions or malformed structure, always with the specific reason                                                  |
| `FR-9.13`            | `draco`, `simplify` and `textureCompress` producing `ASSET_LOD_RATIOS` variants, **in the worker process**                                                                                                  |
| `FR-9.14`            | Metadata in PostgreSQL; "in use" is an explicit query across `map_versions` documents, since `jsonb` provides no foreign key                                                                                |
| `FR-9.15`            | A built-in CC0 asset set ships in the repository and is seeded, so a map can be built with no uploads                                                                                                       |
| `FR-9.16`            | The `environment` block of the Map Document                                                                                                                                                                 |
| `FR-9.17`, `FR-9.19` | Copy-forward versioning: revert writes an _older document into a newer version_, which is what lets an author return to the newer one afterwards                                                            |
| `FR-9.20`            | Broadcast `map:updated`; occupants see a "new version available" prompt and it applies on next entry. Not a forced reload                                                                                   |
| `FR-9.21`            | Phase 7 `RolesGuard` on every editor and asset endpoint                                                                                                                                                     |
| `FR-9.22`            | Optimistic locking (`version` column, 409 on stale write) plus an advisory editor lock in `locked_by` / `lock_expires_at` with heartbeat. This meets the stated minimum — preventing conflicting overwrites |

### Why the pipeline runs in another process

`FR-9.13` is tens of seconds of synchronous CPU for a large GLB. The `api` process also runs the
**20 Hz world tick**. Run inline, asset optimization blocks the event loop and **freezes everyone
walking around the 3D world** — the upload is not slow, the world stutters.

So the job is queued with pg-boss and executed by `apps/worker`, in its own container
([ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md)). A separate _process_, not a worker
thread: a thread would free the event loop but would not survive an out-of-memory kill while
decompressing a large model — and an OOM in `api` drops every WebSocket connection at once.

The job state also _is_ the `validation status` that `DC-9.3` requires the UI to show: pending /
processing / ready / rejected.

### Rules

- **A draft never affects the live map.** Occupants read the published version only.
- **Deleting an in-use asset is blocked**, not warned-and-allowed. Published maps must not break.
- **Portals with unresolvable targets are flagged in the editor**, before publish rather than
  after.
- **Concurrent edits must not silently clobber.** The 409 is the guarantee; the advisory lock is
  the courtesy that stops it happening.

### Risks and sharp edges

1. **Draco-compressed output needs a decoder configured on the client.** `GLTFLoader` supports it
   but does not enable it by default — otherwise the pipeline's own output silently fails to
   load, which is a memorable afternoon.
2. **Uploaded assets are untrusted input parsed by a library.** Parsing happens only in the
   isolated worker (`NFR-33`).
3. **Undo/redo must cover zone and property edits**, not just transforms. Partial undo is worse
   than none — users stop trusting it.
4. **`jsonb` documents should stay well under a megabyte.** Surface document size in the editor
   before a large map becomes a performance problem nobody saw coming.
5. **Bounds are hard-limited to ±327.67 m** by the wire quantization. The editor must reject
   out-of-range geometry at authoring time, not let it fail at runtime
   ([map-document.md](protocol/map-document.md)).

### References

[ADR 0009](../docs/adr/0009-no-redis-in-memory-pgboss.md) ·
[ADR 0010](../docs/adr/0010-3d-formats-gltf-vrm.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[ADR 0002](../docs/adr/0002-client-threejs-r3f-vite.md) ·
[map-document.md](protocol/map-document.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md)
