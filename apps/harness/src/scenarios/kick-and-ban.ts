/**
 * `AC-7.3` — a kick removes somebody immediately; a ban keeps them out.
 *
 * The two halves are deliberately tested against different subjects, because
 * they are different guarantees:
 *
 *   **Kick** is tested on a guest. `FR-7.7` says a kicked user "may rejoin only
 *   if not also banned", so the interesting assertion is that they *can* come
 *   back — and that the short denylist the implementation notes ask for stops
 *   them doing it in the same instant, which is the difference between a
 *   moderation action and a race against a reconnect loop.
 *
 *   **Ban** is tested on an account, because that is the case `FR-7.8` is clean
 *   for. Its guest form keys on a browser fingerprint and is documented as weak;
 *   asserting it here would be asserting the strength of a cookie.
 *
 * ── The sharp edge this exists to catch ─────────────────────────────────────
 *
 * The Phase 7 notes:
 *
 *   > Moderation must reach a reconnecting target. A kicked or banned identity
 *   > presenting a valid resume token must be refused; the ban check belongs in
 *   > the resume path too, not only in fresh joins.
 *
 * So the banned account is made to present its resume token, not just a fresh
 * join. A ban that only guarded the fresh-join branch would pass every other
 * assertion here.
 */

import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const kickAndBan: Scenario = {
  name: 'kick-and-ban',
  covers: 'AC-7.3, FR-7.7, FR-7.8, FR-7.10 — removed now, and kept out afterwards',

  async run(ctx) {
    const { base, member: owner } = await requireAccounts(ctx.url);

    const moderator = new Bot(ctx.url, 'Moderator');
    moderator.accessToken = owner.accessToken;
    const observer = new Bot(ctx.url, 'Observer');
    const rowdy = new Bot(ctx.url, 'Rowdy Guest');

    for (const bot of [moderator, observer, rowdy]) {
      await bot.connect();
      await bot.join();
    }
    await waitUntil(
      () => moderator.remotes.size >= 2 && observer.remotes.size >= 2,
      4000,
      'everybody in range',
    );

    const rowdyLocalId = rowdy.localId;
    const rowdySession = rowdy.joined!.sessionId;
    observer.resetEvents();
    rowdy.resetEvents();

    // ── FR-7.7 — the kick ───────────────────────────────────────────────────
    moderator.moderate('kick', rowdySession, { reason: 'Shouting in the lobby.' });

    await waitUntil(
      () => rowdy.events.errors.length > 0,
      3000,
      'AC-7.3: the target is told before the socket closes',
    );
    const told = rowdy.events.errors[0]!;
    assertEqual(told.code, 'forbidden', 'a kick is not a ban, and says so');
    assert(
      /removed/i.test(told.message) && /Shouting/.test(told.message),
      `the reason travels with it — got "${told.message}"`,
    );

    await waitUntil(
      () => !observer.remotes.has(rowdyLocalId),
      3000,
      'AC-7.3: and the room sees them go, immediately',
    );

    // ── The short denylist (FR-7.7, implementation notes) ───────────────────
    //
    // Same fingerprint, which is what a reconnecting browser is. A fresh session
    // id would otherwise be a different identity, and the cooldown would never
    // match the case it exists for.
    const instant = new Bot(ctx.url, 'Rowdy Guest');
    instant.fingerprint = rowdy.fingerprint;
    await instant.connect();
    const immediate = await instant.tryJoin();

    assert(immediate.joined === undefined, 'a kicked client cannot be back in the same instant');
    assertEqual(
      immediate.error?.code,
      'forbidden',
      'and is told to wait rather than left retrying into silence',
    );
    instant.terminate();

    // A *different* browser is a different person as far as a kick is concerned.
    // `FR-7.7` says a kicked user may rejoin when not banned, and this is that
    // property — the cooldown is a debounce, not a sentence.
    const returning = new Bot(ctx.url, 'Rowdy Guest');
    await returning.connect();
    const back = await returning.tryJoin();
    assert(back.joined !== undefined, 'AC-7.3: a kick is not a ban — they can come back');
    returning.close();

    // ── FR-7.8 — the ban ────────────────────────────────────────────────────
    const banned = new Account(base, uniqueEmail('banned'), 'banned-account-passphrase');
    await banned.register('Persistent Person');

    const bannedBot = new Bot(ctx.url, 'Persistent Person');
    bannedBot.accessToken = banned.accessToken;
    await bannedBot.connect();
    await bannedBot.join();

    await waitUntil(
      () => moderator.remoteBySession(bannedBot.joined!.sessionId) !== undefined,
      4000,
      'the moderator can see them',
    );

    const bannedResumeToken = bannedBot.joined!.resumeToken;
    moderator.moderate('ban', bannedBot.joined!.sessionId, {
      reason: 'Repeatedly disruptive.',
      durationMinutes: 60,
    });

    await waitUntil(
      () => bannedBot.events.errors.some((error) => error.code === 'banned'),
      3000,
      'AC-7.3: a ban removes them too, with its own code',
    );
    const banMessage = bannedBot.events.errors.find((error) => error.code === 'banned')!.message;
    assert(
      /banned until/i.test(banMessage) && /Repeatedly disruptive/.test(banMessage),
      `AC-7.4: a timed ban says when it ends — got "${banMessage}"`,
    );

    // The sharp edge: the resume path. A ban checked only on fresh joins would
    // let this through, and every other assertion here would still pass.
    const resuming = new Bot(ctx.url, 'Persistent Person');
    resuming.accessToken = banned.accessToken;
    await resuming.connect();
    const resumeAttempt = await resuming.tryJoin(bannedResumeToken);
    assertEqual(
      resumeAttempt.error?.code,
      'banned',
      'FR-7.8: a valid resume token does not get a banned identity back in',
    );
    resuming.terminate();

    // And a fresh join, which is the obvious half.
    const fresh = new Bot(ctx.url, 'Persistent Person');
    fresh.accessToken = banned.accessToken;
    await fresh.connect();
    const freshAttempt = await fresh.tryJoin();
    assertEqual(freshAttempt.error?.code, 'banned', 'AC-7.3: nor a fresh one');
    fresh.terminate();

    // ── Lifting it lets them back ───────────────────────────────────────────
    const bans = await owner.moderation();
    const active = bans.bans.find(
      (ban) => ban.accountId === banned.dto.id && ban.liftedAt === null,
    );
    assert(active !== undefined, 'the ban is on the record');
    assertEqual(active!.reason, 'Repeatedly disruptive.', 'with its reason');
    assert(active!.expiresAt !== null, 'FR-7.8: and its expiry, because it was time-limited');

    await owner.liftBan(active!.id);
    await sleep(100);

    const readmitted = new Bot(ctx.url, 'Persistent Person');
    readmitted.accessToken = banned.accessToken;
    await readmitted.connect();
    const readmission = await readmitted.tryJoin();
    assert(readmission.joined !== undefined, 'AC-7.3: lifting the ban lets them back in');
    readmitted.close();

    // Lifted rather than deleted: the row is the record `FR-7.20` asks to be
    // able to trust, and a ban that was issued and quietly removed is exactly
    // what an audit trail exists to make visible.
    const after = await owner.moderation();
    const lifted = after.bans.find((ban) => ban.id === active!.id);
    assert(lifted !== undefined, 'the lifted ban is still listed');
    assert(lifted!.liftedAt !== null, 'marked as lifted rather than erased');

    for (const bot of [moderator, observer, bannedBot]) bot.close();
    ctx.log('kicked and back; banned through a resume token; lifted and readmitted');
  },
};
