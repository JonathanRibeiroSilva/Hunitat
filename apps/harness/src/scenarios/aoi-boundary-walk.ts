/**
 * aoi-boundary-walk — FR-1.17 and the Phase 1 anti-flap rule.
 *
 *   > Area-of-interest changes must not flap rapidly at a boundary
 *   > (apply hysteresis or a buffer).
 *
 * This is the scenario that would catch the classic bug. With a single radius,
 * a participant hovering at 24.5 ↔ 25.5 m generates an add and a remove on
 * almost every tick — dozens of events, avatars strobing in and out. With two
 * radii they enter once at 24.5 m and stay until past 30 m.
 *
 * The assertion is therefore exact: crossing in once and out once must produce
 * exactly one add and one remove, no matter how long the walker loiters on the
 * boundary in between.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assertEqual, type Scenario } from '../runner.js';

const OSCILLATIONS = 20;

export const aoiBoundaryWalk: Scenario = {
  name: 'aoi-boundary-walk',
  covers: 'FR-1.17 — interest set does not flap at a boundary',

  async run(ctx) {
    const observer = new Bot(ctx.url, 'boundary-observer');
    const walker = new Bot(ctx.url, 'boundary-walker');

    try {
      await observer.connect();
      await walker.connect();
      await observer.join();
      await walker.join();

      const tuning = observer.joined!.tuning;
      const enter = tuning.aoiEnterRadiusM;
      const exit = tuning.aoiExitRadiusM;
      const band = exit - enter;

      observer.moveTo(0, 0);

      // Both joined at the shared spawn, so they start inside each other's sets.
      // Push the walker well beyond the exit radius first, so the measured phase
      // starts from a known-empty state rather than from spawn history.
      walker.moveTo(exit + 20, 0);
      await waitUntil(
        () => !observer.remotes.has(walker.localId),
        3000,
        'walker to leave the interest set before the measured phase',
      );

      observer.resetEvents();

      // Cross inward: one add.
      walker.moveTo(enter - 0.5, 0);
      await waitUntil(
        () => observer.remotes.has(walker.localId),
        3000,
        'walker to enter the interest set',
      );

      // Loiter across the enter radius. Under a single-radius implementation
      // each of these crossings costs an add/remove pair.
      for (let i = 0; i < OSCILLATIONS; i++) {
        walker.moveTo(enter - 0.5, 0);
        await sleep(60);
        walker.moveTo(enter + 0.5, 0);
        await sleep(60);
      }

      // Also loiter inside the hysteresis band, where a naive exit check fires.
      for (let i = 0; i < OSCILLATIONS; i++) {
        walker.moveTo(enter + band * 0.3, 0);
        await sleep(60);
        walker.moveTo(exit - 0.5, 0);
        await sleep(60);
      }

      assertEqual(
        observer.events.adds,
        1,
        `expected exactly one add across ${OSCILLATIONS * 2} boundary crossings`,
      );
      assertEqual(
        observer.events.removes,
        0,
        'walker was removed while still inside the exit radius',
      );

      // Cross outward: one remove.
      walker.moveTo(exit + 5, 0);
      await waitUntil(
        () => !observer.remotes.has(walker.localId),
        3000,
        'walker to leave the interest set',
      );

      assertEqual(observer.events.adds, 1, 'extra add events after leaving');
      assertEqual(observer.events.removes, 1, 'expected exactly one remove');

      ctx.log(
        `enter ${enter} m / exit ${exit} m · ${OSCILLATIONS * 2} crossings of the enter radius`,
      );
      ctx.log('result: 1 add, 1 remove — hysteresis holding');
    } finally {
      observer.close();
      walker.close();
      await sleep(100);
    }
  },
};
