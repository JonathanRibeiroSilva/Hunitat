# Protocol — Map Document

**Status:** normative · **Applies to:** phases 1, 3, 8, 9, 10 · **Implemented by:** `packages/protocol`

A Map Document is the serializable definition of one world: what it looks like, what blocks
movement, where people appear, which regions have special rules, and which objects can be
interacted with.

## Why this exists now instead of in Phase 9

`DC-9.1` defines this concept, and Phase 9 builds the editor that writes it. But three earlier
phases already depend on the format:

- **Phase 1** (`FR-1.18`) loads a world with geometry, collision surfaces, bounds and spawns.
- **Phase 3** (`FR-3.1`) adds six zone types, read from map data.
- **Phase 10** (`FR-10.15`) stores interactive-object configuration inside the map.

If the format were invented in Phase 1 and reinvented in Phase 9, everything built in between
would break. So the **whole schema is defined once, now**, including the parts nothing reads
yet. Phase 1 hand-writes one document; Phase 9 generates them.

Fields marked _(phase N)_ are validated from the start and simply unused until then.

---

## Document shape

```jsonc
{
  "schemaVersion": 1,
  "id": "office",
  "name": "Head Office",

  "bounds": {
    "min": { "x": -50, "y": -5, "z": -50 },
    "max": { "x":  50, "y": 20, "z":  50 }
  },

  "geometry": {
    "url": "/assets/world/office.glb",
    "collisionMode": "convention"
  },

  "spawns": [
    { "id": "main", "position": {...}, "yaw": 0, "default": true }
  ],

  "environment": {
    "ambientColor": "#ffffff", "ambientIntensity": 0.6,
    "sunDirection": { "x": -0.5, "y": -1, "z": -0.3 },
    "sunColor": "#fff5e6", "sunIntensity": 1.2,
    "background": "#87ceeb", "fog": { "color": "#87ceeb", "near": 40, "far": 120 }
  },

  "zones": [],          // phase 3
  "objects": [],        // phase 9 placed props, phase 10 interactive config
  "movement": { "allowJump": true, "walkSpeedMultiplier": 1.0 }
}
```

### `bounds` — required

The playable volume. A participant may not leave it (`FR-1.10`).

**Hard constraint:** every coordinate must fall within **±327.67 m**, the range of the `i16`
centimetre quantization in [wire-protocol.md](wire-protocol.md). A document exceeding it is
rejected at validation, not discovered as visual corruption later.

### `geometry` — required

Points at a single GLB. `collisionMode` is `"convention"` (derive colliders from node names, see
below) or `"explicit"` (use only the collision volumes declared in `zones`).

### `spawns` — required, at least one

`FR-1.20` and `FR-3.6`. Exactly one entry must have `"default": true`. Portals reference spawns
by `id` (`FR-3.15`).

Spawn placement must avoid dropping participants inside collision or on top of each other
(`FR-3.7`), so the runtime treats each spawn as a small area and offsets arrivals within it.

### `environment` — optional

`FR-9.16`. Sensible defaults apply when absent.

### `movement` — optional

Per-map movement rules. `allowJump: false` suits an office where jumping would look absurd.

---

## Node naming convention

glTF has no notion of "this mesh is collision" or "this empty is a spawn point". With
`collisionMode: "convention"`, semantics come from **node name prefixes** in the GLB.

| Prefix   | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `COL_`   | collision mesh — becomes a trimesh collider, **not rendered** |
| `SPAWN_` | spawn point — position and yaw taken from the node transform  |
| `NAV_`   | reserved for future navigation meshes; ignored, not rendered  |
| _(none)_ | ordinary visual geometry                                      |

So `COL_walls` blocks movement and stays invisible, `Chair_01` renders and does not block, and
`SPAWN_main` places people.

**This convention is load-bearing.** Get it wrong and either the world has no collision or
invisible geometry renders as a grey mass. Both failures are immediate and obvious, which is the
point of using a prefix rather than a metadata extension.

A GLB with no `COL_` nodes and `collisionMode: "convention"` is **valid but flagged** — it is
occasionally intentional (a flat floor plane with explicit volumes), usually a mistake.

### Authoring rules

- Export at **1 unit = 1 metre**, **Y-up**
  ([coordinates-and-units.md](../conventions/coordinates-and-units.md)).
- Apply transforms before export; a scaled parent node will scale colliders unexpectedly.
- Keep collision meshes simple. A trimesh built from decorative geometry is slow to construct
  and slow to query. `COL_` meshes should be boxes and planes, not the visible furniture.

---

## Zones _(phase 3)_

