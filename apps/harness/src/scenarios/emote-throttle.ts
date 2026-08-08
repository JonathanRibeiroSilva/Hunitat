/**
 * emote-throttle — AC-4.5, and the Phase 4 anti-spam rule.
 *
 *   > Triggering an emote plays it on the local avatar and on remote views of
 *   > that avatar, then ends cleanly.
 *   > Emote spam must be reasonable to manage (e.g., a minimum interval) so it
 *   > can't flood others.
 *
 * Three claims, each with its own failure mode:
 *
 *   1. An emote reaches a nearby observer AND its author. The author matters:
 *      an observer is never in their own area of interest, so routing the
 *      broadcast through the interest set alone would show everyone the wave
 *      except the person who sent it — and in third person, that is the one
 *      person watching for it.
 *   2. A burst of them is collapsed to one. `EMOTE_MIN_INTERVAL_MS` is a
 *      *guarantee*, not a client courtesy, so the bot sends far more than the
 *      interval allows and the server is expected to drop the excess.
 *   3. Excess is dropped **silently**. A throttled emote answered with
 *      `ERROR rate-limited` would turn a leaned-on key into a stream of
 *      warnings for a client that did nothing wrong (wire-protocol.md).
 *
 * An unknown emote id is checked too, because the versioning rule says an
 * opcode or value a build does not recognise is ignored rather than rejected —
 * which is what lets a newer client talk to an older server.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const emoteThrottle: Scenario = {
  name: 'emote-throttle',
  covers: 'AC-4.5 — emotes replicate to observers and their author, and spam is dropped silently',

  async run(ctx) {
    const emoter = new Bot(ctx.url, 'emote-sender');
    const watcher = new Bot(ctx.url, 'emote-watcher');
    const distant = new Bot(ctx.url, 'emote-distant');

    try {
      await emoter.connect();
      await emoter.join();
      await watcher.connect();
      await watcher.join();
      await distant.connect();
      await distant.join();

      const tuning = emoter.joined!.tuning;
      const spawn = emoter.joined!.spawn;
      const interval = tuning.emoteMinIntervalMs;

      // The watcher stands next to the emoter; the distant bot sits beyond the
      // interest radius, so it must never hear about any of this.
      emoter.moveTo(spawn.x, spawn.z);
      watcher.moveTo(spawn.x + 2, spawn.z);
      distant.moveTo(spawn.x, spawn.z + tuning.aoiExitRadiusM + 10);

      for (let i = 0; i < 4; i++) {
        emoter.sendTransform();
        watcher.sendTransform();
        distant.sendTransform();
        await sleep(60);
      }
      // One full tick for the interest sets to settle before anything is
      // asserted about who receives what.
      await sleep(300);

      emoter.resetEvents();
      watcher.resetEvents();
      distant.resetEvents();

      // ── one emote reaches the observer and the author ──────────────────────
      emoter.emote('wave');

      await waitUntil(
        () => watcher.emotesFrom(emoter.localId).length > 0,
        2000,
        'the watcher to receive EMOTE_PLAY',
      );
      await waitUntil(
        () => emoter.emotesFrom(emoter.localId).length > 0,
        2000,
        'the emoter to receive its own EMOTE_PLAY',
      );

      const received = watcher.emotesFrom(emoter.localId)[0]!;
      assertEqual(received.emote, 'wave', 'the broadcast named a different emote');
      assert(
        received.durationMs > 0 && received.durationMs <= tuning.emoteMaxDurationMs,
        `duration ${received.durationMs} ms is outside 0..${tuning.emoteMaxDurationMs} ` +
          `(FR-4.16 requires the server to bound it)`,
      );

      // ── a burst collapses to one ──────────────────────────────────────────
      const burst = 8;
      for (let i = 0; i < burst; i++) emoter.emote('clap');
      await sleep(400);

      const claps = watcher.emotesFrom(emoter.localId).filter((e) => e.emote === 'clap');
      assertEqual(
        claps.length,
        0,
        `${claps.length} of ${burst} emotes sent inside the ${interval} ms interval were ` +
          `broadcast; all should have been dropped, since a wave was accepted moments before`,
      );

      // ── silence, not an error ─────────────────────────────────────────────
      assertEqual(
        emoter.events.errors.length,
        0,
        `the server answered a throttled emote with ${emoter.events.errors
          .map((e) => e.code)
          .join(', ')}; excess must be dropped silently (wire-protocol.md)`,
      );

      // ── an unknown emote is ignored, not fatal ────────────────────────────
      emoter.emote('backflip-of-the-unknown-future');
      await sleep(200);
      assertEqual(
        emoter.events.errors.length,
        0,
        'an unrecognised emote id produced an error; the versioning rule says ignore it',
      );

      // ── the interval expires and the next one is accepted ─────────────────
      await sleep(interval);
      emoter.emote('cheer');
      await waitUntil(
        () => watcher.emotesFrom(emoter.localId).some((e) => e.emote === 'cheer'),
        2000,
        'a second emote after the interval elapsed',
      );

      // ── and none of it leaked out of the area of interest ─────────────────
      assertEqual(
        distant.emotes.length,
        0,
        `a bot ${tuning.aoiExitRadiusM + 10} m away received ${distant.emotes.length} emote(s); ` +
          `emotes are visible to "participants who can see the avatar" (FR-4.15)`,
      );

      ctx.log(
        `1 emote through, ${burst} inside the ${interval} ms window dropped with no error, ` +
          `1 more accepted after it elapsed — author and observer both saw them, nobody at ` +
          `${tuning.aoiExitRadiusM + 10} m did`,
      );
    } finally {
      emoter.close();
      watcher.close();
      distant.close();
      await sleep(100);
    }
  },
};
