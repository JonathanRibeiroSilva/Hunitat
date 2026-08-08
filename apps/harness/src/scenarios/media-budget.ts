/**
 * media-budget — FR-2.18, NFR-20.
 *
 * "Degrades gracefully" is the kind of requirement that is easy to claim and
 * easy to not have. The failure it guards against is a crowd: fourteen people in
 * earshot, a client that subscribes to all of them, and a session that dies of
 * bandwidth rather than of a bug anyone can point at.
 *
 * The order is the requirement, not the caps. FR-2.18 says video is reduced and
 * "the most distant video dropped first", and the phase notes are explicit that
 * **audio is never dropped for video**. So the assertion that matters is not
 * that something was shed — it is *what*, and in which order.
 *
 * Fourteen bots on a ring at known radii around one listener, against the
 * defaults (12 audio, 6 video, visible 8 m, audible 12 m):
 *
 *   1 – 6 m      audio + video   the six nearest faces
 *   7 – 7.5 m    audio only      inside visible range, past the video cap
 *   8.5 – 10 m   audio only      outside visible range
 *   10.5 – 11 m  nothing         past the audio cap, most distant first
 *
 * Placed at (0, 40) — outside the map, and therefore outside every authored zone.
 * A private zone or a spotlight defeats distance by design, which would make the
 * ranking here mean something else entirely.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const CENTRE = { x: 0, z: 40 };

/** Ascending, and chosen to straddle both caps and the visible threshold. */
const RADII = [1, 2, 3, 4, 5, 6, 7, 7.5, 8.5, 9, 9.5, 10, 10.5, 11];

const MAX_CONCURRENT_AUDIO = 12;
const MAX_CONCURRENT_VIDEO = 6;

export const mediaBudget: Scenario = {
  name: 'media-budget',
  covers: 'FR-2.18 — video is shed before audio, most distant first',

  async run(ctx) {
    const listener = new Bot(ctx.url, 'budget-listener');
    const ring = RADII.map((radius, index) => new Bot(ctx.url, `budget-${radius}m-${index}`));

    try {
      await listener.connect();
      await listener.join();
      listener.moveTo(CENTRE.x, CENTRE.z);

      for (const bot of ring) {
        await bot.connect();
        await bot.join();
      }

      // Spread around the circle so nobody stands inside anybody else — equal
      // distances would make the tie-break, not the distance ordering, decide
      // what gets shed.
      ring.forEach((bot, index) => {
        const angle = (index / ring.length) * Math.PI * 2;
        bot.moveTo(
          CENTRE.x + Math.cos(angle) * RADII[index]!,
          CENTRE.z + Math.sin(angle) * RADII[index]!,
        );
      });

      await waitUntil(
        () => listener.audience.length === MAX_CONCURRENT_AUDIO,
        4000,
        `the audience to settle at the ${MAX_CONCURRENT_AUDIO}-stream audio cap`,
      );
      // One more tick, so a set still converging is not read as a final answer.
      await sleep(200);

      const audience = listener.audience;

      assertEqual(
        audience.length,
        MAX_CONCURRENT_AUDIO,
        `the audio cap is not being applied — ${ring.length} participants are in range and ` +
          `${audience.length} were delivered`,
      );

      const visible = audience.filter((entry) => entry.visible);
      assertEqual(
        visible.length,
        MAX_CONCURRENT_VIDEO,
        'the video cap is not being applied independently of the audio cap',
      );

      // ── What survived, by name ─────────────────────────────────────────────
      const byRadius = new Map(ring.map((bot, index) => [RADII[index]!, bot.localId]));
      const entryAt = (radius: number) => audience.find((e) => e.id === byRadius.get(radius));

      for (const radius of [1, 2, 3, 4, 5, 6]) {
        const entry = entryAt(radius);
        assert(entry !== undefined, `the participant at ${radius} m was dropped entirely`);
        assertEqual(
          entry.visible,
          true,
          `the participant at ${radius} m lost video while someone further away kept it — ` +
            `video must be shed most-distant-first`,
        );
      }

      // The two inside visible range that the video cap could not fit. Audio
      // survived: this is the "audio is never dropped for video" clause, and the
      // one an implementation that sheds whole participants gets wrong.
      for (const radius of [7, 7.5]) {
        const entry = entryAt(radius);
        assert(
          entry !== undefined,
          `the participant at ${radius} m lost audio to make room for video — audio is never ` +
            `shed for video (FR-2.18)`,
        );
        assertEqual(entry.visible, false, `the participant at ${radius} m exceeded the video cap`);
      }

      // Audible but never visible, and unaffected by the video cap.
      for (const radius of [8.5, 9, 9.5, 10]) {
        assert(entryAt(radius) !== undefined, `the participant at ${radius} m lost audio`);
      }

      // Past the audio cap — and it is the *most distant* two, not an arbitrary
      // two, which is the part a Map-iteration-order implementation gets wrong.
      for (const radius of [10.5, 11]) {
        assert(
          entryAt(radius) === undefined,
          `the participant at ${radius} m survived the audio cap while nearer ones were shed`,
        );
      }

      ctx.log(
        `${ring.length} in earshot → ${audience.length} audio, ${visible.length} video · ` +
          `video shed from 7 m out, audio from 10.5 m out`,
      );
    } finally {
      listener.close();
      for (const bot of ring) bot.close();
      await sleep(150);
    }
  },
};
