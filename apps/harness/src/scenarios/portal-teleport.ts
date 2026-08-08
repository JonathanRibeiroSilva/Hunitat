/**
 * portal-teleport — FR-3.14, FR-3.16, AC-3.4 and the re-trigger rule.
 *
 * The interesting requirement is not "does it move you". It is:
 *
 *   > A participant teleported by a portal must not immediately re-trigger the
 *   > same portal.
 *
 * A naive implementation teleports, the participant is standing on a portal
 * again next tick, and they bounce between two destinations forever. So the
 * scenario stands still at the destination and asserts that nothing else
 * happens — the absence of a second FORCE_TRANSFORM is the whole point.
 *
 * `portal-to-meeting` lands inside `huddle-meeting`, which also covers FR-3.16:
 * zone membership at the destination must be established, not inherited from
 * where the participant was standing a moment ago.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertClose, assertEqual, type Scenario } from '../runner.js';

/** `portal-to-meeting`: a cylinder at (10.5, 6.5), radius 0.9. */
const PORTAL = { x: 10.5, z: 6.5 };
/** Spawn `meeting`, the portal's declared destination. */
const DESTINATION = { x: -6.5, z: -4.1 };
/** Longer than PORTAL_COOLDOWN_MS, so a re-trigger would have had time to fire. */
const SETTLE_MS = 2200;

export const portalTeleport: Scenario = {
  name: 'portal-teleport',
  covers: 'FR-3.14/3.16 — a portal delivers you once, with zone state re-established',

  async run(ctx) {
    const traveller = new Bot(ctx.url, 'portal-traveller');

    try {
      await traveller.connect();
      await traveller.join();

      traveller.moveTo(0, 0);
      await sleep(200);
      traveller.resetEvents();

      traveller.moveTo(PORTAL.x, PORTAL.z);
      await waitUntil(() => traveller.forced.length > 0, 3000, 'the portal to fire');

      const jump = traveller.forced[0]!;
      assertEqual(jump.reason, 'portal', 'position was overridden, but not by a portal');
      assertClose(jump.transform.x, DESTINATION.x, 1.0, 'arrived at the wrong x');
      assertClose(jump.transform.z, DESTINATION.z, 1.0, 'arrived at the wrong z');

      // FR-3.16 — membership at the destination, in the same breath as arriving.
      await waitUntil(
        () => traveller.zoneEventsFor('huddle-meeting').some((event) => event.kind === 'enter'),
        3000,
        'zone membership to be established at the destination',
      );

      // The portal must appear as a clean exit, not be left hanging as somewhere
      // the traveller is still standing.
      const portalEvents = traveller.zoneEventsFor('portal-to-meeting');
      assertEqual(
        portalEvents.filter((e) => e.kind === 'enter').length,
        1,
        'expected exactly one portal enter',
      );
      assertEqual(
        portalEvents.filter((e) => e.kind === 'exit').length,
        1,
        'the portal was entered but never exited — occupancy is stale after the jump',
      );

      // The re-trigger rule. Standing still at the destination, past the cooldown.
      await sleep(SETTLE_MS);
      assertEqual(
        traveller.forced.length,
        1,
        `the portal fired ${traveller.forced.length} times — arrival is not clear of a portal`,
      );

      assert(
        traveller.events.errors.length === 0,
        `unexpected error frames: ${traveller.events.errors.map((e) => e.code).join(', ')}`,
      );

      ctx.log(
        `(${PORTAL.x}, ${PORTAL.z}) → (${jump.transform.x.toFixed(1)}, ` +
          `${jump.transform.z.toFixed(1)}) · one jump, still settled after ${SETTLE_MS} ms`,
      );
    } finally {
      traveller.close();
      await sleep(100);
    }
  },
};
