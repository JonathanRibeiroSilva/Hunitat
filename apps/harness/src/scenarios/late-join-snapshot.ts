/**
 * late-join-snapshot — AC-1.6.
 *
 *   > A freshly joined client immediately sees the already-present nearby
 *   > participants, not just ones who move afterward.
 *
 * The bug this catches is a server that only sends deltas: the world looks empty
 * until somebody happens to move, which reads as "nobody is here" for anywhere
 * up to several seconds.
 *
 * This is also the one place the ENTER radius can be asserted cleanly. A joiner
 * has no prior interest set, so hysteresis has nothing to preserve and the
 * snapshot must be exactly `distance <= enterRadius`. Everywhere else, shared
 * spawn history means the exit radius governs (see `aoi-coverage`).
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const lateJoinSnapshot: Scenario = {
  name: 'late-join-snapshot',
  covers: 'AC-1.6 — a joiner sees who is already present (and the enter radius)',

  async run(ctx) {
    const near = new Bot(ctx.url, 'snapshot-near');
    const far = new Bot(ctx.url, 'snapshot-far');
    const joiner = new Bot(ctx.url, 'snapshot-joiner');

    try {
      await near.connect();
      await near.join();
      await far.connect();
      await far.join();

      const tuning = near.joined!.tuning;
      const enter = tuning.aoiEnterRadiusM;

      const spawn = near.joined!.spawn;

      // `near` sits a few metres from the spawn; `far` sits well beyond the
      // enter radius but not absurdly far, so a wrong radius shows up rather
      // than being masked.
      near.moveTo(spawn.x + 3, spawn.z);
      far.moveTo(spawn.x, spawn.z + enter + 8);

      for (let i = 0; i < 3; i++) {
        near.sendTransform();
        far.sendTransform();
        await sleep(60);
      }
      await sleep(300);

      // Neither has moved since; a delta-only server would tell the joiner
      // nothing at all.
      await joiner.connect();
      await joiner.join();

      // The snapshot arrives immediately after JOINED, before any tick.
      await waitUntil(() => joiner.snapshot.length > 0, 2000, 'the joiner snapshot');

      const seen = new Set(joiner.snapshot.map((p) => p.id));

      assert(
        seen.has(near.localId),
        'the joiner did not receive the nearby participant in its snapshot',
      );
      assert(
        !seen.has(far.localId),
        `the joiner received a participant ${enter + 8} m away — beyond the ${enter} m enter radius`,
      );
      assertEqual(seen.size, 1, `snapshot contained ${seen.size} participants, expected 1`);

      // The snapshot must carry usable state, not just identifiers.
      const entry = joiner.snapshot.find((p) => p.id === near.localId)!;
      assert(
        Math.abs(entry.transform.x - (spawn.x + 3)) < 0.05,
        `snapshot position was stale: got x=${entry.transform.x}, expected ${spawn.x + 3}`,
      );
      assert(entry.displayName.length > 0, 'snapshot entry had no display name');

      ctx.log(
        `joiner received 1 of 2 present participants — the one within ${enter} m, ` +
          `with a current transform and display name`,
      );
    } finally {
      near.close();
      far.close();
      joiner.close();
      await sleep(100);
    }
  },
};
