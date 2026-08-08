/**
 * Zone occupancy — which authored regions a participant is standing in.
 *
 * FR-3.2 wants continuous detection, FR-3.3 wants enter/exit to be prompt and
 * reliable *including under teleport*. Both fall out of recomputing the whole
 * occupancy set each tick from the reported transform: a teleport is not a
 * special case, it is simply a large position delta between two ticks.
 *
 * This is geometry, not physics. The server runs no Rapier (ADR 0005), and
 * point-in-volume tests are exact, allocation-free and identical on every
 * machine — which is what lets the server's answer be authoritative for media
 * while the client computes the same thing locally for presentation.
 *
 * The signature deliberately mirrors `computeAoi`: previous set in, current set
 * plus a diff out, hysteresis in the config. Zone edges and interest edges flap
 * for the same reason, and pretending they are different problems would give the
 * codebase two spellings of one idea.
 *
 * ── Which point ─────────────────────────────────────────────────────────────
 *
 * Occupancy is tested at the participant's reported transform, which is at their
 * feet (the spawn convention in map-document.md). A volume authored to enclose a
 * room therefore wants a `center.y` and `size.y` that reach the floor — a box
 * floating at chest height contains nobody. The Phase 9 editor should make that
 * visible; here it is simply what the numbers mean.
 */

import { pointInVolume, type Zone, type ZoneVolume } from '@hubitat/protocol';

export interface ZonePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ZoneConfig {
  /**
   * How much larger the exit test is than the enter test, in metres.
   *
   * Without it, a participant standing exactly on a private zone's edge toggles
   * isolation every tick — which in Phase 2 terms means their audio connects and
   * disconnects twenty times a second.
   */
  hysteresisM: number;
}

export interface ZoneOccupancy {
  /** Zone ids occupied after this evaluation. */
  current: Set<string>;
  /** Ids in `current` that were not in `previous` (FR-3.17 enter). */
  entered: string[];
  /** Ids in `previous` that are not in `current` (FR-3.17 exit). */
  exited: string[];
}

/**
 * Recompute occupancy against every zone.
 *
 * De-duplication of trigger events (FR-3.18) is structural rather than a rule
 * applied afterwards: `entered` is a set difference, so an id already in
 * `previous` cannot appear in it, and no repeated enter without an intervening
 * exit is representable.
 */
export function computeZoneOccupancy(
  point: ZonePoint,
  zones: readonly Zone[],
  previous: ReadonlySet<string>,
  config: ZoneConfig,
): ZoneOccupancy {
  const current = new Set<string>();
  const entered: string[] = [];

  for (const zone of zones) {
    // The asymmetry IS the hysteresis: leaving requires clearing a slightly
    // larger volume than entering did.
    const wasInside = previous.has(zone.id);
    const margin = wasInside ? config.hysteresisM : 0;
    if (!containsPoint(zone.volume, point, margin)) continue;

    current.add(zone.id);
    if (!wasInside) entered.push(zone.id);
  }

  const exited: string[] = [];
  for (const id of previous) {
    if (!current.has(id)) exited.push(id);
  }

  return { current, entered, exited };
}

/**
 * Point-in-volume, argument-ordered for this module's call sites.
 *
 * The geometry itself lives in `@hubitat/protocol`, beside the schema that says
 * what a volume is — the authoring warnings validate against the same function,
 * so a map that passes validation and a runtime that computes occupancy cannot
 * disagree about where an edge is.
 */
export function containsPoint(volume: ZoneVolume, point: ZonePoint, margin = 0): boolean {
  return pointInVolume(point, volume, margin);
}

/**
 * The private zone that isolates this participant, or null.
 *
 * Overlapping private zones are legal, so "the" zone needs a rule. FR-3.20
 * requires determinism for every combination a participant can be in, and
 * document order would make behaviour depend on how the file happens to be
 * sorted. **Smallest volume wins**, ties broken by id: a booth inside a meeting
 * room isolates you to the booth, which is what authoring one inside the other
 * was for. Order-independent, and stable across re-authoring.
 */
export function privateZoneOf(
  occupancy: ReadonlySet<string>,
  zones: readonly Zone[],
): string | null {
  let chosen: Zone | null = null;
  let chosenSize = Infinity;

  for (const zone of zones) {
    if (zone.type !== 'private' || !occupancy.has(zone.id)) continue;
    const size = volumeSizeM3(zone.volume);
    if (size < chosenSize || (size === chosenSize && chosen !== null && zone.id < chosen.id)) {
      chosen = zone;
      chosenSize = size;
    }
  }

  return chosen?.id ?? null;
}

/** FR-3.12 — standing in any spotlight zone whose scope covers the map. */
export function isInSpotlight(occupancy: ReadonlySet<string>, zones: readonly Zone[]): boolean {
  for (const zone of zones) {
    if (zone.type !== 'spotlight' || !occupancy.has(zone.id)) continue;
    // `scope` currently has one legal value; the default when omitted is the
    // whole map, which is what FR-3.12 describes.
    if ((zone.properties.scope ?? 'map') === 'map') return true;
  }
  return false;
}

export function volumeSizeM3(volume: ZoneVolume): number {
  return volume.shape === 'cylinder'
    ? Math.PI * volume.radius * volume.radius * volume.height
    : volume.size.x * volume.size.y * volume.size.z;
}
