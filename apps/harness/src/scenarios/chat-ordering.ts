/**
 * chat-ordering — `FR-5.7`, `FR-5.8`, `AC-5.2`.
 *
 *   > Messages show sender and time, arrive in order, and appear to the sender
 *   > instantly.
 *
 * Order is asserted **under concurrent sends**, which is the case `FR-5.7`
 * actually names and the only one where a per-client sequence number would
 * differ from a server-assigned one. Two bots interleave sends into the room
 * channel as fast as the socket allows; every observer must see one order, and
 * it must be the order the sequence numbers describe.
 *
 * The trap this is built to catch is not "the numbers are wrong". It is a
 * server that assigns `seq` correctly and then writes frames out in whatever
 * order its awaits happened to resolve — every client would then have to sort,
 * and one that appended as frames arrived would show a conversation shuffled.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const MESSAGES_PER_SENDER = 8;

export const chatOrdering: Scenario = {
  name: 'chat-ordering',
  covers:
    'FR-5.7/5.8, AC-5.2 — server-assigned order survives concurrent sends; the sender is echoed',

  async run(ctx) {
    const ana = new Bot(ctx.url, 'order-ana');
    const bea = new Bot(ctx.url, 'order-bea');
    const watcher = new Bot(ctx.url, 'order-watcher');

    try {
      for (const bot of [ana, bea, watcher]) {
        await bot.connect();
        await bot.join();
      }
      await sleep(150);
      for (const bot of [ana, bea, watcher]) bot.resetEvents();

      // Interleaved rather than batched per sender: two clients typing at once
      // is the concurrency FR-5.7 is about.
      const tempIds: string[] = [];
      for (let i = 0; i < MESSAGES_PER_SENDER; i++) {
        tempIds.push(ana.chatSend('room', `ana-${i}`));
        tempIds.push(bea.chatSend('room', `bea-${i}`));
      }

      const total = MESSAGES_PER_SENDER * 2;
      await waitUntil(
        () => watcher.chatIn('room').length >= total,
        5000,
        `the watcher to receive all ${total} messages`,
      );
      await sleep(150);

      // ── FR-5.7 — arrival order matches sequence order ─────────────────────
      const seen = watcher.chatIn('room');
      for (let i = 1; i < seen.length; i++) {
        assert(
          seen[i]!.seq > seen[i - 1]!.seq,
          `messages arrived out of sequence: "${seen[i - 1]!.body}" (seq ${seen[i - 1]!.seq}) ` +
            `was delivered before "${seen[i]!.body}" (seq ${seen[i]!.seq}). ` +
            `Order is assigned on the server and must also be the order frames are written.`,
        );
      }

      // Both senders agree with the watcher. Ordering that only holds for one
      // observer is not ordering.
      const bodiesFor = (bot: Bot): string[] => bot.chatIn('room').map((message) => message.body);
      assertEqual(
        bodiesFor(ana).join(','),
        bodiesFor(watcher).join(','),
        'the sender and an observer disagree about the order of the room channel',
      );
      assertEqual(
        bodiesFor(bea).join(','),
        bodiesFor(watcher).join(','),
        'two observers disagree about the order of the room channel',
      );

      // ── FR-5.7 — sender and timestamp travel with every message ───────────
      for (const message of seen) {
        assert(message.senderName.length > 0, `message "${message.body}" carried no sender name`);
        assert(message.at > 0, `message "${message.body}" carried no timestamp`);
        assert(
          message.senderSessionId.length > 0,
          `message "${message.body}" carried no sender identity`,
        );
      }

      // ── FR-5.8 — the sender's own copy carries its temporary id ───────────
      const echoed = new Set(ana.chat.concat(bea.chat).map((message) => message.tempId));
      const missing = tempIds.filter((tempId) => !echoed.has(tempId));
      assertEqual(
        missing.length,
        0,
        `${missing.length} send(s) were never echoed back with their tempId — without it a client ` +
          `cannot reconcile the message it already drew and every message appears twice`,
      );

      // And nobody else is told about it: a tempId is between a sender and the
      // server, and leaking it would let a recipient reconcile against an id
      // that means nothing to them.
      assert(
        watcher.chatIn('room').every((message) => message.tempId === undefined),
        'an observer received a tempId that belonged to the sender',
      );

      ctx.log(`${total} interleaved sends, one order, ${tempIds.length} echoes reconciled`);
    } finally {
      for (const bot of [ana, bea, watcher]) bot.close();
      await sleep(100);
    }
  },
};
