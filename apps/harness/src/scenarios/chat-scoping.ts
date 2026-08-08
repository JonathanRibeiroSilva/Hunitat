/**
 * chat-scoping — `FR-5.1`, `FR-5.2`, `FR-5.3`, `FR-5.4`, `AC-5.1`.
 *
 * The whole of `AC-5.1` in one run:
 *
 *   > A room message reaches everyone in the instance; a nearby message reaches
 *   > only those in range; a zone message reaches only co-occupants of that
 *   > zone; a direct message reaches only the target.
 *
 * The layout is chosen so each scope can *fail* into another and be caught:
 *
 *   - The far bot is 20 m away — inside `AOI_ENTER_RADIUS_M` (25) and outside
 *     `CHAT_NEARBY_RADIUS_M` (12). If `nearby` were quietly resolving to "the
 *     interest set", it would receive the message and this fails. Parking them
 *     at 60 m would pass against a server with no proximity logic at all.
 *
 *   - The zone test uses `west-corridor`, a **trigger** zone, not the private
 *     huddle. Inside a private zone, `nearby` already excludes everyone outside,
 *     so a zone message there would reach the right people even if zone
 *     resolution fell through to proximity. In the corridor the two disagree,
 *     and the outsider stands 2 m from the edge to prove it.
 *
 * The negative assertions are the point, and they cost real time: proving a
 * message did NOT arrive means waiting long enough that it would have.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

/** Inside `west-corridor`: x ∈ [-11, -5], z ∈ [1.5, 4.5]. */
const IN_CORRIDOR_A = { x: -8, z: 3 };
const IN_CORRIDOR_B = { x: -9.5, z: 2.5 };
/** Two metres beyond the corridor's east edge — well inside nearby range. */
const BESIDE_CORRIDOR = { x: -3, z: 3 };
/** 20 m from the corridor: inside the interest radius, outside chat's. */
const FAR = { x: 11, z: 3 };

export const chatScoping: Scenario = {
  name: 'chat-scoping',
  covers:
    'FR-5.1/5.2/5.3/5.4, AC-5.1 — room, nearby, zone and direct reach exactly who they should',

  async run(ctx) {
    const ana = new Bot(ctx.url, 'chat-ana');
    const bea = new Bot(ctx.url, 'chat-bea');
    const cass = new Bot(ctx.url, 'chat-cass');
    const dane = new Bot(ctx.url, 'chat-dane');

    try {
      for (const bot of [ana, bea, cass, dane]) {
        await bot.connect();
        await bot.join();
      }

      ana.moveTo(IN_CORRIDOR_A.x, IN_CORRIDOR_A.z);
      bea.moveTo(IN_CORRIDOR_B.x, IN_CORRIDOR_B.z);
      cass.moveTo(BESIDE_CORRIDOR.x, BESIDE_CORRIDOR.z);
      dane.moveTo(FAR.x, FAR.z);

      await waitUntil(
        () =>
          ana.zoneEventsFor('west-corridor').length > 0 &&
          bea.zoneEventsFor('west-corridor').length > 0,
        3000,
        'ana and bea to be recorded inside west-corridor',
      );
      await sleep(200);

      const anaToCass = Math.hypot(
        IN_CORRIDOR_A.x - BESIDE_CORRIDOR.x,
        IN_CORRIDOR_A.z - BESIDE_CORRIDOR.z,
      );
      const anaToDane = Math.hypot(IN_CORRIDOR_A.x - FAR.x, IN_CORRIDOR_A.z - FAR.z);
      ctx.log(
        `cass is ${anaToCass.toFixed(1)} m away (inside 12 m chat range), ` +
          `dane is ${anaToDane.toFixed(1)} m (outside it, inside the 25 m interest radius)`,
      );

      // ── FR-5.1 — room reaches the whole instance ──────────────────────────
      ana.chatSend('room', 'room-hello');
      assert(await bea.waitForChat('room-hello'), 'a room message did not reach bea');
      assert(await cass.waitForChat('room-hello'), 'a room message did not reach cass');
      assert(
        await dane.waitForChat('room-hello'),
        'a room message did not reach dane — "everyone in the instance" is not everyone in range',
      );

      // ── FR-5.2 — nearby reaches only those in range ───────────────────────
      ana.chatSend('nearby', 'nearby-hello');
      assert(await bea.waitForChat('nearby-hello'), 'a nearby message did not reach bea, 2 m away');
      assert(
        await cass.waitForChat('nearby-hello'),
        `a nearby message did not reach cass, ${anaToCass.toFixed(1)} m away and inside chat range`,
      );
      assert(
        !(await dane.waitForChat('nearby-hello', 1200)),
        `a nearby message reached dane ${anaToDane.toFixed(1)} m away — CHAT_NEARBY_RADIUS_M is 12 m, ` +
          `so this is chat resolving reach from the interest set rather than from resolveAudience`,
      );

      // ── FR-5.3 — zone reaches co-occupants only ───────────────────────────
      ana.chatSend('zone', 'zone-hello', 'west-corridor');
      assert(
        await bea.waitForChat('zone-hello'),
        'a zone message did not reach bea, inside the same zone',
      );
      assert(
        !(await cass.waitForChat('zone-hello', 1200)),
        `a zone message reached cass, standing ${anaToCass.toFixed(1)} m outside the zone — ` +
          `zone scoping has fallen through to proximity`,
      );
      assert(!(await dane.waitForChat('zone-hello', 600)), 'a zone message reached dane');

      // ── FR-5.4 — direct reaches the target only ───────────────────────────
      ana.chatSend('direct', 'direct-hello', bea.joined!.sessionId);
      assert(await bea.waitForChat('direct-hello'), 'a direct message did not reach its target');
      assert(
        !(await cass.waitForChat('direct-hello', 1200)),
        'a direct message reached a third party',
      );
      assert(
        !(await dane.waitForChat('direct-hello', 600)),
        'a direct message reached a third party',
      );

      // The recipient's copy is addressed to the SENDER's thread, and the
      // sender's own echo to the recipient's — a direct channel is named from
      // the reader's side, and getting this backwards files every reply into a
      // thread nobody is reading.
      const received = bea.chat.find((message) => message.body === 'direct-hello')!;
      assertEqual(
        received.channelId,
        `direct:${ana.joined!.sessionId}`,
        'the recipient filed the direct message under the wrong thread',
      );
      const echo = ana.chat.find((message) => message.body === 'direct-hello')!;
      assertEqual(
        echo.channelId,
        `direct:${bea.joined!.sessionId}`,
        "the sender's own echo was filed under the wrong thread",
      );

      ctx.log('room reached 3, nearby reached 2, zone reached 1, direct reached 1');
    } finally {
      for (const bot of [ana, bea, cass, dane]) bot.close();
      await sleep(100);
    }
  },
};
