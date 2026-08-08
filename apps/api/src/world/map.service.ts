/**
 * Map Documents — reading them, and placing people inside them.
 *
 * ── What changed in phase 8 ─────────────────────────────────────────────────
 *
 * Until now this class owned *the* map: one document, loaded from disk at boot,
 * exposed as `maps.map` and `maps.zones`. A Space has several Maps from this
 * phase on (`FR-8.1`), so the singular is gone. What is left is the two things
 * that were never about there being only one:
 *
 *   **Reading documents.** From disk at boot, which is where the starter Maps
 *   live beside their GLB; `MapRegistry` takes it from there and the database
 *   becomes authoritative (see its header).
 *
 *   **Placement.** `FR-1.20`, `FR-3.6` and `FR-3.7` — which spawn an arrival
 *   goes to and where inside it they stand. Every one of those functions now
 *   takes the document to apply it to, which is the whole of the change: the
 *   rules did not move, the assumption that there was one map to apply them to
 *   did.
 *
 * Deliberately stateless past the boot-time read. Two participants arriving in
 * two different Maps in the same tick go through the same functions with
 * different documents, and a cached "current map" is exactly the field that
 * would make that quietly wrong.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  TUNING,
  collectMapWarnings,
  mapDocumentSchema,
  type MapDocument,
  type Spawn,
  type Transform,
  type Zone,
} from '@hubitat/protocol';
import { containsPoint, type ZonePoint } from '@hubitat/world-core';
import { loadConfig } from '../config/tuning.config.js';

/** Two avatars may not be placed closer than their diameters, or they arrive
 *  intersecting and the first frame shows one standing inside the other. */
const MIN_SEPARATION_M = TUNING.AVATAR_RADIUS_M * 2;

/** Candidate points tried inside a spawn area before giving up and using its
 *  centre. Twelve covers a 1.5 m disc densely enough that a free slot is found
 *  whenever one exists, and costs nothing at join rate. */
const PLACEMENT_SAMPLES = 12;

/** A document as it was found on disk, with the file it came from. */
export interface DiskMap {
  /** The `<id>` in `<id>.map.json`, which is also the document's own id and the
   *  slug the Map is seeded under. */
  slug: string;
  document: MapDocument;
}

