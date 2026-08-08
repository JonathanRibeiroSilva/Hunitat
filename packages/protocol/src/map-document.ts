/**
 * Map Document schema. See specs/protocol/map-document.md.
 *
 * Defined in full now — including the zone and interactive-object fields nothing
 * reads yet — because Phase 1 loads one (FR-1.18), Phase 3 stores zones in one
 * (FR-3.1), Phase 9 writes them (DC-9.1) and Phase 10 stores object config in
 * one (FR-10.15). Inventing the format twice would break everything built in
 * between.
 */

import { z } from 'zod';
import { POSITION_MAX_M, POSITION_MIN_M } from './binary.js';

export const MAP_SCHEMA_VERSION = 1;

/**
 * Every coordinate must survive the i16-centimetre wire quantization. A map
 * exceeding this cannot be represented, so it is rejected at validation rather
 * than discovered as visual corruption at runtime.
 */
const coordinate = z.number().finite().min(POSITION_MIN_M).max(POSITION_MAX_M);

export const vec3Schema = z.object({
  x: coordinate,
  y: coordinate,
  z: coordinate,
});

export const eulerSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

export const scaleSchema = z.object({
  x: z.number().finite().positive(),
  y: z.number().finite().positive(),
  z: z.number().finite().positive(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Core (phase 1)
// ─────────────────────────────────────────────────────────────────────────────

export const boundsSchema = z.object({
  min: vec3Schema,
  max: vec3Schema,
});

export const geometrySchema = z.object({
  url: z.string().min(1),
  /**
   * `convention` derives colliders from `COL_`-prefixed node names in the GLB.
   * `explicit` uses only the collision volumes declared in `zones`.
   */
  collisionMode: z.enum(['convention', 'explicit']).default('convention'),
});

export const spawnSchema = z.object({
  id: z.string().min(1),
  position: vec3Schema,
  yaw: z.number().finite().default(0),
  default: z.boolean().default(false),
  /** Arrivals are offset within this radius so they do not stack (FR-3.7). */
  radiusM: z.number().positive().default(1.5),
});

export const environmentSchema = z.object({
  ambientColor: z.string().default('#ffffff'),
  ambientIntensity: z.number().min(0).default(0.6),
  sunDirection: eulerSchema.default({ x: -0.5, y: -1, z: -0.3 }),
  sunColor: z.string().default('#fff5e6'),
  sunIntensity: z.number().min(0).default(1.2),
  background: z.string().default('#87ceeb'),
  fog: z
    .object({
      color: z.string(),
      near: z.number().positive(),
      far: z.number().positive(),
    })
    .optional(),
});

export const movementSchema = z.object({
  allowJump: z.boolean().default(true),
  walkSpeedMultiplier: z.number().positive().default(1.0),
});

// ─────────────────────────────────────────────────────────────────────────────
// Zones (phase 3)
// ─────────────────────────────────────────────────────────────────────────────

export const zoneVolumeSchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('box'),
    center: vec3Schema,
    size: scaleSchema,
    yaw: z.number().finite().default(0),
  }),
  z.object({
    shape: z.literal('cylinder'),
    center: vec3Schema,
    radius: z.number().positive(),
    height: z.number().positive(),
  }),
]);

export const zoneTypeSchema = z.enum([
  'collision',
  'spawn',
  'private',
  'spotlight',
  'portal',
  'trigger',
]);

export const portalTargetSchema = z.object({
  /** Omitted means a teleport within this map. When present, Phase 8 resolves it
   *  — Phase 3 deliberately keeps the reference abstract (FR-3.15). */
  mapId: z.string().optional(),
  spawnId: z.string().min(1),
});

export const zoneSchema = z.object({
  id: z.string().min(1),
  type: zoneTypeSchema,
  volume: zoneVolumeSchema,
  properties: z
    .object({
      spawnId: z.string().optional(),
      rule: z.enum(['default', 'least-crowded']).optional(),
      gain: z.number().min(0).max(1).optional(),
      scope: z.enum(['map']).optional(),
      target: portalTargetSchema.optional(),
      key: z.string().optional(),
      chatEnabled: z.boolean().optional(),
    })
    .default({}),
});

// ─────────────────────────────────────────────────────────────────────────────
// Objects (phases 9, 10)
// ─────────────────────────────────────────────────────────────────────────────

