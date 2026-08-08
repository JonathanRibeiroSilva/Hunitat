/**
 * map-instancing — `FR-8.8`, `FR-8.9`, `FR-8.10`, `AC-8.3`, `AC-8.4`.
 *
 * A Map at capacity spills into a second instance, and the two copies of the
 * room cannot see or hear each other.
 *
 * ── Why this scenario needs an account ──────────────────────────────────────
 *
 * Capacity is a property of the Map, and changing one needs `manage-maps`
 * (`FR-8.16`). Nothing on the socket can do it, deliberately: a client that could
 * set its own room's capacity could defeat every limit in the phase. So this runs
 * the same way the phase 7 scenarios do — a signed-in admin over HTTP — and skips
 * loudly on a server with no database rather than passing quietly.
 *
 * ── The two halves of `FR-8.10`, and both are asserted ──────────────────────
 *
 * **Structural.** Two bots in different instances must not appear in each
 * other's roster, and a room message from one must not reach the other. Chat is
 * the one worth asserting rather than assuming: a leak there is *retained*, so
 * it outlives the session it happened in.
 *
 * **Explained.** The requirement says the separation is "made understandable to
 * users", so the spilled participant is told: `MAP_TRANSFER.notice` has to arrive
 * with something in it, and the instance carries a label the interface can show.
 * A silent split is the failure mode this half exists to prevent.
 *
 * ── Restoring what it changed ───────────────────────────────────────────────
 *
 * Capacity is put back in a `finally` and the extra instance is left to be reaped
 * on its own (`FR-8.11`, two minutes). Every other scenario joins the landing map
 * rather than the atrium, so an idle second copy of a room nobody is in does not
 * disturb them.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { Account, requireAccounts, SkipScenario, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const ATRIUM_SLUG = 'atrium';

export const mapInstancing: Scenario = {
  name: 'map-instancing',
  covers: 'FR-8.8/8.9/8.10 — a full map spills into a second copy, and the two are isolated',

  async run(ctx) {
    const { base, member } = await requireAccounts(ctx.url);

    // An admin, promoted by the owner. `requireAccounts` establishes the shared
    // member; the founding account of the Space is its owner and is the only
    // one that can hand out a role (`FR-7.3`).
    const admin = await promoteAdmin(base, member);

    const overview = await admin.spaceOverview();
    const atrium = overview.maps.find((map) => map.slug === ATRIUM_SLUG);
    if (!atrium) {
      throw new SkipScenario(
        `this space has no "${ATRIUM_SLUG}" map, so there is nothing to fill. Run ` +
          `"node assets/world/build-world.mjs" and restart the api.`,
      );
    }

    const first = new Bot(ctx.url, 'instance-first');
    const second = new Bot(ctx.url, 'instance-second');
    const spilled = new Bot(ctx.url, 'instance-spilled');
    const restore = atrium.capacity;

    try {
      // `FR-8.8` — two per copy. The smallest number that is still a room: one
      // would make every arrival a spill and prove nothing about filling first.
      await admin.updateMap(atrium.id, { capacity: 2, overflow: 'instance' });

      await Promise.all([first.connect(), second.connect(), spilled.connect()]);
      await Promise.all([first.join(), second.join(), spilled.join()]);

      // Two fill the first copy. `fill-then-spill` is the default policy, so both
      // must land in the same instance — a balancer would put them in two and
      // this assertion is what tells the two policies apart.
      first.navigate({ mapId: atrium.id });
      await waitUntil(() => first.transfers.length > 0, 5000, 'the first bot to reach the atrium');
      second.navigate({ mapId: atrium.id });
      await waitUntil(
        () => second.transfers.length > 0,
        5000,
        'the second bot to reach the atrium',
      );

      const instanceA = first.transfers.at(-1)!.instanceId;
      assertEqual(
        second.transfers.at(-1)!.instanceId,
        instanceA,
        'fill-then-spill put two arrivals in different copies of a room with room for both ' +
          '(FR-8.9 — splitting colleagues is the failure users notice most)',
      );

      // The third arrives at a full room. `AC-8.3` allows either outcome; this
      // Map is configured to instance, so it must.
      spilled.navigate({ mapId: atrium.id });
      await waitUntil(() => spilled.transfers.length > 0, 5000, 'the third bot to be placed');

      const spill = spilled.transfers.at(-1)!;
      assert(
        spill.instanceId !== instanceA,
        `the third arrival went into the full copy — capacity ${2} was not applied (FR-8.8)`,
      );
      assert(
        spill.instanceCount >= 2,
        'a second instance was used but the transfer reports only one running',
      );

      // `FR-8.10`'s "made understandable" half. Not decoration: a person who
      // cannot see their colleagues and was told nothing concludes the product is
      // broken.
      assert(
        typeof spill.notice === 'string' && spill.notice.length > 0,
        'somebody was put in a separate copy of a room and told nothing (FR-8.10)',
      );
      assert(
        spill.instanceLabel.length > 0 && spill.instanceLabel !== spill.mapName,
        `the spilled instance is labelled "${spill.instanceLabel}", which is indistinguishable ` +
          `from the room itself`,
      );

      // ── The isolation itself ───────────────────────────────────────────────
      await sleep(400);

      assertEqual(
        first.remoteBySession(spilled.joined!.sessionId),
        undefined,
        'somebody in another copy of the room is visible in the presence list (FR-8.10)',
      );
      assertEqual(
        spilled.remoteBySession(first.joined!.sessionId),
        undefined,
        'the isolation is one-way — the spilled participant can see the original copy',
      );

      spilled.chatSend('room', 'anybody there');
      assert(
        !(await first.waitForChat('anybody there', 2000)),
        'a room message crossed between two copies of the same map (FR-8.10), and room ' +
          'history is retained — so the leak outlives the session',
      );

      // …while the two in the *same* copy still reach each other, which is what
      // makes the assertion above about isolation rather than about chat being
      // broken.
      first.chatSend('room', 'we are together');
      assert(
        await second.waitForChat('we are together', 3000),
        'two participants in the same copy of a room cannot hear each other',
      );

      ctx.log(
        `capacity 2 · two filled ${instanceA}, the third went to ${spill.instanceId} ` +
          `("${spill.instanceLabel}") · no presence and no chat crossed`,
      );
    } finally {
      first.close();
      second.close();
      spilled.close();
      await admin
        .updateMap(atrium.id, { capacity: restore })
        .catch(() => ctx.log('warning: could not restore the atrium capacity'));
      await sleep(150);
    }
  },
};

/**
 * An admin to act with.
 *
 * The shared member is a member; `FR-8.16` needs `manage-maps`, which is
 * admin-level. The owner of the Space is the founding account, which on a
 * harness database is the shared member itself — so it promotes a fresh account
 * and uses that, rather than relying on which of the two it happens to be.
 */
async function promoteAdmin(base: string, member: Account): Promise<Account> {
  const overview = await member.moderation();
  if (!overview.capabilities.includes('manage-roles')) {
    throw new SkipScenario(
      'the shared harness account does not own this space, so it cannot appoint an admin. ' +
        'Reset the database: docker compose down -v && docker compose up -d postgres',
    );
  }

  const admin = new Account(base, uniqueEmail('maps-admin'), 'harness-maps-admin-1234');
  await admin.register('Maps Admin');

  // A role needs a membership to sit on (`DC-6.4`), and an invite is how one is
  // created (`FR-6.13`).
  const invite = await member.createInvite({ maxUses: 1 });
  await admin.tryRedeem(invite.code);
  await member.setRole(admin.dto.id, 'admin');
  // The role is resolved per request from `memberships`, so the next call
  // already carries it — no re-sign-in needed (`FR-7.3`).
  return admin;
}
