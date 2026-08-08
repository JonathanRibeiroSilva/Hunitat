/**
 * `AC-6.6` — a session survives a reconnect, and ends when it is told to.
 *
 * Three properties, and the middle one is the one worth writing down:
 *
 *   **A bad token is refused, never downgraded to a guest.** This is the failure
 *   mode with no symptom: someone whose access token expired keeps walking
 *   around, and everything they do — their profile edits, their direct messages,
 *   their membership — lands on an ephemeral identity that disappears when they
 *   close the tab. Refusing produces one clear error the client can refresh and
 *   retry against; downgrading produces a working world and lost data.
 *
 *   **Rotation, with reuse detection.** A rotated refresh token presented a
 *   second time must kill the whole family. Without that, rotation is decorative
 *   — a stolen token stays valid alongside the legitimate one and nothing
 *   notices.
 *
 *   **Logout ends it.** `FR-6.4`.
 */

import { TUNING } from '@hubitat/protocol';
import { Bot, sleep } from '../bot.js';
import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const sessionLifecycle: Scenario = {
  name: 'session-lifecycle',
  covers: 'AC-6.6, FR-6.4, FR-6.17, FR-6.18 — reconnect, rotation, reuse detection, logout',

  async run(ctx) {
    const { base } = await requireAccounts(ctx.url);

    const account = new Account(base, uniqueEmail('carl'), 'carls-quite-long-passphrase');
    await account.register('Carl');

    // ── FR-6.18 — an invalid token is refused, not downgraded ───────────────
    const impostor = new Bot(ctx.url, 'Impostor');
    impostor.accessToken = 'not.a.real.token';
    await impostor.connect();
    const refused = await impostor.tryJoin();

    assert(refused.joined === undefined, 'FR-6.18: a bad token does not get in');
    assertEqual(
      refused.error?.code,
      'auth-required',
      'FR-6.18: and is told to sign in again, rather than silently becoming a guest',
    );
    impostor.terminate();

    // A token that is well-formed but signed by somebody else fails the same
    // way — the signature, not the shape, is what is checked.
    const forged = new Bot(ctx.url, 'Forger');
    forged.accessToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJmYW0iOiJ4In0.' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await forged.connect();
    const forgedAttempt = await forged.tryJoin();
    assertEqual(
      forgedAttempt.error?.code,
      'auth-required',
      'FR-6.18: a forged signature is refused too',
    );
    forged.terminate();

    // ── AC-6.6 — the real session survives a reconnect ──────────────────────
    const bot = new Bot(ctx.url, 'ignored');
    bot.accessToken = account.accessToken;
    await bot.connect();
    const first = await bot.join();
    assertEqual(first.identity.kind, 'account', 'signed in on the first connection');

    // A crashed tab, not a clean exit: the participant is retained for the
    // resume window (FR-1.5) and the same token must still work.
    bot.terminate();

    const again = new Bot(ctx.url, 'ignored');
    again.accessToken = account.accessToken;
    await again.connect();
    const resumed = await again.join(first.resumeToken);

    assertEqual(
      resumed.identity.kind,
      'account',
      'AC-6.6: an authenticated reconnect comes back as the same account',
    );
    assertEqual(resumed.identity.accountId, account.dto.id, 'the same account');
    assertEqual(resumed.resumed, true, 'and rebinds the retained participant (FR-1.5)');
    assertEqual(
      resumed.sessionId,
      first.sessionId,
      'FR-1.5 still holds with a token in the handshake — one participant, not two',
    );
    again.close();

    // ── FR-6.17 — rotation ──────────────────────────────────────────────────
    const rotated = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: cookieHeader(account),
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(rotated.status, 200, 'FR-6.17: the session refreshes');

    const stale = cookieHeader(account);
    adoptCookie(account, rotated);

    // ── The race, tolerated ─────────────────────────────────────────────────
    //
    // Two tabs restored at the same instant read one cookie out of a shared jar
    // and both refresh. Inside `REFRESH_REUSE_LEEWAY_MS` that is a client racing
    // itself, and treating it as theft would sign somebody out of both tabs for
    // opening two tabs — `FR-6.17` broken in the ordinary case to defend against
    // an attack that is not happening.
    const raced = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: stale,
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(
      raced.status,
      200,
      'a token re-presented within the leeway is a concurrent client, not a thief',
    );

    const surviving = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: cookieHeader(account),
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(surviving.status, 200, 'and the family is still alive afterwards');
    adoptCookie(account, surviving);

    // ── The replay, caught ──────────────────────────────────────────────────
    //
    // The same token, presented after the window has closed. This is the case
    // ADR 0011 exists for, and it costs a real wait: the leeway is a wall-clock
    // property and there is no way to observe it without letting it elapse.
    const consumed = cookieHeader(account);
    const spend = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: consumed,
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(spend.status, 200, 'the token to be replayed was spent normally first');
    adoptCookie(account, spend);

    ctx.log(`waiting out the ${TUNING.REFRESH_REUSE_LEEWAY_MS} ms reuse leeway…`);
    await sleep(TUNING.REFRESH_REUSE_LEEWAY_MS + 1_000);

    const replay = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: consumed,
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(
      replay.status,
      401,
      'ADR 0011: a token spent longer ago than the leeway is theft, and is refused',
    );

    const afterDetection = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: cookieHeader(account),
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(
      afterDetection.status,
      401,
      'ADR 0011: and it revokes the whole family, including the legitimate successor — ' +
        'one of the two holders is a thief and the server cannot tell which',
    );

    // ── FR-6.4 — logout ─────────────────────────────────────────────────────
    const fresh = new Account(base, account.email, account.password);
    await fresh.login();
    const loggedOut = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: cookieHeader(fresh),
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(loggedOut.status, 204, 'FR-6.4: logging out is accepted');

    const afterLogout = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: cookieHeader(fresh),
      signal: AbortSignal.timeout(5000),
    });
    assertEqual(afterLogout.status, 401, 'FR-6.4: and the session is over');

    ctx.log(
      'reconnect kept the account; a raced refresh was tolerated, a replayed one killed the family',
    );
  },
};

/**
 * Reaches into the account's private cookie jar.
 *
 * The rotation assertions need to send a *stale* cookie deliberately, which is
 * the one thing `Account` is built to stop happening by accident. Confined to
 * this file rather than widened on the class, so no other scenario can replay a
 * token without meaning to.
 */
function cookieHeader(account: Account): Record<string, string> {
  const jar = (account as unknown as { cookie: string | null }).cookie;
  return jar ? { cookie: jar } : {};
}

function adoptCookie(account: Account, response: Response): void {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    if (pair?.startsWith('hubitat_refresh=')) {
      (account as unknown as { cookie: string | null }).cookie = pair.endsWith('=') ? null : pair;
    }
  }
}
