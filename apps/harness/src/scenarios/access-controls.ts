/**
 * `AC-7.4` — a locked, password-protected, allowlisted or full Space refuses
 * ineligible entrants **with a clear reason**.
 *
 * Four controls, four distinct refusal codes, and the codes are most of the
 * point. A merged "you cannot enter" would leave the client unable to offer the
 * right next step, and the next steps have nothing in common: type a password,
 * wait a minute, ask an admin, or give up.
 *
 * ── Everything is restored in a `finally` ───────────────────────────────────
 *
 * Every scenario after this one joins as a guest. A lock or a password left
 * behind would fail all of them for a reason unrelated to what they test, which
 * is the same trap `guests-not-allowed` documents one phase earlier — and the
 * restoration is *asserted*, not assumed, because a silent failure here would be
 * diagnosed as twenty other bugs.
 */

import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { Bot } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const PASSWORD = 'open-sesame-1234';

export const accessControls: Scenario = {
  name: 'access-controls',
  covers: 'AC-7.4, FR-7.11–FR-7.15 — lock, password, allowlist and capacity, each with its reason',

  async run(ctx) {
    const { base, member: owner } = await requireAccounts(ctx.url);

    try {
      // ── FR-7.11 — locked ──────────────────────────────────────────────────
      await owner.setAccess({ locked: true });

      const lockedOut = new Bot(ctx.url, 'Latecomer');
      await lockedOut.connect();
      const lockedAttempt = await lockedOut.tryJoin();
      assertEqual(lockedAttempt.error?.code, 'space-locked', 'AC-7.4: a locked space refuses');
      assert(
        /closed/i.test(lockedAttempt.error?.message ?? ''),
        `with a sentence somebody can act on — got "${lockedAttempt.error?.message}"`,
      );
      lockedOut.terminate();

      // The admin exception, and it is not an oversight: every one of these can
      // be switched on from inside the world, and without it an owner who locks
      // a space and then loses their connection has no way back in to unlock it.
      const admin = new Bot(ctx.url, 'Owner');
      admin.accessToken = owner.accessToken;
      await admin.connect();
      const adminEntry = await admin.tryJoin();
      assert(
        adminEntry.joined !== undefined,
        'FR-7.15: an admin is not locked out of the space they locked',
      );
      admin.close();

      await owner.setAccess({ locked: false });

      // ── FR-7.12 — password ────────────────────────────────────────────────
      await owner.setAccess({ password: PASSWORD });

      const noPassword = new Bot(ctx.url, 'No Password');
      await noPassword.connect();
      const missing = await noPassword.tryJoin();
      assertEqual(
        missing.error?.code,
        'password-required',
        'AC-7.4: the client is told to ask for one, not merely refused',
      );
      noPassword.terminate();

      const wrongPassword = new Bot(ctx.url, 'Wrong Password');
      wrongPassword.spacePassword = 'not-the-password';
      await wrongPassword.connect();
      const wrong = await wrongPassword.tryJoin();
      assertEqual(
        wrong.error?.code,
        'password-incorrect',
        'and a wrong one is a different problem from a missing one — the recovery differs',
      );
      wrongPassword.terminate();

      const rightPassword = new Bot(ctx.url, 'Right Password');
      rightPassword.spacePassword = PASSWORD;
      await rightPassword.connect();
      const right = await rightPassword.tryJoin();
      assert(right.joined !== undefined, 'AC-7.4: and the correct password gets in');
      rightPassword.close();

      await owner.setAccess({ password: null });

      // ── FR-7.13 — allowlist ───────────────────────────────────────────────
      //
      // A fresh account, because the allowlist names identities and the useful
      // property is that an account which is otherwise perfectly valid is still
      // refused.
      const stranger = new Account(base, uniqueEmail('stranger'), 'stranger-passphrase-here');
      await stranger.register('Stranger');

      await owner.setAccess({ allowlistEnabled: true });
      await owner.addToAllowlist(owner.email);

      const notListed = new Bot(ctx.url, 'Stranger');
      notListed.accessToken = stranger.accessToken;
      await notListed.connect();
      const refused = await notListed.tryJoin();
      assertEqual(
        refused.error?.code,
        'not-allowlisted',
        'AC-7.4: a valid account that is not on the list is still refused',
      );
      notListed.terminate();

      // A guest has no address, so an allowlisted space admits nobody
      // anonymously — which is the honest reading of "only specified identities".
      const anonymous = new Bot(ctx.url, 'Anonymous');
      await anonymous.connect();
      const anonymousAttempt = await anonymous.tryJoin();
      assertEqual(
        anonymousAttempt.error?.code,
        'not-allowlisted',
        'FR-7.13: and a guest is not a specified identity',
      );
      anonymous.terminate();

      await owner.addToAllowlist(stranger.email);
      const listed = new Bot(ctx.url, 'Stranger');
      listed.accessToken = stranger.accessToken;
      await listed.connect();
      const admitted = await listed.tryJoin();
      assert(admitted.joined !== undefined, 'FR-7.15: adding them applies to the next entry');
      listed.close();

      await owner.setAccess({ allowlistEnabled: false });
      await owner.removeFromAllowlist(stranger.email);
      await owner.removeFromAllowlist(owner.email);

      // ── FR-7.14 — capacity ────────────────────────────────────────────────
      //
      // Set to one against a world with one person in it, which is the only way
      // to reach the boundary without connecting fifty sockets. `FR-7.14` allows
      // "refuse or route to overflow" and the Phase 7 Rules require that choice
      // to agree with `FR-8.8`; there is one instance until phase 8 builds more,
      // so refusing is what this build can honestly do — and the refusal has to
      // say capacity rather than sounding like a fault.
      const first = new Bot(ctx.url, 'First In');
      await first.connect();
      await first.join();

      await owner.setAccess({ capacity: 1 });

      const overflow = new Bot(ctx.url, 'One Too Many');
      await overflow.connect();
      const full = await overflow.tryJoin();
      assertEqual(full.error?.code, 'world-full', 'AC-7.4: entry beyond capacity is refused');
      assert(
        /full/i.test(full.error?.message ?? ''),
        `and reads as capacity rather than as a fault — got "${full.error?.message}"`,
      );
      overflow.terminate();

      // A reconnect is somebody already counted. Refusing them would evict a
      // participant for a dropped packet, which is the opposite of what a
      // capacity limit is for.
      const resumeToken = first.joined!.resumeToken;
      first.terminate();
      const resuming = new Bot(ctx.url, 'First In');
      await resuming.connect();
      const resumed = await resuming.tryJoin(resumeToken);
      assert(
        resumed.joined !== undefined,
        'FR-7.14: a full space still lets its own participants reconnect',
      );
      resuming.close();
    } finally {
      // Every scenario after this one joins as a guest.
      await owner.setAccess({
        locked: false,
        password: null,
        allowlistEnabled: false,
        capacity: null,
      });
    }

    // Proven rather than assumed — see the file header.
    const afterwards = new Bot(ctx.url, 'Ordinary Guest');
    await afterwards.connect();
    const reopened = await afterwards.tryJoin();
    assert(reopened.joined !== undefined, 'the space was returned to normal afterwards');
    afterwards.close();

    ctx.log('locked, password, allowlist and capacity each refused with their own code');
  },
};
