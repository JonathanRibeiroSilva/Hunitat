/**
 * spawn-placement — FR-3.6, FR-3.7, AC-3.6.
 *
 *   > Respawn/spawn logic places participants at valid, non-overlapping,
 *   > non-blocked spawns.
 *
 * Two spawn zones in the office declare `least-crowded`, so arrivals must spread
 * between them rather than piling onto the default. And within a spawn, nobody
 * may arrive standing inside somebody else.
 *
 * The overlap assertion is the one worth having. Phase 1 offset arrivals by a
 * random angle inside the spawn radius, which spreads people out *usually* — two
 * unlucky draws still put one avatar inside another, and it shows up as a
 * complaint rather than a test failure.
 */

import { Bot, sleep } from '../bot.js';
import { assert, type Scenario } from '../runner.js';

const ARRIVALS = 6;
/** Two avatar radii: closer than this and they arrive intersecting. */
const MIN_SEPARATION_M = 0.7;

export const spawnPlacement: Scenario = {
  name: 'spawn-placement',
  covers: 'FR-3.6/3.7 — arrivals spread across spawns and never overlap',

  async run(ctx) {
    const bots: Bot[] = [];

    try {
      for (let i = 0; i < ARRIVALS; i++) {
        const bot = new Bot(ctx.url, `arrival-${i}`);
        await bot.connect();
        await bot.join();
        bots.push(bot);
        // Sequential, with the server given a moment to register each arrival:
        // the least-crowded rule counts who is already standing there, and a
        // simultaneous burst would legitimately see the same empty room.
        await sleep(120);
      }

      const spawns = bots.map((bot) => bot.joined!.spawn);

      // FR-3.6 — both least-crowded spawns used.
      const nearMain = spawns.filter((s) => Math.hypot(s.x - 0, s.z - 5) <= 2).length;
      const nearEast = spawns.filter((s) => Math.hypot(s.x - 8, s.z - 5) <= 2).length;

      assert(
        nearMain > 0 && nearEast > 0,
        `all ${ARRIVALS} arrivals went to one spawn (main: ${nearMain}, east: ${nearEast}) — ` +
          'the least-crowded rule is not being applied',
      );

      // FR-3.7 — nobody arrives inside anybody.
      for (let i = 0; i < spawns.length; i++) {
        for (let j = i + 1; j < spawns.length; j++) {
          const distance = Math.hypot(spawns[i]!.x - spawns[j]!.x, spawns[i]!.z - spawns[j]!.z);
          assert(
            distance >= MIN_SEPARATION_M,
            `arrivals ${i} and ${j} spawned ${distance.toFixed(2)} m apart, ` +
              `closer than the ${MIN_SEPARATION_M} m minimum`,
          );
        }
      }

      ctx.log(`${ARRIVALS} arrivals — ${nearMain} at main, ${nearEast} at east, none overlapping`);
    } finally {
      for (const bot of bots) bot.close();
      await sleep(100);
    }
  },
};
