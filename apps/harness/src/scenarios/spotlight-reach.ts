/**
 * spotlight-reach — FR-3.12, FR-3.13, AC-3.3.
 *
 * Two things have to hold at once, and they pull in opposite directions:
 *
 *   FR-3.12  the spotlighted speaker reaches everyone, regardless of distance
 *   FR-3.13  the listener still hears their own neighbours
 *
 * An implementation that treats spotlight as a *replacement* for proximity
 * passes the first and fails the second. The audience is a union, so the
 * assertion is that the listener hears both, with different reasons.
 *
 * The listener stands 100 m out — far outside AOI_ENTER_RADIUS_M, not merely
 * outside audible range. That is deliberate: the interest set is the natural
 * candidate list for an audience, and a spotlight has to be unioned in
 * explicitly or it silently stops at the interest boundary. Bots are
 * authoritative over their own position (ADR 0004) and are not confined to the
 * map, so this reaches a case the 26 x 18 m office cannot otherwise produce.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

/** Inside `stage`: a cylinder at (9.5, -5), radius 2.5. */
const STAGE = { x: 9.5, z: -5 };
/** Far outside the interest radius, let alone audible range. */
const FAR = { x: 100, z: 0 };

export const spotlightReach: Scenario = {
  name: 'spotlight-reach',
  covers: 'FR-3.12/3.13 — a spotlight carries any distance, and adds to proximity',

  async run(ctx) {
    const speaker = new Bot(ctx.url, 'stage-speaker');
    const listener = new Bot(ctx.url, 'far-listener');
    const neighbour = new Bot(ctx.url, 'far-neighbour');

    try {
      for (const bot of [speaker, listener, neighbour]) {
        await bot.connect();
        await bot.join();
      }

      listener.moveTo(FAR.x, FAR.z);
      neighbour.moveTo(FAR.x + 2, FAR.z);
      speaker.moveTo(STAGE.x, STAGE.z);

      // Waiting on the *reason*, not on mere audibility. Everyone joins near a
      // spawn, so the first audience frame already lists the speaker by
      // proximity — a wait for "audible" is satisfied by that stale frame before
      // anybody has moved, and the assertions below would then be reading the
      // world as it was two ticks ago.
      await waitUntil(
        () => listener.hears(speaker.localId)?.reason === 'spotlight',
        3000,
        'the spotlight to reach a listener 100 m away',
      );

      const heard = listener.hears(speaker.localId)!;
      assertEqual(heard.reason, 'spotlight', 'speaker is audible, but not as a spotlight');
      assertEqual(heard.gain, 1, 'a spotlight should not be attenuated by distance');

      // FR-3.13 — the neighbour 2 m away must still be there, by proximity.
      const nearby = listener.hears(neighbour.localId);
      assert(
        nearby !== undefined,
        'the spotlight replaced the listener local audience instead of adding to it',
      );
      assertEqual(nearby.reason, 'proximity', 'a neighbour 2 m away should be heard by proximity');

      ctx.log(
        `listener at ${FAR.x} m hears the stage (spotlight) and a neighbour 2 m away (proximity)`,
      );

      // Stepping off the stage must put the speaker back under distance rules —
      // which at 90 m means silence.
      speaker.moveTo(STAGE.x + 6, STAGE.z);
      await waitUntil(
        () => listener.hears(speaker.localId) === undefined,
        3000,
        'the speaker to fall silent after stepping off the stage',
      );

      ctx.log('stepping off the stage restores distance rules');
    } finally {
      speaker.close();
      listener.close();
      neighbour.close();
      await sleep(100);
    }
  },
};