@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);
  private readonly config = loadConfig();

  /**
   * Phase 4 — the avatar model, told to the client rather than assumed by it.
   *
   * The one URL still owned by this class rather than by a document, and it
   * stays here for the reason it always did: nobody uploads it, it is the same
   * for every Map, and giving it a per-map spelling would invite fifteen Maps to
   * disagree about what people look like.
   */
  get avatarModelUrl(): string {
    return `${this.config.avatarAssetBaseUrl}/${this.config.avatarModelId}.glb`;
  }

  /**
   * Every `*.map.json` beside the world assets, validated.
   *
   * The starter catalogue. `MapRegistry` seeds the database from it once and
   * then stops reading it — so adding a file to `assets/world` adds a Map to a
   * fresh deployment and does nothing at all to an established one, which is the
   * correct behaviour for both: a new install gets a building with rooms in it,
   * and an existing install does not have Maps appear because somebody dropped a
   * file on the server.
   *
   * A document that fails validation is **skipped with a warning**, not fatal.
   * Phase 1 refused to boot on a bad map because there was one and a server
   * without it had nothing to serve; with a catalogue, refusing would let one
   * malformed file take down a Space whose other five Maps are fine. The one
   * exception is below.
   */
  loadFromDisk(): DiskMap[] {
    const root = join(assetsRoot(), 'world');

    let files: string[];
    try {
      files = readdirSync(root).filter((name) => name.endsWith('.map.json'));
    } catch (error) {
      throw new Error(
        `Could not read the world asset directory at ${root}: ${(error as Error).message}. ` +
          `Run "node assets/world/build-world.mjs" to generate the starter maps.`,
      );
    }

    const maps: DiskMap[] = [];
    for (const file of files.sort()) {
      const slug = file.slice(0, -'.map.json'.length);
      const path = join(root, file);

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        this.logger.warn(`Skipping ${file}: ${(error as Error).message}`);
        continue;
      }

      const parsed = mapDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(`Skipping ${file}: ${parsed.error.toString()}`);
        continue;
      }

      // Warnings are legal-but-probably-wrong conditions. Rejecting them would
      // block valid authoring; staying silent lets real mistakes ship.
      for (const warning of collectMapWarnings(parsed.data)) {
        this.logger.warn(`[${slug}] [${warning.code}] ${warning.message}`);
      }

      maps.push({ slug, document: parsed.data });
      this.logger.log(
        `Read map "${parsed.data.name}" (${slug}) — ${parsed.data.spawns.length} spawn(s), ` +
          `${parsed.data.zones.length} zone(s), ${parsed.data.objects.length} object(s)`,
      );
    }

    // The Phase 1 Rules require a clear failure rather than an empty void, and
    // on the server that means refusing to boot rather than booting into a Space
    // with nowhere to stand. A catalogue with nothing in it is that failure; one
    // bad file among five is not.
    if (maps.length === 0) {
      throw new Error(
        `No valid map documents found in ${root}. A Space needs at least one Map to land ` +
          `people on (FR-8.7). Run "node assets/world/build-world.mjs" to generate the ` +
          `starter maps, or check the warnings above for why the ones present were skipped.`,
      );
    }

    return maps;
  }

  /** The starter document a Map created through the API begins with, when the
   *  caller did not ask to copy an existing one. The Space's landing Map, which
   *  is the one most likely to be laid out the way its owner wants. */
  get starterSlug(): string {
    return this.config.worldMapId;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Placement — FR-1.20, FR-3.6, FR-3.7
  //
  // Unchanged rules, now taking the document they apply to. Every one of these
  // was a method on "the map"; the only difference is that the map is an
  // argument.
  // ───────────────────────────────────────────────────────────────────────────

  spawnById(document: MapDocument, id: string | undefined): Spawn | undefined {
    if (!id) return undefined;
    return document.spawns.find((spawn) => spawn.id === id);
  }

  /** The document's own default, for an arrival that named no spawn (`FR-8.7`). */
  defaultSpawn(document: MapDocument): Spawn {
    return document.spawns.find((spawn) => spawn.default) ?? document.spawns[0]!;
  }

  /**
   * FR-1.20 / FR-3.6 / FR-3.7 — choose a spawn, then a clear point inside it.
   *
   * `occupied` is where everyone currently standing **in this Map instance** is.
   * Passing the whole world would spread arrivals away from people they cannot
   * see, in a room they are not in.
   */
  pickSpawn(document: MapDocument, occupied: readonly ZonePoint[] = []): Transform {
    return this.placeInSpawn(document, this.chooseSpawn(document, occupied), occupied);
  }

  /**
   * FR-3.6 — which spawn an arrival is placed at.
   *
   * The rule lives on `spawn` zones, which name a spawn through `spawnId`. If any
   * of them asks for `least-crowded`, arrivals are spread across the spawns those
   * zones name; otherwise the single `default` spawn is used. A portal that names
   * a spawn outranks both — that is the whole point of naming one.
   *
   * A map with no spawn zones therefore behaves exactly as it did in Phase 1,
   * which is what keeps the existing office map working unchanged.
   */
  chooseSpawn(document: MapDocument, occupied: readonly ZonePoint[]): Spawn {
    const fallback = this.defaultSpawn(document);

    const candidates = document.zones
      .filter((zone) => zone.type === 'spawn' && zone.properties.rule === 'least-crowded')
      .map((zone) => this.spawnById(document, zone.properties.spawnId))
      .filter((spawn): spawn is Spawn => spawn !== undefined);

    if (candidates.length === 0) return fallback;

    let best = candidates[0]!;
    let bestCount = Infinity;
    for (const spawn of candidates) {
      // Counted within the spawn's own radius: "crowded" means people standing
      // where the arrival would land, not people elsewhere in the map.
      let count = 0;
      for (const point of occupied) {
        if (horizontalDistance(point, spawn.position) <= spawn.radiusM) count++;
      }
      if (count < bestCount) {
        best = spawn;
        bestCount = count;
      }
    }

    return best;
  }

  /**
   * FR-3.7 — a point inside the spawn area that is neither inside a collision
   * volume nor on top of somebody.
   *
   * Sampled on a fixed spiral rather than randomly: an arrival that lands in the
   * same place twice is easy to reason about, and the occupancy check is what
   * actually spreads people out. If nothing is clear — a spawn area genuinely
   * full — the centre is used. Refusing to place someone is not an option the
   * requirement leaves open.
   *
   * Only authored `collision` zones are checked. The `COL_` meshes from the GLB
   * exist solely in the client (ADR 0005), so a spawn placed badly against those
   * is an authoring problem the map document cannot see. That is the reason
   * `collisionMode: "explicit"` exists.
   */
  placeInSpawn(
    document: MapDocument,
    spawn: Spawn,
    occupied: readonly ZonePoint[],
    options: { avoidZones?: readonly Zone[]; avoidMarginM?: number } = {},
  ): Transform {
    const collision = document.zones.filter((zone) => zone.type === 'collision');
    const avoid = options.avoidZones ?? [];
    const margin = options.avoidMarginM ?? 0;

    for (let i = 0; i < PLACEMENT_SAMPLES; i++) {
      // Golden angle, so successive samples do not clump on one side.
      const t = (i + 0.5) / PLACEMENT_SAMPLES;
      const radius = Math.sqrt(t) * spawn.radiusM;
      const angle = i * 2.399963229728653;

      const candidate: ZonePoint = {
        x: spawn.position.x + Math.cos(angle) * radius,
        y: spawn.position.y,
        z: spawn.position.z + Math.sin(angle) * radius,
      };

      // Grown by the avatar radius: an arrival is a capsule, not a point, and a
      // centre that is technically outside a table still puts half a person
      // inside it. The client's controller would shove them out on the first
      // frame, which reads as arriving with a jolt.
      if (collision.some((zone) => containsPoint(zone.volume, candidate, TUNING.AVATAR_RADIUS_M))) {
        continue;
      }
      if (avoid.some((zone) => containsPoint(zone.volume, candidate, margin))) continue;
      if (occupied.some((point) => horizontalDistance(point, candidate) < MIN_SEPARATION_M))
        continue;

      return { ...candidate, yaw: spawn.yaw };
    }

    return { ...spawn.position, yaw: spawn.yaw };
  }
}

/** Horizontal only: two people on different floors of a stairwell are not
 *  "stacked", and spawn radii are authored as ground-plane discs. */
function horizontalDistance(a: ZonePoint, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Repo-root `assets/`, resolved from the compiled output at apps/api/dist. */
export function assetsRoot(): string {
  const fromEnv = process.env.ASSETS_DIR;
  if (fromEnv) return fromEnv;
  return join(process.cwd(), '..', '..', 'assets');
}
