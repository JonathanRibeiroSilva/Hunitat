/**
 * `AC-6.1` — create an account, sign out, sign back in, find the same profile.
 *
 * Plus the two requirements that make it mean anything on the socket:
 *
 *   `FR-6.18` — the token is resolved *before* the connection joins a world, so
 *   the participant exists as an account from its first frame rather than being
 *   corrected afterwards.
 *
 *   `FR-6.11` — the identity other phases store is the durable one. Asserted the
 *   only way it can be observed from outside the process: a room message sent
 *   under one session id and read back through history under a *different* one
 *   still resolves to the person standing in the room.
 */

import { Bot, sleep } from '../bot.js';
import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, assertEquivalent, type Scenario } from '../runner.js';

export const accountIdentity: Scenario = {
  name: 'account-identity',
  covers: 'AC-6.1, FR-6.2, FR-6.9, FR-6.11, FR-6.18 — a durable identity across sessions',

  async run(ctx) {
    const { base } = await requireAccounts(ctx.url);
    const account = new Account(base, uniqueEmail('ana'), 'correct-horse-battery-staple');

    /**
     * Unique per run, for the reason `uniqueEmail` is.
     *
     * Room history is durable and the harness runs against a database that
     * survives between runs, so a fixed body matches **the oldest** identical
     * message — sent by a session that ended days ago and therefore resolving to
     * nobody. The assertion below would then fail on every run after the first,
     * reporting a durable-identity bug that is really a fixture colliding with
     * its own history.
     */
    const body = `a message from the first session (${Date.now().toString(36)})`;

    await account.register('Ana Lima');
    ctx.log(`registered ${account.email} as "Ana Lima"`);

    // ── First session: joins as an account, wearing the profile ──────────────
    const first = new Bot(ctx.url, 'ignored-by-the-server');
    first.accessToken = account.accessToken;
    await first.connect();
    const firstJoin = await first.join();

    assertEqual(firstJoin.identity.kind, 'account', 'FR-6.18: the join resolved to an account');
    assert(
      firstJoin.identity.accountId === account.dto.id,
      'FR-6.18: JOINED names the account the token belongs to',
    );
    assertEqual(
      firstJoin.displayName,
      'Ana Lima',
      'FR-6.9: the profile name wins over whatever the client asked for',
    );
    // Membership is deliberately NOT asserted here. This account redeemed no
    // invite, so it is an account that does not belong to the Space — a real
    // state (`FR-6.13`) and the one this scenario happens to produce. What is
    // being tested is that identity is durable, which has nothing to do with
    // membership.
    assertEqual(
      firstJoin.identity.member,
      false,
      'FR-6.13: an account that redeemed no invite is signed in but not a member',
    );

    const firstSessionId = firstJoin.sessionId;
    const wornFirst = firstJoin.appearance;

    // FR-6.11 — written under the durable identity, not this session id.
    first.chatSend('room', body);
    await sleep(400);
    first.close();
    await sleep(300);

    // ── Second session: a different sign-in, a different session id ──────────
    const returning = new Account(base, account.email, account.password);
    await returning.login();

    const second = new Bot(ctx.url, 'also-ignored');
    second.accessToken = returning.accessToken;
    await second.connect();
    const secondJoin = await second.join();

    assert(
      secondJoin.sessionId !== firstSessionId,
      'a second sign-in is genuinely a new session, so the test is not trivial',
    );
    assertEqual(
      secondJoin.displayName,
      'Ana Lima',
      'AC-6.1: the same profile comes back after signing out and in',
    );
    assertEquivalent(
      secondJoin.appearance,
      wornFirst,
      'AC-6.1: and the same avatar, from profiles.avatar_appearance',
    );
    assertEqual(secondJoin.identity.kind, 'account', 'still an account');

    // ── FR-6.11 — history resolves the old message to the new session ────────
    second.chatHistory('room');
    await sleep(600);

    const history = second.histories.find((page) => page.channelId === 'room');
    assert(history !== undefined, 'FR-5.12: the room history came back');

    const mine = history.messages.find((m) => m.body === body);
    assert(mine !== undefined, 'the message sent by the previous session is in the history');
    assertEqual(
      mine.senderId,
      secondJoin.localId,
      'FR-6.11: a message stored under the durable identity resolves to the same person ' +
        'now standing in the room, under a new session id',
    );
    assert(
      mine.senderSessionId.startsWith('acct:'),
      `FR-6.11: authorship is stored as a durable identity, got "${mine.senderSessionId}"`,
    );

    ctx.log(
      `same profile and avatar across two sessions; history attributed to ${mine.senderSessionId}`,
    );
    second.close();
  },
};
