/**
 * Area of interest with hysteresis.
 *
 * FR-1.16 requires each participant to receive only their neighbours, and the
 * Phase 1 Rules forbid the set flapping at a boundary:
 *
 *   > Area-of-interest changes must not flap rapidly at a boundary
 *   > (apply hysteresis or a buffer).
 *
 * The mechanism is TWO radii, not one. You join a set at `enterRadius` and only
 * leave it past the larger `exitRadius`. Someone standing exactly on the
 * boundary therefore stays put instead of generating an add/remove pair every
 * tick. Setting the radii equal reintroduces the bug this exists to prevent.
 */

import { SpatialGrid, type GridPoint } from './spatial-grid.js';

export interface AoiConfig {
  enterRadius: number;
  exitRadius: number;
  cellSize: number;
}

export interface AoiDiff {
  /** Currently in range — the authoritative set for this tick. */
  current: Set<string>;
  /** Newly in range: send PARTICIPANT_ADD (FR-1.17). */
  added: string[];
  /** No longer in range: send PARTICIPANT_REMOVE with reason `out-of-range`. */
  removed: string[];
}

export function assertValidAoiConfig(config: AoiConfig): void {
  if (config.exitRadius <= config.enterRadius) {
    throw new Error(
      `AOI exit radius (${config.exitRadius}) must exceed enter radius ` +
        `(${config.enterRadius}); equal radii reintroduce boundary flapping`,
    );
  }
  if (config.cellSize <= 0) throw new Error('AOI cell size must be positive');
}

/**
 * Compute one observer's interest set and how it changed.
 *
 * `previous` is that observer's set from the last tick — it is what makes the
 * hysteresis work, since membership depends on whether you were already in.
 */
export function computeAoi<T extends GridPoint>(
  observer: GridPoint,
  grid: SpatialGrid<T>,
  previous: ReadonlySet<string>,
  config: AoiConfig,
): AoiDiff {
  // Query at the LARGER radius: anyone previously in the set who now sits
  // between the two radii must still be found, or they would be dropped and
  // immediately re-added.
  const candidates = grid.query(observer.x, observer.z, config.exitRadius, observer.id);

  const enterSq = config.enterRadius * config.enterRadius;
  const exitSq = config.exitRadius * config.exitRadius;

  const current = new Set<string>();
  const added: string[] = [];

  for (const candidate of candidates) {
    const dx = candidate.x - observer.x;
    const dz = candidate.z - observer.z;
    const distSq = dx * dx + dz * dz;

    if (previous.has(candidate.id)) {
      // Already in: keep until past the outer radius.
      if (distSq <= exitSq) current.add(candidate.id);
    } else if (distSq <= enterSq) {
      // Not in yet: only admit inside the inner radius.
      current.add(candidate.id);
      added.push(candidate.id);
    }
  }

  const removed: string[] = [];
  for (const id of previous) {
    if (!current.has(id)) removed.push(id);
  }

  return { current, added, removed };
}
