/**
 * Uniform spatial hash grid.
 *
 * FR-1.16 requires a participant to receive updates only for those near them.
 * A naive distance sort is O(n²) per tick — fine at 50 participants and wrong by
 * construction. With cell size ≈ the interest radius, a query touches 9 cells
 * and stays flat as the world grows.
 *
 * Only the XZ plane is bucketed. Vertical spread in these worlds is small
 * relative to the interest radius, so a third dimension would add cells without
 * removing candidates.
 */

export interface GridPoint {
  readonly id: string;
  readonly x: number;
  readonly z: number;
}

export class SpatialGrid<T extends GridPoint> {
  private readonly cells = new Map<number, T[]>();

  constructor(private readonly cellSize: number) {
    if (cellSize <= 0) throw new Error('cellSize must be positive');
  }

  clear(): void {
    this.cells.clear();
  }

  insert(item: T): void {
    const key = this.cellKey(item.x, item.z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(item);
    else this.cells.set(key, [item]);
  }

  rebuild(items: Iterable<T>): void {
    this.clear();
    for (const item of items) this.insert(item);
  }

  /**
   * Every item within `radius` of (x, z), excluding `excludeId`.
   *
   * Returns items from the 3x3 cell neighbourhood filtered by true distance, so
   * the result is exact — the grid only narrows the candidate set.
   */
  query(x: number, z: number, radius: number, excludeId?: string): T[] {
    const cellRadius = Math.ceil(radius / this.cellSize);
    const centreX = Math.floor(x / this.cellSize);
    const centreZ = Math.floor(z / this.cellSize);
    const radiusSq = radius * radius;

    const found: T[] = [];
    for (let cz = centreZ - cellRadius; cz <= centreZ + cellRadius; cz++) {
      for (let cx = centreX - cellRadius; cx <= centreX + cellRadius; cx++) {
        const bucket = this.cells.get(hashCell(cx, cz));
        if (!bucket) continue;
        for (const item of bucket) {
          if (item.id === excludeId) continue;
          const dx = item.x - x;
          const dz = item.z - z;
          if (dx * dx + dz * dz <= radiusSq) found.push(item);
        }
      }
    }
    return found;
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.cells.values()) total += bucket.length;
    return total;
  }

  private cellKey(x: number, z: number): number {
    return hashCell(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
  }
}

/**
 * Pack two signed cell coordinates into one number key.
 *
 * A Map<number> lookup is materially faster than a Map<string> with template
 * keys, and this runs 50 times a tick, 20 times a second.
 */
function hashCell(cx: number, cz: number): number {
  return (cx & 0xffff) * 0x10000 + (cz & 0xffff);
}

export function distanceSq(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function distance3D(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
