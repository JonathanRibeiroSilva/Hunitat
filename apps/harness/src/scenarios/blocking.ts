/**
 * `AC-7.5` — blocking somebody stops their media and chat for the blocker, and
 * persists across the blocker's sessions.
 *
 * ── Why the audience frame is asserted and not only the chat ────────────────
 *
 * The Phase 7 implementation notes are explicit:
 *
 *   > Blocks belong in `resolveAudience()`. Filtering blocked users in the UI
 *   > leaves audio flowing and only hides it.
 *
 * A scenario that only checked chat would pass against exactly that bug — chat
 * is easy to filter in the wrong place, and the audience frame is the one that
 * decides whether a WebRTC track is subscribed at all. So both are checked, and
 * the audience is checked **in both directions**: the Rules require a blocked
 * user to be unable to reach the blocker, which a one-directional filter would
 * leave wide open in the direction that matters most.
 *
 * ── Why both parties are accounts ───────────────────────────────────────────
 *
 * `FR-7.18` asks for durability "for the blocker's identity (persists across
 * sessions for accounts)". A guest's blocks are keyed to a session and correctly
 * do not survive one, so a guest could not demonstrate the requirement — the
 * asymmetry is inherent, and it is the same one direct-message history has.
 */

import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const blocking: Scenario = {
  name: 'blocking',
  covers: 'AC-7.5, FR-7.16, FR-7.18 — a personal block, in resolveAudience, and durable',

  async run(ctx) {
    const { base } = await requireAccounts(ctx.url);

    const blockerAccount = new Account(base, uniqueEmail('blocker'), 'blocker-passphrase-here');
    const nuisanceAccount = new Account(base, uniqueEmail('nuisance'), 'nuisance-passphrase-here');
    await Promise.all([blockerAccount.register('Blocker'), nuisanceAccount.register('Nuisance')]);

    const blocker = new Bot(ctx.url, 'Blocker');
    blocker.accessToken = blockerAccount.accessToken;
    const nuisance = new Bot(ctx.url, 'Nuisance');
    nuisance.accessToken = nuisanceAccount.accessToken;

    for (const bot of [blocker, nuisance]) {
      await bot.connect();
      await bot.join();
    }

    // Standing next to each other, so they are audible by proximity and any
    // absence afterwards is the block rather than distance.
    blocker.moveTo(0, 0);
    nuisance.moveTo(2, 0);
    await waitUntil(
      () =>
        blocker.hears(nuisance.localId) !== undefined &&
        nuisance.hears(blocker.localId) !== undefined,
      4000,
      'they can hear each other to begin with',
    );

    const nuisanceSession = nuisance.joined!.sessionId;

    // ── The block ───────────────────────────────────────────────────────────
    blocker.setBlocked(nuisanceSession, true);

    await waitUntil(
      () => blocker.remoteBySession(nuisanceSession)?.blocked === true,
      3000,
      'AC-7.5: the blocker is told which of the people in front of them they have blocked',
    );

    // The blocked party is told nothing. The Rules require a block not to imply
    // the blocker is offline, and telling somebody they have been blocked is the
    // other half of the same disclosure.
    assertEqual(
      nuisance.remoteBySession(blocker.joined!.sessionId)?.blocked,
      false,
      'FR-7.16: and the blocked party is not',
    );

    // ── Media, in `resolveAudience` and in both directions ──────────────────
    await waitUntil(
      () => blocker.hears(nuisance.localId) === undefined,
      4000,
      'AC-7.5: the blocker stops receiving their media',
    );
    await waitUntil(
      () => nuisance.hears(blocker.localId) === undefined,
      4000,
      'FR-7.16: and they stop receiving the blocker’s — a one-way block is harassment with a mute button',
    );

    // Still in the presence list, both ways. "Not falsely implying the blocker
    // is offline" is a rule, and disappearing is the loudest possible way to
    // break it.
    assert(
      blocker.remotes.has(nuisance.localId),
      'Rules: they remain visible in presence, just silent',
    );
    assert(nuisance.remotes.has(blocker.localId), 'and so does the blocker, from the other side');

    // ── Chat ────────────────────────────────────────────────────────────────
    blocker.resetEvents();
    nuisance.resetEvents();

    nuisance.chatSend('room', 'blocked room message');
    const roomArrived = await blocker.waitForChat('blocked room message', 1500);
    assert(!roomArrived, 'AC-7.5: a room message from a blocked person does not arrive');

    nuisance.chatSend('direct', 'blocked direct message', blocker.joined!.sessionId);
    const directArrived = await blocker.waitForChat('blocked direct message', 1500);
    assert(!directArrived, 'FR-7.16: nor a direct one');
    // And no rejection either. A refusal that only happened for blocked senders
    // would be a disclosure, so the send succeeds from their side and reaches
    // nobody.
    assertEqual(
      nuisance.chatRejects.length,
      0,
      'Rules: the blocked sender is not told — a refusal here would be the disclosure',
    );

    // The reverse direction, which is the half a one-sided implementation
    // forgets.
    blocker.chatSend('room', 'message toward a blocked person');
    const reverse = await nuisance.waitForChat('message toward a blocked person', 1500);
    assert(!reverse, 'FR-7.16: and nothing travels the other way either');

    // Somebody else is unaffected. A block is personal, not a mute.
    const bystander = new Bot(ctx.url, 'Bystander');
    await bystander.connect();
    await bystander.join();
    await waitUntil(() => bystander.remotes.size >= 2, 4000, 'the bystander sees both');

    nuisance.chatSend('room', 'ordinary room message');
    assert(
      await bystander.waitForChat('ordinary room message', 2000),
      'FR-7.16: a block is personal — everybody else still hears them',
    );

    // ── FR-7.18 — durable for an account ────────────────────────────────────
    blocker.close();
    await sleep(300);

    const returning = new Bot(ctx.url, 'Blocker');
    returning.accessToken = blockerAccount.accessToken;
    await returning.connect();
    await returning.join();
    returning.moveTo(0, 0);

    await waitUntil(
      () => returning.remoteBySession(nuisanceSession) !== undefined,
      4000,
      'the returning blocker can see them again',
    );
    assertEqual(
      returning.remoteBySession(nuisanceSession)?.blocked,
      true,
      'AC-7.5: the block survived the session it was made in',
    );

    nuisance.chatSend('room', 'still blocked after a reconnect');
    assert(
      !(await returning.waitForChat('still blocked after a reconnect', 1500)),
      'FR-7.18: and it is still in force, not merely remembered',
    );

    // ── Lifting it ──────────────────────────────────────────────────────────
    returning.setBlocked(nuisanceSession, false);
    await waitUntil(
      () => returning.remoteBySession(nuisanceSession)?.blocked === false,
      3000,
      'the block is lifted',
    );

    nuisance.chatSend('room', 'unblocked message');
    assert(
      await returning.waitForChat('unblocked message', 3000),
      'AC-7.5: and their messages arrive again',
    );
    await waitUntil(
      () => returning.hears(nuisance.localId) !== undefined,
      4000,
      'as does their audio',
    );

    for (const bot of [returning, nuisance, bystander]) bot.close();
    ctx.log('block cut media both ways and chat all four ways, and survived a reconnect');
  },
};
