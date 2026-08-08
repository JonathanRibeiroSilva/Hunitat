/**
 * `AC-6.2` — a guest becomes an account and keeps their name and avatar.
 *
 * The requirement most easily satisfied *wrongly*. Registering, then reloading
 * the page, then signing in would produce the same end state and would fail the
 * Rule this scenario actually protects:
 *
 *   > Guest-to-account upgrade must not lose the user's place/state mid-session
 *   > where avoidable.
 *
 * So the assertion is not "the account has the right name". It is that the
 * **same socket** — never closed, never rejoined — receives an `IDENTITY` frame
 * saying it is now an account, and that the session id on the far side of the
 * upgrade is the one it had before. A reconnect would change it.
 *
 * A second bot watches, because `FR-6.13` says the system distinguishes members
 * from guests: an observer who goes on labelling somebody a guest after they
 * have signed up is showing something that is no longer true.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, assertEquivalent, type Scenario } from '../runner.js';

export const guestUpgrade: Scenario = {
  name: 'guest-upgrade',
  covers: 'AC-6.2, FR-6.7, FR-6.13 — a guest upgrades in place, keeping name, avatar and socket',

  async run(ctx) {
    const { base } = await requireAccounts(ctx.url);

    // A guest with a name they chose and an avatar they picked.
    const chosenAppearance = {
      baseModel: 'standard' as const,
      colors: { skin: 2, hair: 3, top: 1, bottom: 2 },
      accessories: [],
    };

    const guest = new Bot(ctx.url, 'Bea the Guest');
    await guest.connect();
    const joined = await guest.join(undefined, chosenAppearance);

    assertEqual(joined.identity.kind, 'guest', 'FR-6.6: entering without a token is a guest');
    assertEqual(joined.identity.member, false, 'a guest belongs to nothing');
    const sessionBefore = joined.sessionId;
    const localIdBefore = joined.localId;
    const wornBefore = joined.appearance;

    // Somebody standing nearby who will watch the change happen.
    const observer = new Bot(ctx.url, 'Observer');
    await observer.connect();
    await observer.join();
    observer.moveTo(joined.spawn.x + 1, joined.spawn.z + 1);
    guest.moveTo(joined.spawn.x, joined.spawn.z);
    await sleep(400);

    await waitUntil(
      () => observer.remotes.has(localIdBefore),
      3000,
      'the observer to see the guest',
    );
    assertEqual(
      observer.remotes.get(localIdBefore)?.identity.kind,
      'guest',
      'FR-6.13: the observer sees a guest, before the upgrade',
    );

    // ── The upgrade. HTTP, alongside a live socket that is never touched ─────
    const account = new Account(base, uniqueEmail('bea'), 'a-perfectly-good-passphrase');
    await account.upgrade(joined.resumeToken);
    ctx.log(`upgraded ${account.email} using the resume token, socket left open`);

    await waitUntil(() => guest.identities.length > 0, 4000, 'the IDENTITY frame');
    const identity = guest.identities[0]!;

    assertEqual(identity.kind, 'account', 'FR-6.7: the live session is now an account');
    assertEqual(identity.accountId, account.dto.id, 'and it names the account just created');
    assertEqual(
      identity.displayName,
      'Bea the Guest',
      'AC-6.2: the name the guest chose is carried over, not replaced by the email',
    );
    assertEquivalent(identity.appearance, wornBefore, 'AC-6.2: and so is the avatar they picked');

    // The point of the whole scenario: nothing reconnected.
    assertEqual(
      guest.joined?.sessionId,
      sessionBefore,
      'Rules: the upgrade must not lose the user’s place — the session id is unchanged',
    );
    assert(
      guest.events.errors.length === 0,
      `the socket carried on without error, got ${JSON.stringify(guest.events.errors)}`,
    );

    // FR-6.13, from the outside.
    await waitUntil(
      () => observer.remotes.get(localIdBefore)?.identity.kind === 'account',
      4000,
      'the observer to be told the guest is now an account',
    );
    assertEqual(
      observer.remotes.get(localIdBefore)?.localId,
      localIdBefore,
      'and they are the same participant, not a new one',
    );

    // FR-6.9 — the profile really was created from the session, not from a default.
    const profile = await account.me();
    assertEqual(
      profile.displayName,
      'Bea the Guest',
      'FR-6.9: the profile stored the carried name',
    );
    assertEquivalent(
      profile.appearance,
      wornBefore,
      'FR-6.9: and the carried appearance, in profiles.avatar_appearance',
    );

    ctx.log(`session ${sessionBefore.slice(0, 8)}… survived the upgrade intact`);
    guest.close();
    observer.close();
  },
};
