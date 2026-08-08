/**
 * presence-status — AC-4.4, and the FR-1.22 boundary it sits against.
 *
 *   > Setting do-not-disturb/away is reflected on the avatar/nameplate to others.
 *
 * Two facts share one nameplate and they are not the same fact:
 *
 *   status     chosen by the participant (FR-4.11) — available / away / DND
 *   activity   derived by the server from input (FR-1.22) — active / idle
 *
 * `idle` is deliberately absent from `SET_STATUS`. A client that could claim it
 * could lie about being at its desk, which is why the schema has no room for the
 * value rather than the handler having a check for it. This asserts the refusal
 * as well as the happy path, because a schema that quietly widened would break
 * nothing visible until somebody noticed a permanently-idle colleague answering
 * messages.
 *
 * The status also has to survive a resume. It lives on the participant, not on
 * the socket, so reconnecting must not put someone back to `available` — which
 * would announce them as interruptible at the exact moment they were not.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const presenceStatus: Scenario = {
  name: 'presence-status',
  covers: 'AC-4.4 — presence status replicates, survives a resume, and idle stays server-owned',

  async run(ctx) {
    const subject = new Bot(ctx.url, 'status-subject');
    const watcher = new Bot(ctx.url, 'status-watcher');

    try {
      await subject.connect();
      const joined = await subject.join();
      await watcher.connect();
      await watcher.join();

      const spawn = joined.spawn;
      subject.moveTo(spawn.x, spawn.z);
      watcher.moveTo(spawn.x + 2, spawn.z);

      for (let i = 0; i < 4; i++) {
        subject.sendTransform();
        watcher.sendTransform();
        await sleep(60);
      }
      await sleep(300);

      assert(
        watcher.remotes.has(subject.localId),
        'the watcher never saw the subject; nothing below would prove anything',
      );
      assertEqual(
        watcher.remotes.get(subject.localId)!.status,
        'available',
        'a fresh participant did not start as available',
      );

      watcher.resetEvents();
      subject.resetEvents();

      // ── the change reaches an observer ────────────────────────────────────
      subject.setStatus('do-not-disturb');
      await waitUntil(
        () => watcher.remotes.get(subject.localId)?.status === 'do-not-disturb',
        2000,
        'do-not-disturb to reach the watcher',
      );

      // ── and reaches the person who set it ─────────────────────────────────
      // An observer is never in their own interest set, so a broadcast routed
      // through it alone leaves the one person who pressed the control looking
      // at an unchanged nameplate.
      assert(
        subject.updatesFor(subject.localId, 'status').length > 0,
        'the subject never received its own status change; in third person that is the ' +
          'avatar they are looking at',
      );

      subject.setStatus('away');
      await waitUntil(
        () => watcher.remotes.get(subject.localId)?.status === 'away',
        2000,
        'away to reach the watcher',
      );

      // ── idle cannot be claimed ────────────────────────────────────────────
      subject.resetEvents();
      // Cast through unknown on purpose: the type forbids this, and the point is
      // that the *server* forbids it too. A bot that could not express the bad
      // frame could not test the refusal.
      subject.setStatus('idle' as unknown as 'available');
      await sleep(300);

      assert(
        subject.events.errors.some((error) => error.code === 'bad-frame'),
        'SET_STATUS with "idle" was not rejected; FR-1.22 makes idle server-derived, and a ' +
          'client able to set it can claim to be at its desk indefinitely',
      );
      assertEqual(
        watcher.remotes.get(subject.localId)!.status,
        'away',
        'a rejected status frame still changed the participant',
      );

      // ── it survives a resume ──────────────────────────────────────────────
      // A bare terminate, not a LEAVE: the participant is retained for the
      // resume window, which is the state this is about.
      const token = subject.joined!.resumeToken;
      subject.terminate();
      await sleep(200);

      const resumed = new Bot(ctx.url, 'status-subject');
      try {
        await resumed.connect();
        const rejoined = await resumed.join(token);
        assert(rejoined.resumed, 'the resume was refused, so nothing about retention is tested');
        assertEqual(
          rejoined.localId,
          joined.localId,
          'the resume created a second participant rather than rebinding the first',
        );

        await waitUntil(
          () => watcher.remotes.get(resumed.localId)?.status === 'away',
          2000,
          'the resumed participant to be seen as away again',
        );
      } finally {
        resumed.close();
      }

      ctx.log(
        'do-not-disturb and away reached an observer and their author, "idle" was refused ' +
          'as a bad frame, and away survived a reconnect',
      );
    } finally {
      subject.close();
      watcher.close();
      await sleep(100);
    }
  },
};
