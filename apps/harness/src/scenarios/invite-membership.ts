/**
 * `AC-6.3` and `AC-6.4` — invites grant membership, and spent ones do not.
 *
 * The single-use invite is the interesting half. `FR-6.14` allows one, and the
 * implementation notes flag redemption as a genuine race: checking `uses` and
 * then incrementing it without a lock over-issues, and two people clicking the
 * same link at the same moment is ordinary rather than adversarial.
 *
 * So this scenario redeems a one-use invite from **two accounts concurrently**
 * and asserts that exactly one wins. Serial redemption would pass against the
 * unlocked implementation the transaction exists to rule out.
 */

import { Account, previewInvite, requireAccounts, uniqueEmail } from '../accounts.js';
import { Bot } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const inviteMembership: Scenario = {
  name: 'invite-membership',
  covers: 'AC-6.3, AC-6.4, FR-6.12–FR-6.16 — invites, membership, and the redemption race',

  async run(ctx) {
    // The shared member issues the invite. Membership cannot be conjured —
    // `FR-6.13` makes an invite the way in, and the founding account is the only
    // exception — so `requireAccounts` establishes one before any scenario runs.
    const { base, member: host } = await requireAccounts(ctx.url);

    // ── FR-6.12, FR-6.14 — a bounded invite ─────────────────────────────────
    const invite = await host.createInvite({ maxUses: 1 });
    assert(typeof invite.expiresAt === 'string', 'FR-6.14: every invite carries an expiry');
    assertEqual(invite.maxUses, 1, 'this one is single-use');
    assertEqual(invite.uses, 0, 'and unused');
    ctx.log(`invite ${invite.code}, single use, expires ${invite.expiresAt}`);

    const preview = await previewInvite(base, invite.code);
    assertEqual(preview.valid, true, 'the recipient can check the link before acting on it');
    assertEqual(preview.reason, 'ok', 'and is told it is good');

    // ── The race. Two accounts, one use, one winner ─────────────────────────
    const first = new Account(base, uniqueEmail('racer-a'), 'racer-a-passphrase-here');
    const second = new Account(base, uniqueEmail('racer-b'), 'racer-b-passphrase-here');
    await Promise.all([first.register('Racer A'), second.register('Racer B')]);

    assertEqual(first.dto.memberships.length, 0, 'a fresh account belongs to nothing');

    const [a, b] = await Promise.all([first.tryRedeem(invite.code), second.tryRedeem(invite.code)]);

    const winners = [a, b].filter((result) => result.status === 200);
    const losers = [a, b].filter((result) => result.status !== 200);

    assertEqual(
      winners.length,
      1,
      `FR-6.14: a single-use invite admits exactly one of two simultaneous redemptions ` +
        `(got ${winners.length}; a and b were ${a.status} and ${b.status})`,
    );
    assertEqual(losers[0]?.status, 422, 'and the other is refused');
    assert(
      /already been used/.test(losers[0]?.message ?? ''),
      `Rules: exhausted reads as used, not as expired — got "${losers[0]?.message}"`,
    );

    // ── AC-6.3 — the winner is a member, durably ────────────────────────────
    const winner = a.status === 200 ? first : second;
    const winnerProfile = await winner.me();
    assertEqual(winnerProfile.memberships.length, 1, 'AC-6.3: redeeming granted membership');
    assertEqual(winnerProfile.memberships[0]?.spaceSlug, 'default', 'of this space');

    // FR-6.15 — a returning member is recognised without a new invite.
    const returning = new Account(base, winner.email, winner.password);
    const relogin = await returning.login();
    assertEqual(
      relogin.memberships.length,
      1,
      'FR-6.15: membership is durable — signing in again needs no second invite',
    );

    // And the world agrees: the join says `member`.
    const bot = new Bot(ctx.url, 'member-check');
    bot.accessToken = returning.accessToken;
    await bot.connect();
    const joined = await bot.join();
    assertEqual(joined.identity.member, true, 'FR-6.13: the world instance sees a member');
    bot.close();

    // ── AC-6.4 — the exhausted invite stays exhausted ───────────────────────
    const after = await previewInvite(base, invite.code);
    assertEqual(after.valid, false, 'AC-6.4: a spent invite previews as invalid');
    assertEqual(after.reason, 'exhausted', 'and says which kind of invalid');
    assert(after.spaceName === undefined, 'a refused preview names no space');

    ctx.log(`one of two concurrent redemptions won; the loser got "${losers[0]?.message}"`);
  },
};
