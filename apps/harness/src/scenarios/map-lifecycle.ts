/**
 * map-lifecycle — `FR-8.15`, `FR-8.16`, `FR-8.17`, `FR-8.18`, `AC-8.6`.
 *
 * Creating, archiving and deleting a Map, with the two things `AC-8.6` actually
 * asks about: that permissions and confirmation are enforced, and that the
 * people standing in a room being retired are moved out gracefully rather than
 * left in an instance of something that no longer exists.
 *
 * ── The order is the argument ───────────────────────────────────────────────
 *
 *   1. **A member cannot.** `manage-maps` is admin-level, and the refusal is
 *      asserted before anything is created — a scenario that only proved the
 *      admin path would pass on a server with no authorization at all.
 *   2. **Create**, and see it appear in the directory of somebody already in the
 *      world. `FR-8.15` is not much use if the room is invisible until a reload.
 *   3. **Archive with somebody inside**, and watch them arrive on the landing
 *      Map carrying a notice. This is `FR-8.18`, and it is the requirement most
 *      likely to be implemented as "disconnect them".
 *   4. **Delete without the confirmation**, and be refused. `FR-8.17` asks for
 *      "appropriate confirmation"; a boolean would be one mis-click, so the
 *      server wants the Map's own slug typed back.
 *   5. **Delete with it**, and see it gone.
 *
 * Every step is on a Map this scenario created, so a failure part-way through
 * leaves the starter maps untouched.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { Account, requireAccounts, SkipScenario, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const mapLifecycle: Scenario = {
  name: 'map-lifecycle',
  covers: 'FR-8.15/8.17/8.18 — create, archive and delete a map, and move people out of it',

  async run(ctx) {
    const { base, member } = await requireAccounts(ctx.url);

    const overview = await member.moderation();
    if (!overview.capabilities.includes('manage-roles')) {
      throw new SkipScenario(
        'the shared harness account does not own this space, so it cannot appoint an admin. ' +
          'Reset the database: docker compose down -v && docker compose up -d postgres',
      );
    }

    const admin = new Account(base, uniqueEmail('lifecycle-admin'), 'harness-lifecycle-1234');
    await admin.register('Lifecycle Admin');
    const invite = await member.createInvite({ maxUses: 1 });
    await admin.tryRedeem(invite.code);
    await member.setRole(admin.dto.id, 'admin');

    // An ordinary member, for step 1. Freshly made rather than reusing the
    // shared one, which owns the Space and can do everything.
    const ordinary = new Account(base, uniqueEmail('lifecycle-member'), 'harness-lifecycle-1234');
    await ordinary.register('Lifecycle Member');
    const secondInvite = await member.createInvite({ maxUses: 1 });
    await ordinary.tryRedeem(secondInvite.code);

    const slug = `harness-${Date.now().toString(36)}`;
    const occupant = new Bot(ctx.url, 'lifecycle-occupant');
    const watcher = new Bot(ctx.url, 'lifecycle-watcher');
    let created: { id: string; slug: string } | null = null;

    try {
      // ── 1. A member cannot ────────────────────────────────────────────────
      const refused = await ordinary.tryCall('POST', '/spaces/default/maps', {
        slug: `${slug}-refused`,
        name: 'Should Not Exist',
      });
      assertEqual(
        refused.status,
        403,
        `an ordinary member creating a map was answered ${refused.status}; FR-8.15 is ` +
          `admin-level and NFR-34 requires the HTTP path to enforce it`,
      );

      // ── 2. Create ─────────────────────────────────────────────────────────
      await Promise.all([occupant.connect(), watcher.connect()]);
      await Promise.all([occupant.join(), watcher.join()]);
      await waitUntil(() => watcher.directory !== null, 3000, 'the directory');

      const map = await admin.createMap({ slug, name: 'Harness Room' });
      created = { id: map.id, slug: map.slug };
      assertEqual(map.slug, slug, 'the created map came back under a different slug');

      // Live, to somebody already standing in the world. The directory is pushed
      // on change, so this needs no reload and no request.
      await waitUntil(
        () => watcher.directory?.maps.some((entry) => entry.slug === slug) === true,
        5000,
        'the new map to appear in the directory of somebody already in the world',
      );

      // ── 3. Archive with somebody inside (FR-8.18) ─────────────────────────
      occupant.navigate({ mapId: map.id });
      await waitUntil(() => occupant.transfers.length > 0, 5000, 'the occupant to reach the room');
      assertEqual(occupant.transfers.at(-1)!.mapSlug, slug, 'the occupant went somewhere else');

      const transfersBefore = occupant.transfers.length;
      await admin.updateMap(map.id, { archived: true });

      await waitUntil(
        () => occupant.transfers.length > transfersBefore,
        6000,
        'the occupant of an archived room to be moved out (FR-8.18)',
      );

      const evacuation = occupant.transfers.at(-1)!;
      assert(
        evacuation.mapSlug !== slug,
        'the occupant was left standing in the room that was archived',
      );
      assertEqual(
        evacuation.reason,
        'archived',
        `the move was reported as "${evacuation.reason}" rather than as the archiving that ` +
          `caused it`,
      );
      assert(
        typeof evacuation.notice === 'string' && evacuation.notice.length > 0,
        'somebody was moved out of a room and told nothing (FR-8.18 — "notified and moved ' +
          'out, not left in a broken instance")',
      );
      // Not disconnected. The distinction matters: an archived room is a
      // decision about a room, and answering it by throwing people out of the
      // building would be a far larger consequence than the decision.
      assertEqual(
        occupant.events.errors.filter((error) => error.code === 'banned').length,
        0,
        'archiving a room disconnected the people in it',
      );

      // ── 4. Delete without the confirmation ────────────────────────────────
      const unconfirmed = await admin.tryCall('DELETE', `/spaces/default/maps/${map.id}`, {
        confirm: 'yes',
      });
      assertEqual(
        unconfirmed.status,
        400,
        `deleting a map with the wrong confirmation was answered ${unconfirmed.status}; ` +
          `FR-8.17 asks for appropriate confirmation`,
      );

      // ── 5. Delete with it ─────────────────────────────────────────────────
      const deleted = await admin.deleteMap(map.id, slug);
      assertEqual(deleted.deleted, slug, 'the delete reported a different map');
      created = null;

      await waitUntil(
        () => watcher.directory?.maps.some((entry) => entry.slug === slug) === false,
        5000,
        'the deleted map to leave the directory',
      );

      ctx.log(
        `member refused (403) · created "${slug}" · archived it and moved 1 person out with a ` +
          `notice · delete refused without the typed name, then accepted`,
      );
    } finally {
      occupant.close();
      watcher.close();
      // A failure part-way through leaves a map behind; take it with us so the
      // next run starts from the catalogue it expects.
      if (created) {
        await admin
          .deleteMap(created.id, created.slug)
          .catch(() => ctx.log(`warning: could not clean up the "${created?.slug}" map`));
      }
      await sleep(150);
    }
  },
};
