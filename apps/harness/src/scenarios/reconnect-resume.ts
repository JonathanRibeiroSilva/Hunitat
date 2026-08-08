/**
 * reconnect-resume — FR-1.5 and the Phase 1 no-duplicate rule.
 *
 *   > If a connection drops, the client attempts to reconnect and restore the
 *   > participant's presence and last-known position without a full manual
 *   > rejoin.
 *
 *   > Reconnect must not duplicate a participant (the old session is reconciled
 *   > or replaced).
 *
 * The duplicate is the interesting failure. A server that treats resume as
 * "join again with the old name" leaves the original participant in the registry
 * and the observer ends up watching two copies, one of which never moves again.
 * So this checks identity continuity — same session id, same instance-local id —
 * and that the observer's view holds exactly one entry.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertClose, assertEqual, type Scenario } from '../runner.js';

export const reconnectResume: Scenario = {
  name: 'reconnect-resume',
  covers: 'FR-1.5 — resume restores position without duplicating',

  async run(ctx) {
    const observer = new Bot(ctx.url, 'resume-observer');
    const rejoiner = new Bot(ctx.url, 'resume-rejoiner');

    try {
      await observer.connect();
      await observer.join();
      observer.moveTo(0, 0);

      await rejoiner.connect();
      const firstJoin = await rejoiner.join();
      assertEqual(firstJoin.resumed, false, 'a fresh join reported itself as resumed');

      // A distinctive position, so "restored" cannot be confused with "respawned".
      const parked = { x: 7.25, z: -3.5 };
      rejoiner.moveTo(parked.x, parked.z, 0, Math.PI / 2);
      await sleep(200);

      await waitUntil(
        () => observer.remotes.has(rejoiner.localId),
        3000,
        'observer to see the rejoiner',
      );

      const originalSessionId = firstJoin.sessionId;
      const originalLocalId = rejoiner.localId;
      const token = firstJoin.resumeToken;

      rejoiner.terminate();
      await waitUntil(
        () => !observer.remotes.has(originalLocalId),
        5000,
        'rejoiner to drop out of the observer view',
      );

      // Reconnect inside the resume window.
      const returning = new Bot(ctx.url, 'resume-rejoiner');
      await returning.connect();
      const secondJoin = await returning.join(token);

      assertEqual(secondJoin.resumed, true, 'the server did not honour the resume token');
      assertEqual(
        secondJoin.sessionId,
        originalSessionId,
        'resume produced a different session id — this is a new participant, not a restored one',
      );
      assertEqual(
        secondJoin.localId,
        originalLocalId,
        'resume produced a different instance-local id',
      );

      // FR-1.5: last-known position, not the spawn.
      assertClose(secondJoin.spawn.x, parked.x, 0.02, 'restored x');
      assertClose(secondJoin.spawn.z, parked.z, 0.02, 'restored z');

      assert(
        secondJoin.resumeToken !== token,
        'the resume token was not rotated — a consumed token must not stay valid',
      );

      await waitUntil(
        () => observer.remotes.has(originalLocalId),
        3000,
        'observer to see the resumed participant again',
      );

      // The duplicate check: exactly one remote, at the restored position.
      assertEqual(
        observer.remotes.size,
        1,
        `observer sees ${observer.remotes.size} participants after a resume — expected 1`,
      );

      // And the old token must now be dead.
      const impostor = new Bot(ctx.url, 'resume-impostor');
      await impostor.connect();
      const impostorJoin = await impostor.join(token);
      assertEqual(
        impostorJoin.resumed,
        false,
        'a consumed resume token was accepted a second time',
      );
      impostor.close();

      ctx.log(`session ${originalSessionId.slice(0, 8)}… restored at (${parked.x}, ${parked.z})`);
      ctx.log('token rotated, replay refused, observer sees exactly one participant');

      returning.close();
    } finally {
      observer.close();
      rejoiner.terminate();
      await sleep(100);
    }
  },
};