```jsonc
{
  "id": "huddle-a",
  "type": "collision" | "spawn" | "private" | "spotlight" | "portal" | "trigger",
  "volume": {
    "shape": "box",                        // or "cylinder"
    "center": { "x": 0, "y": 1, "z": 0 },
    "size":   { "x": 4, "y": 3, "z": 4 },  // box
    "yaw": 0
  },
  "properties": { }                        // per type
}
```

Per-type `properties`:

| Type        | Properties                                    | Requirements         |
| ----------- | --------------------------------------------- | -------------------- |
| `collision` | —                                             | `FR-3.4`, `FR-3.5`   |
| `spawn`     | `spawnId`, `rule` (`default`/`least-crowded`) | `FR-3.6`, `FR-3.7`   |
| `private`   | `gain` (default 1.0)                          | `FR-3.8`–`FR-3.11`   |
| `spotlight` | `gain`, `scope` (`map`)                       | `FR-3.12`, `FR-3.13` |
| `portal`    | `target: { mapId?, spawnId }`                 | `FR-3.14`, `FR-3.15` |
| `trigger`   | `key`                                         | `FR-3.17`, `FR-3.18` |
| _any_       | `chatEnabled` (default `false`)               | `FR-5.3`             |

**`chatEnabled` is not per-type**, and that is the requirement rather than a convenience: `FR-5.3`
says a zone channel exists "where the map defines chat-enabled zones", without tying it to what
else the zone does. A meeting room that isolates audio usually wants a text channel too, and so
does a corridor that isolates nothing. The channel appears on a participant's advertised set only
while they are inside (`FR-5.5`), and its occupancy is the same set the media rules use — chat does
not re-test the volume.

**Portal targets are abstract.** `mapId` may be omitted for a same-map teleport; when present it
is resolved by Phase 8, exactly as `FR-3.15` requires. A portal whose target cannot be resolved
must leave the participant in place and inform them — never vanish them.

Overlapping zones are legal and resolved by the precedence rules in
[architecture.md](../../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320).
**Overlapping `private` and `spotlight` zones should be flagged as an authoring warning** — the
combination is almost always a mistake, and it resolves in favour of privacy.

---

## Objects _(phases 9, 10)_

```jsonc
{
  "id": "poster-1",
  "assetId": "uuid-or-builtin-name",
  "transform": { "position": {...}, "rotation": {...}, "scale": {...} },
  "group": "lobby-props",
  "interactive": {
    "contentType": "link" | "image" | "video" | "note" | "document",
    "content": { },
    "interactionRangeM": 2.5,
    "shared": false,
    "persistShared": false
  }
}
```

`interactive` is absent for ordinary props. Its presence is what makes an object interactive
(`FR-10.1`).

`shared: true` routes the object's state through Yjs
([ADR 0012](../../docs/adr/0012-collaborative-state-yjs.md)); `persistShared: true` additionally
snapshots it to the database (`FR-10.16`). Shared state itself is **never** stored in the map
document — the document holds configuration, the CRDT holds content.

---

## Validation

The Zod schema in `packages/protocol` is the single implementation, used on load, on editor
save, and in tests.

Rejected outright:

- Coordinates outside ±327.67 m.
- No spawns, or no default spawn, or more than one default.
- Zone volumes with non-positive dimensions.
- Portal targets naming an unknown `spawnId` within the same map.
- Duplicate ids among spawns, zones or objects.
- Unknown `schemaVersion`.

Warned, not rejected:

- `collisionMode: "convention"` with no `COL_` nodes.
- Overlapping `private` and `spotlight` zones.
- Spawn points inside a collision volume.
- Geometry extending outside `bounds`.

---

## Storage and versioning

| Phase | Where it lives                                                   |
| ----- | ---------------------------------------------------------------- |
| 1–7   | A JSON file beside the GLB in `assets/world/`, served statically |
| 8–10  | `map_versions.document jsonb` in PostgreSQL                      |

Versioning is **copy-forward** and never destructive
([ADR 0008](../../docs/adr/0008-persistence-postgres-typeorm.md)). Publishing inserts a new
`map_versions` row and moves `maps.published_version_id`. Reverting copies an older document
into a _new_ version — which is what lets an author return to the newer one afterwards, as
`FR-9.19` requires.

`schemaVersion` is bumped on any breaking change, and stored documents are migrated forward
rather than reinterpreted.

---

## Related

- [wire-protocol.md](wire-protocol.md) — the quantization that bounds world size
- [coordinates-and-units.md](../conventions/coordinates-and-units.md) — axes, units, scale
- [ADR 0010](../../docs/adr/0010-3d-formats-gltf-vrm.md) — why glTF
- [architecture.md](../../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320) — zone precedence