export const interactiveContentSchema = z.object({
  /**
   * A closed enum, deliberately. AC-10.6 requires confirming that no generic
   * third-party app hosting exists — adding a type is a code change and a schema
   * bump, not configuration.
   */
  contentType: z.enum(['link', 'image', 'video', 'note', 'document']),
  content: z.record(z.unknown()).default({}),
  interactionRangeM: z.number().positive().optional(),
  shared: z.boolean().default(false),
  persistShared: z.boolean().default(false),
});

export const placedObjectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  transform: z.object({
    position: vec3Schema,
    rotation: eulerSchema.default({ x: 0, y: 0, z: 0 }),
    scale: scaleSchema.default({ x: 1, y: 1, z: 1 }),
  }),
  group: z.string().optional(),
  interactive: interactiveContentSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export const mapDocumentSchema = z
  .object({
    schemaVersion: z.literal(MAP_SCHEMA_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    bounds: boundsSchema,
    geometry: geometrySchema,
    spawns: z.array(spawnSchema).min(1),
    environment: environmentSchema.default({}),
    zones: z.array(zoneSchema).default([]),
    objects: z.array(placedObjectSchema).default([]),
    movement: movementSchema.default({}),
  })
  .superRefine((doc, ctx) => {
    const defaults = doc.spawns.filter((s) => s.default);
    if (defaults.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spawns'],
        message: `exactly one spawn must be marked default, found ${defaults.length}`,
      });
    }

    reportDuplicates(
      doc.spawns.map((s) => s.id),
      'spawns',
      ctx,
    );
    reportDuplicates(
      doc.zones.map((z) => z.id),
      'zones',
      ctx,
    );
    reportDuplicates(
      doc.objects.map((o) => o.id),
      'objects',
      ctx,
    );

    // Same-map portal targets must resolve. Cross-map targets carry a mapId and
    // are Phase 8's problem, not ours.
    const spawnIds = new Set(doc.spawns.map((s) => s.id));
    for (const zone of doc.zones) {
      const target = zone.properties.target;
      if (zone.type === 'portal' && target && !target.mapId && !spawnIds.has(target.spawnId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['zones'],
          message: `portal "${zone.id}" targets unknown spawn "${target.spawnId}"`,
        });
      }
    }

    if (
      doc.bounds.min.x >= doc.bounds.max.x ||
      doc.bounds.min.y >= doc.bounds.max.y ||
      doc.bounds.min.z >= doc.bounds.max.z
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bounds'],
        message: 'bounds.min must be strictly less than bounds.max on every axis',
      });
    }
  });

function reportDuplicates(ids: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `duplicate id "${id}"`,
      });
    }
    seen.add(id);
  }
}

export type MapDocument = z.infer<typeof mapDocumentSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type ZoneType = z.infer<typeof zoneTypeSchema>;
/** Exported because `world-core` does the point-in-volume tests and must not
 *  restate this shape — a second spelling of a volume is a second set of edge
 *  cases (FR-3.2). */
export type ZoneVolume = z.infer<typeof zoneVolumeSchema>;
export type PortalTarget = z.infer<typeof portalTargetSchema>;
export type Spawn = z.infer<typeof spawnSchema>;
export type PlacedObject = z.infer<typeof placedObjectSchema>;
export type Bounds = z.infer<typeof boundsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Node naming convention
//
// glTF has no notion of "this mesh is collision". Semantics come from node name
// prefixes, and getting this wrong means either no collision or a grey mass of
// invisible geometry rendering. Both failures are immediate and obvious, which
// is why a prefix beats a metadata extension.
// ─────────────────────────────────────────────────────────────────────────────

export const NODE_PREFIX = {
  COLLISION: 'COL_',
  SPAWN: 'SPAWN_',
  NAV: 'NAV_',
} as const;

export function isCollisionNode(name: string): boolean {
  return name.startsWith(NODE_PREFIX.COLLISION);
}

export function isSpawnNode(name: string): boolean {
  return name.startsWith(NODE_PREFIX.SPAWN);
}

