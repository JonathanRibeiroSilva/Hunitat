/**
 * `AC-6.5` — a Space that requires accounts blocks guests and points somewhere.
 *
 * Two halves, and the second is the one the Rules single out:
 *
 *   > A Space configured to disallow guests must reject guest entry with a clear
 *   > message **and an invite path**.
 *
 * So it is not enough that the join fails. The refusal has to carry a distinct
 * code — a client cannot offer "sign in or open your invite" in response to a
 * generic denial — and a message that says what to do. Both are asserted.
 *
 * The setting is restored in a `finally`, because every scenario after this one
 * joins as a guest and would otherwise fail for a reason that has nothing to do
 * with what it tests.
 */

import { Bot } from '../bot.js';
import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const guestsNotAllowed: Scenario = {
  name: 'guests-not-allowed',
  covers: 'AC-6.5, FR-6.8 — a space can require accounts, and says so usefully',

  async run(ctx) {
    // Changing the policy needs a member (`FR-6.13` is the only distinction this
    // phase has to check against), which `requireAccounts` establishes.
    const { member } = await requireAccounts(ctx.url);

    try {
      await member.setAllowGuests(false);
      ctx.log('space closed to guests');

      // ── The guest is refused ──────────────────────────────────────────────
      const guest = new Bot(ctx.url, 'Uninvited');
      await guest.connect();
      const attempt = await guest.tryJoin();

      assert(attempt.joined === undefined, 'AC-6.5: a guest is not admitted');
      assertEqual(
        attempt.error?.code,
        'guests-not-allowed',
        'AC-6.5: with a code a client can act on, not a generic denial',
      );
      assert(
        /sign in/i.test(attempt.error?.message ?? '') &&
          /invite/i.test(attempt.error?.message ?? ''),
        `Rules: the refusal points at login and at an invite — got "${attempt.error?.message}"`,
      );
      guest.terminate();

      // ── The member is not ─────────────────────────────────────────────────
      const admitted = new Bot(ctx.url, 'ignored');
      admitted.accessToken = member.accessToken;
      await admitted.connect();
      const joined = await admitted.join();

      assertEqual(joined.identity.kind, 'account', 'a signed-in account still gets in');
      assertEqual(joined.identity.member, true, 'as a member');
      admitted.close();

      ctx.log(`guest refused with "${attempt.error?.code}"; the member joined normally`);
    } finally {
      // Every later scenario joins as a guest. Leaving the door shut would fail
      // all of them for a reason unrelated to what they test.
      await member.setAllowGuests(true);
    }

    // Proven, rather than assumed, because the whole rest of the run depends on
    // it and a silent failure here would be diagnosed as twenty other bugs.
    const reopened = new Bot(ctx.url, 'Guest Again');
    await reopened.connect();
    const rejoin = await reopened.tryJoin();
    assert(rejoin.joined !== undefined, 'the space was reopened to guests afterwards');
    reopened.close();
  },
};
