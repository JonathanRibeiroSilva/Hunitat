/**
 * chat-mentions — `FR-5.15`, `AC-5.5`, and the Rule that constrains it.
 *
 *   > Mentions must not leak a message to someone outside the channel's scope
 *   > (mention highlights only apply to eligible recipients).
 *
 * That rule is the reason this scenario exists, and it is entirely about
 * *ordering inside the server*. Resolving mentions against the roster and then
 * filtering by scope produces exactly the same highlight for everyone in range
 * — and tells the person out of range that a message about them exists. The
 * only observable difference between the correct implementation and the broken
 * one is what the out-of-scope participant receives, so that is what is
 * asserted.
 *
 * Two mentions in one line: one of somebody in range, one of somebody who is
 * not. The first must be resolved, the second must be absent from the frame
 * entirely — not present-and-ignored.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const NEAR = { x: 0, z: 0 };
const ALSO_NEAR = { x: 2, z: 0 };
/** Beyond CHAT_NEARBY_RADIUS_M (12 m), inside AOI_ENTER_RADIUS_M (25 m). */
const OUT_OF_RANGE = { x: 18, z: 0 };

export const chatMentions: Scenario = {
  name: 'chat-mentions',
  covers: 'FR-5.15, AC-5.5 — mentions are resolved after scoping, so one cannot leak a message',

  async run(ctx) {
    const ana = new Bot(ctx.url, 'Mention Ana');
    const bea = new Bot(ctx.url, 'Mention Bea');
    const far = new Bot(ctx.url, 'Mention Far');

    try {
      for (const bot of [ana, bea, far]) {
        await bot.connect();
        await bot.join();
      }

      ana.moveTo(NEAR.x, NEAR.z);
      bea.moveTo(ALSO_NEAR.x, ALSO_NEAR.z);
      far.moveTo(OUT_OF_RANGE.x, OUT_OF_RANGE.z);
      await sleep(300);

      const separation = Math.hypot(NEAR.x - OUT_OF_RANGE.x, NEAR.z - OUT_OF_RANGE.z);
      ctx.log(
        `the mentioned outsider is ${separation.toFixed(0)} m away — nearby chat reaches 12 m`,
      );

      // Display names contain a space, deliberately: a mention scanner built on
      // `@\w+` matches "Mention" and resolves nobody, which is the bug this
      // spelling exists to catch.
      const body = 'ping @Mention Bea and @Mention Far';
      ana.chatSend('nearby', body);

      assert(await bea.waitForChat(body), 'the nearby message did not reach bea');
      const delivered = bea.chat.find((message) => message.body === body)!;

      // ── FR-5.15 — the in-range mention resolves ───────────────────────────
      assertEqual(
        delivered.mentions.length,
        1,
        `expected exactly one resolved mention, got ${delivered.mentions.length}: ` +
          `[${delivered.mentions.map((mention) => mention.name).join(', ')}]. ` +
          `Two means the out-of-range participant was resolved before scoping.`,
      );
      assertEqual(
        delivered.mentions[0]!.name,
        'Mention Bea',
        'the wrong participant was mentioned',
      );
      assertEqual(
        delivered.mentions[0]!.sessionId,
        bea.joined!.sessionId,
        'the mention names the right display name but the wrong session',
      );

      // ── The Rule — the out-of-scope mention delivered nothing ─────────────
      assert(
        !(await far.waitForChat(body, 1500)),
        `a nearby message reached a participant ${separation.toFixed(0)} m away because they were ` +
          `mentioned in it. Mentions must be resolved AGAINST the recipient set, never used to ` +
          `extend it.`,
      );

      // The sender's own echo carries the same resolved set, so what the author
      // sees highlighted is what was actually notified.
      const echo = ana.chat.find((message) => message.body === body)!;
      assertEqual(
        echo.mentions.length,
        1,
        'the sender was shown a different set of mentions than the recipient',
      );

      ctx.log('one mention resolved, one silently out of scope, nothing leaked');
    } finally {
      for (const bot of [ana, bea, far]) bot.close();
      await sleep(100);
    }
  },
};
