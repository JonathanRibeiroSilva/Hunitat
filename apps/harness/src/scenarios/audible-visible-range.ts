/**
 * audible-visible-range — FR-2.7, FR-2.9, FR-2.11, FR-2.12.
 *
 * The audience frame is the server's whole contribution to phase 2: who a client
 * subscribes to, and at what quality, is read straight off it. So the things
 * worth asserting are the ones a client cannot correct for.
 *
 * Three distances, chosen against the defaults (audible 12 m, visible 8 m):
 *
 *   4 m   audible and visible   — the ordinary case
 *   10 m  audible, not visible  — the gap FR-2.7 exists to allow
 *   20 m  neither               — absent entirely, not present with gain 0
 *
 * The middle one is the point. A single threshold passes the first and third and
 * fails only here, which is exactly the implementation someone reaches for when
 * "hearing and seeing range" is read as one idea.
 *
 * The third is FR-2.11: *absence*, not a zero-gain entry. An entry with gain 0
 * tells a client to subscribe to a track and play it silently, and silence still
 * costs bandwidth — the requirement is that the stream is not consumed at all.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const ORIGIN = { x: 0, z: 14 };

/** Well inside both thresholds. */
const NEAR_M = 4;
/** Between the two: audible, and deliberately not visible. */
const MID_M = 10;
/** Past the audible threshold and past the hysteresis band above it. */
const FAR_M = 20;

export const audibleVisibleRange: Scenario = {
  name: 'audible-visible-range',
  covers: 'FR-2.7/2.11/2.12 — audible and visible are separate ranges, and absence means silence',

  async run(ctx) {
    const listener = new Bot(ctx.url, 'range-listener');
    const near = new Bot(ctx.url, 'range-near');
    const mid = new Bot(ctx.url, 'range-mid');
    const far = new Bot(ctx.url, 'range-far');

    try {
      for (const bot of [listener, near, mid, far]) {
        await bot.connect();
        await bot.join();
      }

      listener.moveTo(ORIGIN.x, ORIGIN.z);
      near.moveTo(ORIGIN.x + NEAR_M, ORIGIN.z);
      mid.moveTo(ORIGIN.x + MID_M, ORIGIN.z);
      far.moveTo(ORIGIN.x + FAR_M, ORIGIN.z);

      // Waiting on the *shape* of the answer rather than on a delay. Everyone
      // joins near a spawn, so the first audience frames describe the world
      // before anybody moved; a fixed sleep would sometimes read one of those.
      //
      // The condition is the *reported distances*, not the answers being
      // asserted below, and that separation is the whole point. Each bot sends
      // its transform on its own socket, so the server can apply them in any
      // order — there are intermediate ticks where some have moved and some have
      // not, and several of them are indistinguishable from a settled world if
      // you key on a visibility flag. At spawn everyone stands ~9 m from where
      // the listener ends up: audible and not visible, which reads exactly like
      // `mid` at its final 10 m.
      //
      // `distanceM` is on every audience entry and is unambiguous. Pinning it
      // for both bots and requiring `far` to be gone fixes all four positions
      // without presuming anything about the flags the assertions are here to
      // check.
      const atDistance = (bot: Bot, expected: number): boolean => {
        const entry = listener.hears(bot.localId);
        return entry !== undefined && Math.abs(entry.distanceM - expected) < 0.2;
      };

      await waitUntil(
        () =>
          atDistance(near, NEAR_M) &&
          atDistance(mid, MID_M) &&
          listener.hears(far.localId) === undefined,
        3000,
        'the audience to settle at the final positions',
      );

      // ── 4 m — audible and visible ──────────────────────────────────────────
      const heardNear = listener.hears(near.localId);
      assert(heardNear !== undefined, `a participant ${NEAR_M} m away is not audible`);
      assertEqual(heardNear.reason, 'proximity', 'expected plain proximity, with no zone involved');
      assertEqual(heardNear.visible, true, `a participant ${NEAR_M} m away should be visible`);
      assert(
        heardNear.gain > 0 && heardNear.gain < 1,
        `distance is not attenuating: gain at ${NEAR_M} m is ${heardNear.gain}`,
      );

      // ── 10 m — audible, not visible ────────────────────────────────────────
      // The requirement that breaks when the two ranges are collapsed into one.
      const heardMid = listener.hears(mid.localId);
      assert(heardMid !== undefined, `a participant ${MID_M} m away should still be audible`);
      assertEqual(
        heardMid.visible,
        false,
        `a participant ${MID_M} m away is marked visible — the visible range (8 m) is being ` +
          `read from the audible one (12 m)`,
      );

      // Attenuation has to be monotonic, or the falloff is not a falloff.
      assert(
        heardMid.gain < heardNear.gain,
        `${MID_M} m is not quieter than ${NEAR_M} m (${heardMid.gain} vs ${heardNear.gain})`,
      );

      // ── 20 m — neither ─────────────────────────────────────────────────────
      assert(
        listener.hears(far.localId) === undefined,
        `a participant ${FAR_M} m away is in the audience — beyond the threshold the stream ` +
          `must not be consumed at all, not consumed at gain 0 (FR-2.11)`,
      );

      ctx.log(
        `${NEAR_M} m: audible+visible (gain ${heardNear.gain.toFixed(2)}) · ` +
          `${MID_M} m: audible only (gain ${heardMid.gain.toFixed(2)}) · ${FAR_M} m: absent`,
      );

      // ── The distance the client picks a simulcast layer from ───────────────
      // Reported, not inferred: the client's own view of a remote position lags
      // by the interpolation buffer, so a layer chosen from it would be one
      // buffer behind every time somebody walks toward you.
      assert(
        Math.abs(heardMid.distanceM - MID_M) < 0.2,
        `reported distance is wrong: ${heardMid.distanceM} m for a ${MID_M} m separation`,
      );

      // ── Hysteresis: the band is not a cliff ────────────────────────────────
      // Stepping just past the visible threshold must not immediately drop
      // video, or someone standing on 8 m renegotiates a track every tick. The
      // band is AUDIO_HYSTERESIS_M (2 m) wide, so 8.5 m is inside it.
      near.moveTo(ORIGIN.x + 8.5, ORIGIN.z);
      await sleep(300);

      const held = listener.hears(near.localId);
      assert(held !== undefined, 'the participant fell out of the audience entirely at 8.5 m');
      assertEqual(
        held.visible,
        true,
        'video dropped the moment the visible threshold was crossed — the hysteresis band is ' +
          'missing, and standing on the edge will thrash subscriptions (Phase 2 Rules)',
      );

      // Past the band, it must actually let go.
      near.moveTo(ORIGIN.x + 11, ORIGIN.z);
      await waitUntil(
        () => listener.hears(near.localId)?.visible === false,
        3000,
        'video to be released once past the hysteresis band',
      );

      ctx.log('visible held at 8.5 m inside the 2 m band, released at 11 m');
    } finally {
      for (const bot of [listener, near, mid, far]) bot.close();
      await sleep(100);
    }
  },
};
