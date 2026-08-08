/**
 * chat-history — `FR-5.11`, `FR-5.12`, `FR-5.13`, `FR-5.16`, `AC-5.4`, `AC-5.6`.
 *
 *   > A persistent channel shows recent history on open; an ephemeral channel
 *   > shows none after the fact.
 *
 * Both halves are asserted from a bot that was **not connected** when the
 * messages were sent, which is the only way to tell history from live delivery.
 * A bot that was present would have received everything on the socket and would
 * pass whether or not anything was stored.
 *
 * `FR-5.13` gets the same treatment and is the more important of the two: an
 * ephemeral channel that quietly retained its messages would look identical to
 * a correct one in every other test.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const TOGETHER = { x: 0, z: 0 };
const ALSO_TOGETHER = { x: 1.5, z: 0 };

export const chatHistory: Scenario = {
  name: 'chat-history',
  covers: 'FR-5.11/5.12/5.13/5.16, AC-5.4/5.6 — room persists, nearby does not, read state is kept',

  async run(ctx) {
    const ana = new Bot(ctx.url, 'history-ana');
    const bea = new Bot(ctx.url, 'history-bea');
    const latecomer = new Bot(ctx.url, 'history-latecomer');

    try {
      for (const bot of [ana, bea]) {
        await bot.connect();
        await bot.join();
      }
      ana.moveTo(TOGETHER.x, TOGETHER.z);
      bea.moveTo(ALSO_TOGETHER.x, ALSO_TOGETHER.z);
      await sleep(200);

      // A marker unique to this run: the room channel is durable, so previous
      // runs of this scenario are still in it and a fixed body would match one
      // of them and pass for the wrong reason.
      const marker = `hist-${Date.now()}`;
      ana.chatSend('room', `${marker}-room-1`);
      ana.chatSend('room', `${marker}-room-2`);
      ana.chatSend('nearby', `${marker}-nearby-1`);

      await waitUntil(
        () => bea.chat.length >= 3,
        4000,
        'bea to receive both room messages and the nearby one',
      );

      // ── FR-5.12, AC-5.4 — a persistent channel shows recent history ───────
      await latecomer.connect();
      await latecomer.join();
      latecomer.chatHistory('room');

      await waitUntil(
        () => latecomer.histories.some((page) => page.channelId === 'room'),
        4000,
        'the room history to arrive',
      );

      const room = latecomer.histories.find((page) => page.channelId === 'room')!;
      const bodies = room.messages.map((message) => message.body);
      assert(
        bodies.includes(`${marker}-room-1`) && bodies.includes(`${marker}-room-2`),
        `the room history did not contain messages sent before this bot connected. ` +
          `Got [${bodies.slice(-4).join(', ')}]`,
      );

      // Oldest first, so a client can append without reversing — and in
      // sequence order, which is the only order FR-5.7 guarantees.
      for (let i = 1; i < room.messages.length; i++) {
        assert(
          room.messages[i]!.seq > room.messages[i - 1]!.seq,
          'history was not returned oldest-first in sequence order',
        );
      }

      // ── FR-5.13, AC-5.4 — an ephemeral channel shows none ────────────────
      assert(
        !bodies.includes(`${marker}-nearby-1`),
        'a nearby message was found in the room history — ephemeral messages must not be stored ' +
          'under any channel',
      );

      latecomer.chatHistory('nearby');
      await waitUntil(
        () => latecomer.histories.some((page) => page.channelId === 'nearby'),
        4000,
        'the nearby history reply',
      );

      const nearby = latecomer.histories.find((page) => page.channelId === 'nearby')!;
      assertEqual(
        nearby.messages.length,
        0,
        'an ephemeral channel returned stored messages. "Delivered and forgotten" means the ' +
          'nearby channel has nothing to page through, ever.',
      );
      assert(nearby.complete, 'an empty ephemeral channel should report its history as complete');

      // ── FR-5.16, AC-5.6 — the read marker is kept and returned ────────────
      const highest = room.messages.reduce((max, message) => Math.max(max, message.seq), 0);
      assertEqual(room.lastReadSeq, 0, 'a bot that has never read a channel should have no marker');

      latecomer.chatRead('room', highest);
      await sleep(300);
      latecomer.chatHistory('room');
      await waitUntil(
        () => latecomer.histories.filter((page) => page.channelId === 'room').length >= 2,
        4000,
        'the second room history reply',
      );

      const reread = latecomer.histories.filter((page) => page.channelId === 'room').at(-1)!;
      assertEqual(
        reread.lastReadSeq,
        highest,
        'the read marker was not retained — unread counts would reset on every reconnect',
      );

      ctx.log(
        `room history returned ${room.messages.length} message(s) to a bot that was not present; ` +
          `nearby returned 0; read marker held at seq ${highest}`,
      );
    } finally {
      for (const bot of [ana, bea, latecomer]) bot.close();
      await sleep(100);
    }
  },
};
