/**
 * private-zone-isolation — FR-3.8, FR-3.9, FR-3.10, AC-3.2.
 *
 * The Phase 3 risks section names this one:
 *
 *   > Private-zone isolation must be verified from the outside. The natural test
 *   > is "can the two people inside hear each other" — the requirement that
 *   > actually breaks is FR-3.9, whether someone standing just outside is
 *   > properly cut off, in both directions.
 *
 * So the outsider is placed 3.5 m from the insiders. That is well inside
 * MAX_AUDIBLE_DISTANCE_M: if isolation is not applied, proximity connects them
 * and this fails. A test with the outsider parked 40 m away would pass against a
 * server that had no zone logic at all.
 *
 * Both directions are asserted separately. Symmetry is structural in
 * resolveAudience — `universe(listener) ∩ universe(speaker)` is commutative — but
 * "it should be symmetric by construction" is exactly the kind of claim that
 * stops being true when someone adds a special case.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

/** Inside `huddle-meeting`: x ∈ [-12.1, -5.1], z ∈ [-8.1, -2.9]. */
const INSIDE_A = { x: -8, z: -5 };
const INSIDE_B = { x: -10, z: -6 };
/** Outside the east edge, and close enough that proximity alone would connect. */
const OUTSIDE = { x: -4.5, z: -5 };

export const privateZoneIsolation: Scenario = {
  name: 'private-zone-isolation',
  covers: 'FR-3.8/3.9/3.10 — a private zone isolates, in both directions',

  async run(ctx) {
    const alice = new Bot(ctx.url, 'huddle-alice');
    const bob = new Bot(ctx.url, 'huddle-bob');
    const carol = new Bot(ctx.url, 'huddle-outsider');

    try {
      for (const bot of [alice, bob, carol]) {
        await bot.connect();
        await bot.join();
      }

      alice.moveTo(INSIDE_A.x, INSIDE_A.z);
      bob.moveTo(INSIDE_B.x, INSIDE_B.z);
      carol.moveTo(OUTSIDE.x, OUTSIDE.z);

      await waitUntil(
        () => alice.zoneEventsFor('huddle-meeting').length > 0,
        3000,
        'alice to be recorded inside the private zone',
      );
      // One extra tick, so every audience has settled at the final positions.
      await sleep(200);

      const separation = Math.hypot(INSIDE_A.x - OUTSIDE.x, INSIDE_A.z - OUTSIDE.z);
      ctx.log(`outsider is ${separation.toFixed(1)} m from alice — proximity range is 12 m`);

      // FR-3.8 — inside, distance stops mattering.
      const aliceHearsBob = alice.hears(bob.localId);
      assert(aliceHearsBob !== undefined, 'alice cannot hear bob inside the same private zone');
      assertEqual(
        aliceHearsBob.reason,
        'private-zone',
        'alice hears bob, but by proximity — the zone is not being applied',
      );
      assertEqual(aliceHearsBob.gain, 1, 'private-zone audio should not be attenuated by distance');

      // FR-3.9 — the outsider, in both directions.
      assert(
        alice.hears(carol.localId) === undefined,
        `alice can hear the outsider standing ${separation.toFixed(1)} m away — isolation leaks outward`,
      );
      assert(
        carol.hears(alice.localId) === undefined,
        'the outsider can hear alice — isolation leaks inward',
      );
      assert(
        carol.hears(bob.localId) === undefined,
        'the outsider can hear bob — isolation leaks inward',
      );

      // FR-3.10 — leaving restores proximity.
      alice.moveTo(OUTSIDE.x, OUTSIDE.z - 1);
      await waitUntil(
        () => alice.hears(carol.localId) !== undefined,
        3000,
        'alice to hear the outsider again after leaving the zone',
      );

      const restored = alice.hears(carol.localId)!;
      assertEqual(restored.reason, 'proximity', 'left the zone but audience is still zone-scoped');
      assertEqual(
        alice.zoneEventsFor('huddle-meeting').filter((e) => e.kind === 'exit').length,
        1,
        'expected exactly one exit event on leaving',
      );

      ctx.log('isolated in both directions, and proximity restored on exit');
    } finally {
      alice.close();
      bob.close();
      carol.close();
      await sleep(100);
    }
  },
};
