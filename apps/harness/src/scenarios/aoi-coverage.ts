/**
 * aoi-coverage — AC-1.5.
 *
 *   > With many simulated participants spread across the world, a single client
 *   > only receives updates for those near it.
 *
 * Spreads N bots over a grid and asserts each one's interest set is EXACTLY the
 * expected set — not a superset, which is what a broken filter produces and
 * what a "did I receive something?" check would miss.
 *
 * ── Why the grid spacing is 11 m and not a round number ─────────────────────
 *
 * With hysteresis, the interest set is PATH-DEPENDENT, not a function of final
 * positions alone. Fifty bots cannot teleport atomically: the server interleaves
 * their transform frames with its own ticks, so a pair can transiently exceed
 * the 30 m exit radius (removed) and then settle at, say, 28.5 m — inside the
 * band, where re-entry is impossible because entering requires 25 m. The pair
 * ends up invisible to each other even though their final distance is well
 * within the exit radius.
 *
 * That is hysteresis behaving correctly. The first version of this scenario
 * assumed simultaneous movement and was flaky for exactly that reason.
 *
 * The fix is geometric: 11 m spacing puts every pairwise distance either at or
 * below 24.60 m or at or above 31.11 m, with nothing in the 25–30 m band.
 * Distances are 11·√k for k = i²+j², and k jumps from 5 (24.60 m) straight to 8
 * (31.11 m) because 6 and 7 are not sums of two squares. With no pair in the
 * band, the final set is path-independent and equals `distance <= enterRadius`.
 *
 * The grid deliberately extends beyond the map's bounds: the room is 24 x 16 m
 * and the interest radius is 25 m, so a world-sized grid would leave everyone
 * mutually visible and test nothing. Movement is client-authoritative and the
 * server does not enforce bounds, so this exercises the interest maths at a
 * useful spread.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertSetsEqual, type Scenario } from '../runner.js';

const BOT_COUNT = Number(process.env.HARNESS_BOT_COUNT ?? 50);
/** See the header: 11 m keeps every pairwise distance out of the 25–30 m
 *  hysteresis band, which is what makes the expected set deterministic. */
const SPACING_M = 11;
const COLUMNS = 8;

export const aoiCoverage: Scenario = {
  name: 'aoi-coverage',
  covers: 'AC-1.5 — a client receives only nearby participants',

  async run(ctx) {
    const bots: Bot[] = [];

    try {
      for (let i = 0; i < BOT_COUNT; i++) {
        const bot = new Bot(ctx.url, `grid-${i}`);
        await bot.connect();
        await bot.join();
        bots.push(bot);
      }

      const tuning = bots[0]!.joined!.tuning;
      const enterRadius = tuning.aoiEnterRadiusM;
      const exitRadius = tuning.aoiExitRadiusM;

      assertNoPairInHysteresisBand(enterRadius, exitRadius);

      // Position them. Three sends spaced across ticks, so a single dropped
      // frame cannot leave a bot at spawn and skew every expectation.
      const positions = bots.map((_, i) => gridPosition(i));
      for (let attempt = 0; attempt < 3; attempt++) {
        bots.forEach((bot, i) => bot.moveTo(positions[i]!.x, positions[i]!.z));
        await sleep(60);
      }

      // One tick recomputes the whole set; the rest is slack.
      await sleep(600);

      const idOf = bots.map((bot) => bot.localId);
      let checked = 0;
      let totalVisible = 0;

      for (let i = 0; i < bots.length; i++) {
        const expected = new Set<number>();
        for (let j = 0; j < bots.length; j++) {
          if (i === j) continue;
          if (planarDistance(positions[i]!, positions[j]!) <= enterRadius) expected.add(idOf[j]!);
        }

        const actual = new Set(bots[i]!.remotes.keys());
        assertSetsEqual(
          actual,
          expected,
          `bot ${i} at (${positions[i]!.x}, ${positions[i]!.z}) has the wrong interest set`,
        );

        checked++;
        totalVisible += actual.size;
      }

      const average = totalVisible / checked;
      assert(
        average < BOT_COUNT - 1,
        `every bot sees every other (${average} of ${BOT_COUNT - 1}) — interest filtering is not happening`,
      );

      ctx.log(
        `${BOT_COUNT} bots on a ${COLUMNS}-wide grid at ${SPACING_M} m spacing · ` +
          `enter ${enterRadius} m / exit ${exitRadius} m, no pair in the band`,
      );
      ctx.log(
        `each sees ${average.toFixed(1)} others on average, not ${BOT_COUNT - 1} — ` +
          `sets match exactly for all ${checked}`,
      );
    } finally {
      for (const bot of bots) bot.close();
      await sleep(100);
    }
  },
};

/**
 * Spacing of 9 m keeps every pairwise distance clear of the 30 m exit radius:
 * distances are 9·√k for integer k, and 9·√k = 30 has no integer solution. A
 * pair landing exactly on the boundary would make this scenario flaky.
 */
function gridPosition(index: number): { x: number; z: number } {
  const rows = Math.ceil(BOT_COUNT / COLUMNS);
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return {
    x: (col - (COLUMNS - 1) / 2) * SPACING_M,
    z: (row - (rows - 1) / 2) * SPACING_M,
  };
}

function planarDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Guard the geometric assumption the whole scenario rests on.
 *
 * If someone retunes the radii, the chosen spacing may start putting pairs in
 * the hysteresis band and this scenario would go intermittently red for a reason
 * that has nothing to do with the code under test. Better to fail immediately,
 * with the arithmetic, than to burn an afternoon on a phantom AOI bug.
 */
function assertNoPairInHysteresisBand(enterRadius: number, exitRadius: number): void {
  const rows = Math.ceil(BOT_COUNT / COLUMNS);
  const offending: string[] = [];

  for (let di = 0; di < COLUMNS; di++) {
    for (let dj = 0; dj < rows; dj++) {
      if (di === 0 && dj === 0) continue;
      const distance = SPACING_M * Math.sqrt(di * di + dj * dj);
      if (distance > enterRadius && distance <= exitRadius) {
        offending.push(`Δ(${di},${dj}) = ${distance.toFixed(2)} m`);
      }
    }
  }

  assert(
    offending.length === 0,
    `grid spacing ${SPACING_M} m puts pairs inside the ${enterRadius}–${exitRadius} m ` +
      `hysteresis band, which makes the expected set path-dependent and this ` +
      `scenario flaky:\n      ${offending.join('\n      ')}\n` +
      `      Pick a spacing where every pairwise distance is <= ${enterRadius} or > ${exitRadius}.`,
  );
}
