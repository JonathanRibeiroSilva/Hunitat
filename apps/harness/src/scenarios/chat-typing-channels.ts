/**
 * chat-typing-channels — `FR-5.5`, `FR-5.10`, `AC-5.3`.
 *
 * Two requirements that are really one idea: what you can type in, and who is
 * told that you are.
 *
 *   > A participant can see a typing indicator for others composing in a channel
 *   > they share, which clears when sending stops.
 *
 * "A channel they share" is the load-bearing phrase. Typing is scoped by exactly
 * the same resolution as a message — so somebody typing in a zone you are not in
 * must not appear to you, and the assertion for that is the one that fails when
 * typing is implemented as a broadcast.
 *
 * `FR-5.5` is asserted by walking: the zone channel must appear on entering a
 * chat-enabled zone and disappear on leaving, and it must never be advertised to
 * anybody else — the set names where a person is standing.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

/** Inside `west-corridor`: x ∈ [-11, -5], z ∈ [1.5, 4.5]. */
const IN_CORRIDOR = { x: -8, z: 3 };
/** Two metres past the east edge — inside nearby range, outside the zone. */
const OUTSIDE = { x: -3, z: 3 };

export const chatTypingChannels: Scenario = {
  name: 'chat-typing-channels',
  covers: 'FR-5.5/5.10, AC-5.3 — channels follow the participant; typing is scoped like a message',

  async run(ctx) {
    const ana = new Bot(ctx.url, 'typing-ana');
    const bea = new Bot(ctx.url, 'typing-bea');

    try {
      for (const bot of [ana, bea]) {
        await bot.connect();
        await bot.join();
      }

      // ── FR-5.5 — the base set, before anyone is in a zone ─────────────────
      ana.moveTo(OUTSIDE.x, OUTSIDE.z + 6);
      bea.moveTo(OUTSIDE.x, OUTSIDE.z);
      await sleep(300);

      assertEqual(
        ana.chatChannels
          .map((channel) => channel.scope)
          .sort()
          .join(','),
        'nearby,room',
        'a participant outside every chat-enabled zone should have exactly the room and nearby channels',
      );
      const room = ana.chatChannels.find((channel) => channel.scope === 'room')!;
      const nearby = ana.chatChannels.find((channel) => channel.scope === 'nearby')!;
      assert(room.persistent, 'the room channel should advertise that its history is kept');
      assert(
        !nearby.persistent,
        'the nearby channel should advertise that it keeps nothing — FR-5.13 is a promise the ' +
          'interface has to be able to make',
      );

      // ── FR-5.5 — the zone channel appears on entering ─────────────────────
      ana.moveTo(IN_CORRIDOR.x, IN_CORRIDOR.z);
      await waitUntil(
        () => ana.chatChannels.some((channel) => channel.zoneId === 'west-corridor'),
        3000,
        'the zone channel to appear after entering a chat-enabled zone',
      );

      // ...and only for the person standing in it. The set names a position,
      // and broadcasting it would leak what the area of interest exists to hide.
      assert(
        !bea.chatChannels.some((channel) => channel.zoneId === 'west-corridor'),
        "an observer was told about somebody else's zone channel — that publishes their position",
      );

      // ── FR-5.10 — typing is scoped exactly like a message ─────────────────
      bea.resetEvents();
      ana.chatTyping('zone', true, 'west-corridor');
      await sleep(600);
      assertEqual(
        bea.typingFrames.length,
        0,
        'a typing indicator for a zone reached somebody outside it — typing must be scoped by the ' +
          'same resolution as a message, not broadcast',
      );

      ana.chatTyping('nearby', true);
      await waitUntil(
        () => bea.typingFrames.some((frame) => frame.typing),
        3000,
        'a nearby typing indicator to reach a participant in range',
      );

      const started = bea.typingFrames.find((frame) => frame.typing)!;
      assertEqual(started.id, ana.localId, 'the typing indicator named the wrong participant');
      assertEqual(started.displayName, ana.name, 'the typing indicator carried no usable name');
      assert(
        started.expiresInMs > 0,
        'the typing indicator carried no expiry — without one it never clears when a client ' +
          'disappears mid-sentence',
      );

      // ── AC-5.3 — and it clears ────────────────────────────────────────────
      ana.chatTyping('nearby', false);
      await waitUntil(
        () => bea.typingFrames.some((frame) => !frame.typing),
        3000,
        'the typing indicator to clear',
      );

      // Sending is itself a "stopped typing" signal, which is what makes the
      // indicator disappear the moment the message lands rather than five
      // seconds later.
      bea.resetEvents();
      ana.chatTyping('nearby', true);
      await waitUntil(() => bea.typingFrames.length > 0, 3000, 'typing to start again');

      // ── FR-5.5 — and the zone channel goes away on leaving ────────────────
      ana.moveTo(OUTSIDE.x, OUTSIDE.z + 6);
      await waitUntil(
        () => !ana.chatChannels.some((channel) => channel.zoneId === 'west-corridor'),
        3000,
        'the zone channel to disappear after leaving the zone',
      );

      // And the server refuses a send into it, rather than accepting one into a
      // channel the sender no longer has (FR-5.8's failure half).
      ana.resetEvents();
      ana.chatSend('zone', 'should-not-send', 'west-corridor');
      await waitUntil(
        () => ana.chatRejects.length > 0,
        3000,
        'a rejection for a zone the sender has left',
      );
      assertEqual(
        ana.chatRejects[0]!.code,
        'channel-unavailable',
        'sending into a zone the participant has left should be refused, and named as such',
      );

      ctx.log('zone channel appeared and vanished with occupancy; typing stayed inside its scope');
    } finally {
      for (const bot of [ana, bea]) bot.close();
      await sleep(100);
    }
  },
};