/** Nodes that participate in the simulation but must never be rendered. */
export function isHiddenNode(name: string): boolean {
  return (
    name.startsWith(NODE_PREFIX.COLLISION) ||
    name.startsWith(NODE_PREFIX.SPAWN) ||
    name.startsWith(NODE_PREFIX.NAV)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings
//
// Conditions that are legal but usually mistakes. Rejecting them would block
// valid authoring; staying silent lets real errors ship.
// ─────────────────────────────────────────────────────────────────────────────

export interface MapWarning {
  code: 'overlapping-private-spotlight' | 'spawn-in-collision' | 'no-collision-nodes';
  message: string;
}

export function collectMapWarnings(doc: MapDocument): MapWarning[] {
  const warnings: MapWarning[] = [];

  const privates = doc.zones.filter((z) => z.type === 'private');
  const spotlights = doc.zones.filter((z) => z.type === 'spotlight');

  for (const priv of privates) {
    for (const spot of spotlights) {
      if (volumesOverlap(priv.volume, spot.volume)) {
        warnings.push({
          code: 'overlapping-private-spotlight',
          message:
            `zone "${spot.id}" (spotlight) overlaps "${priv.id}" (private). ` +
            'Isolation wins: the spotlight will only reach the private zone. ' +
            'See docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320',
        });
      }
    }
  }

  const collisionZones = doc.zones.filter((z) => z.type === 'collision');
  for (const spawn of doc.spawns) {
    if (collisionZones.some((z) => pointInVolume(spawn.position, z.volume))) {
      warnings.push({
        code: 'spawn-in-collision',
        message: `spawn "${spawn.id}" sits inside a collision volume`,
      });
    }
  }

  return warnings;
}

type Volume = z.infer<typeof zoneVolumeSchema>;

function volumeAabb(volume: Volume): { min: Vec3; max: Vec3 } {
  if (volume.shape === 'box') {
    const h = {
      x: volume.size.x / 2,
      y: volume.size.y / 2,
      z: volume.size.z / 2,
    };
    return {
      min: {
        x: volume.center.x - h.x,
        y: volume.center.y - h.y,
        z: volume.center.z - h.z,
      },
      max: {
        x: volume.center.x + h.x,
        y: volume.center.y + h.y,
        z: volume.center.z + h.z,
      },
    };
  }
  return {
    min: {
      x: volume.center.x - volume.radius,
      y: volume.center.y - volume.height / 2,
      z: volume.center.z - volume.radius,
    },
    max: {
      x: volume.center.x + volume.radius,
      y: volume.center.y + volume.height / 2,
      z: volume.center.z + volume.radius,
    },
  };
}

/** Conservative AABB test. A yawed box reports overlap slightly early, which for
 *  a warning is the right direction to err. */
function volumesOverlap(a: Volume, b: Volume): boolean {
  const boxA = volumeAabb(a);
  const boxB = volumeAabb(b);
  return (
    boxA.min.x <= boxB.max.x &&
    boxA.max.x >= boxB.min.x &&
    boxA.min.y <= boxB.max.y &&
    boxA.max.y >= boxB.min.y &&
    boxA.min.z <= boxB.max.z &&
    boxA.max.z >= boxB.min.z
  );
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Point-in-volume — the single definition. Zone occupancy (FR-3.2), spawn
 * placement (FR-3.7) and the authoring warnings above all resolve here.
 *
 * `margin` grows the volume outward, which is what makes zone hysteresis
 * possible: the exit test is the same volume with a little added. A negative
 * margin shrinks it, which is how placement asks "is this comfortably clear"
 * rather than "is this technically outside".
 *
 * Lives in `protocol`, beside the schema that defines what a volume *is*, rather
 * than in `world-core` where it is used. A second implementation would be a
 * second set of boundary cases to keep in step, and the two callers that matter
 * — the server's occupancy and the client's local prediction — disagreeing at a
 * boundary is the bug this arrangement exists to prevent.
 */
export function pointInVolume(point: Vec3, volume: Volume, margin = 0): boolean {
  if (volume.shape === 'cylinder') {
    const radius = volume.radius + margin;
    if (radius <= 0) return false;
    const dx = point.x - volume.center.x;
    const dz = point.z - volume.center.z;
    const withinRadius = dx * dx + dz * dz <= radius * radius;
    const withinHeight = Math.abs(point.y - volume.center.y) <= volume.height / 2 + margin;
    return withinRadius && withinHeight;
  }

  // Rotate the point into the box's local frame rather than rotating the box.
  const cos = Math.cos(-volume.yaw);
  const sin = Math.sin(-volume.yaw);
  const dx = point.x - volume.center.x;
  const dz = point.z - volume.center.z;
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;

  return (
    Math.abs(localX) <= volume.size.x / 2 + margin &&
    Math.abs(point.y - volume.center.y) <= volume.size.y / 2 + margin &&
    Math.abs(localZ) <= volume.size.z / 2 + margin
  );
}
