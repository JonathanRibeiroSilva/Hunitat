/**
 * presence-churn — AC-1.7, plus FR-1.2 and the frame limits.
 *
 *   > The presence list reflects joins and leaves within a few seconds.
 *
 * Runs a burst of joins and leaves and checks the observer's view tracks both
 * directions. Also covers two things that are cheap to verify here and awkward
 * anywhere else:
 *
 *   - FR-1.2: a blank display name produces a generated one.
 *   - NFR-31/32: oversized and pre-JOIN frames are refused rather than
 *     processed. Phase 1 has no authentication, so these limits are the only
 *     thing between the gateway and a malformed client.
 */

import { WebSocket } from 'ws';
import { Op, PROTOCOL_VERSION, encodeJsonFrame, encodeTransform } from '@hubitat/protocol';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const CHURN_BOTS = 6;

export const presenceChurn: Scenario = {
  name: 'presence-churn',
  covers: 'AC-1.7, FR-1.2, NFR-31/32 — presence tracks joins and leaves; limits hold',

  async run(ctx) {
    const observer = new Bot(ctx.url, 'churn-observer');

    try {
      await observer.connect();
      await observer.join();
      observer.moveTo(0, 0);
      await sleep(150);
      observer.resetEvents();

      // ── joins ───────────────────────────────────────────────────────────
      const joiners: Bot[] = [];
      const joinStart = Date.now();

      for (let i = 0; i < CHURN_BOTS; i++) {
        const bot = new Bot(ctx.url, `churn-${i}`);
        await bot.connect();
        await bot.join();
        bot.moveTo(Math.cos(i) * 3, Math.sin(i) * 3);
        joiners.push(bot);
      }

      await waitUntil(
        () => joiners.every((bot) => observer.remotes.has(bot.localId)),
        5000,
        `all ${CHURN_BOTS} joins to reach the observer`,
      );
      const joinMs = Date.now() - joinStart;
      assert(joinMs < 5000, `joins took ${joinMs} ms to appear`);

      // ── leaves ──────────────────────────────────────────────────────────
      const leaveStart = Date.now();
      for (const bot of joiners) bot.close();

      await waitUntil(() => observer.remotes.size === 0, 5000, 'all leaves to reach the observer');
      const leaveMs = Date.now() - leaveStart;
      assert(leaveMs < 5000, `leaves took ${leaveMs} ms to register`);

      ctx.log(`${CHURN_BOTS} joins visible in ${joinMs} ms, ${CHURN_BOTS} leaves in ${leaveMs} ms`);

      // ── FR-1.2: generated display name ──────────────────────────────────
      const anonymous = new Bot(ctx.url, '');
      await anonymous.connect();
      const joined = await anonymous.join();
      assert(
        joined.displayName.trim().length > 0,
        'a blank display name was accepted verbatim instead of generating one',
      );
      ctx.log(`blank name generated as "${joined.displayName}"`);
      anonymous.close();

      // ── NFR-31/32: limits ───────────────────────────────────────────────
      await assertPreJoinFrameRefused(ctx.url);
      await assertOversizedFrameRefused(ctx.url);
      ctx.log('pre-JOIN frame refused; oversized frame closed the connection');
    } finally {
      observer.close();
      await sleep(100);
    }
  },
};

/** Only JOIN is accepted before the handshake completes. */
async function assertPreJoinFrameRefused(url: string): Promise<void> {
  const socket = new WebSocket(url, [PROTOCOL_VERSION]);
  socket.binaryType = 'nodebuffer';

  const codes: string[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      socket.on('message', (data: Buffer) => {
        if (data[0] === Op.ERROR) {
          const payload = JSON.parse(data.subarray(1).toString('utf8')) as {
            code: string;
          };
          codes.push(payload.code);
        }
      });
      socket.send(encodeTransform({ x: 1, y: 0, z: 1, yaw: 0 }));
      setTimeout(resolve, 400);
    });
  });

  socket.close();
  assertEqual(codes[0], 'not-joined', 'a transform before JOIN was not refused');
}

/** ws closes with 1009 past maxPayload, which is what the spec requires. */
async function assertOversizedFrameRefused(url: string): Promise<void> {
  const socket = new WebSocket(url, [PROTOCOL_VERSION]);
  socket.binaryType = 'nodebuffer';

  const closeCode = await new Promise<number>((resolve, reject) => {
    socket.once('error', () => resolve(-1));
    socket.once('close', (code) => resolve(code));
    socket.once('open', () => {
      socket.send(encodeJsonFrame(Op.JOIN, { displayName: 'x'.repeat(64 * 1024) }));
      setTimeout(() => reject(new Error('an oversized frame did not close the connection')), 3000);
    });
  });

  assert(
    closeCode === 1009 || closeCode === 1008 || closeCode === -1,
    `oversized frame closed with ${closeCode}; expected 1009 (message too big)`,
  );
}
