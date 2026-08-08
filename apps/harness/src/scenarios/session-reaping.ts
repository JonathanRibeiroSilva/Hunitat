/**
 * session-reaping — AC-1.4 and FR-1.6.
 *
 *   > Closing/refreshing one client removes that participant from the others
 *   > within the stale-session timeout; reopening rejoins cleanly with no ghost
 *   > left behind.
 *
 * Two failure modes, and only one of them is the obvious one:
 *
 *   a) Abrupt close. The TCP connection goes away, the server sees `close`, and
 *      the participant must disappear from everyone else promptly.
 *   b) Half-open. The connection stays up but the peer stops responding — a
 *      laptop lid closing, a dropped Wi-Fi link. Nothing fires, and only the
 *      ping/pong heartbeat notices. This is the case FR-1.6 exists for and the
 *      one that leaves ghost participants standing around when it is missing.
 *
 * Case (b) is simulated by pausing the bot's underlying TCP socket: `ws` answers
 * pings automatically, so simply not calling anything would not reproduce it.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, type Scenario } from '../runner.js';

export const sessionReaping: Scenario = {
  name: 'session-reaping',
  covers: 'AC-1.4, FR-1.6 — no ghost participants after a drop',

  async run(ctx) {
    const observer = new Bot(ctx.url, 'reap-observer');

    try {
      await observer.connect();
      await observer.join();
      observer.moveTo(0, 0);

      // ── (a) abrupt close ────────────────────────────────────────────────
      const crasher = new Bot(ctx.url, 'reap-crasher');
      await crasher.connect();
      await crasher.join();
      crasher.moveTo(2, 0);

      await waitUntil(
        () => observer.remotes.has(crasher.localId),
        3000,
        'observer to see the crasher',
      );
      const crasherId = crasher.localId;

      const abruptStart = Date.now();
      crasher.terminate();

      await waitUntil(
        () => !observer.remotes.has(crasherId),
        5000,
        'crasher to disappear after an abrupt close',
      );
      const abruptMs = Date.now() - abruptStart;
      assert(abruptMs < 3000, `abrupt-close removal took ${abruptMs} ms`);
      ctx.log(`abrupt close: removed from the observer in ${abruptMs} ms`);

      // ── (b) half-open connection ────────────────────────────────────────
      const silent = new Bot(ctx.url, 'reap-silent');
      await silent.connect();
      await silent.join();
      silent.moveTo(3, 0);

      await waitUntil(
        () => observer.remotes.has(silent.localId),
        3000,
        'observer to see the silent bot',
      );
      const silentId = silent.localId;
      const tuning = observer.joined!.tuning;

      // Worst case is two full ping intervals, since the heartbeat terminates a
      // socket that misses one whole cycle. The server refuses to boot unless
      // STALE_SESSION_TIMEOUT_MS exceeds that, so this bound is guaranteed.
      const pingIntervalMs = 10_000;
      const budgetMs = pingIntervalMs * 2 + 5_000;

      const silentStart = Date.now();
      silent.goSilent();
      ctx.log(`half-open: socket paused, waiting up to ${(budgetMs / 1000).toFixed(0)} s…`);

      await waitUntil(
        () => !observer.remotes.has(silentId),
        budgetMs,
        'silent bot to be reaped by the heartbeat',
      );
      const silentMs = Date.now() - silentStart;

      ctx.log(
        `half-open: reaped in ${(silentMs / 1000).toFixed(1)} s (idle timeout ${tuning.idleTimeoutMs} ms)`,
      );

      assert(
        observer.remotes.size === 0,
        `observer still sees ${observer.remotes.size} ghost participant(s)`,
      );
      silent.terminate();
    } finally {
      observer.close();
      await sleep(100);
    }
  },
};
