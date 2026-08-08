/**
 * space-directory — `FR-8.12`, `FR-8.13`, `FR-8.14`, `AC-8.5`.
 *
 * Three things a participant can do with a Space that has more than one Map:
 * see what is in it, walk to a room directly, and go to a person.
 *
 * ── The one that is easy to get wrong ───────────────────────────────────────
 *
 * "Go to a member" (`FR-8.14`). The obvious implementation reads the person's
 * instance id out of the directory and navigates to it, which is wrong in two
 * ways: the directory can be a second stale, and naming an instance bypasses the
 * assignment rules the Phase 8 notes require it to reuse. So the scenario sends
 * a `followSessionId` and asserts on the *instance the server chose*, which is
 * the only thing that proves the resolution happened server-side.
 *
 * ── Counts, and who is allowed to see names ─────────────────────────────────
 *
 * `FR-8.12` says presence is visible "subject to permissions", and the server
 * draws that line at membership: a guest gets rooms and headcounts, a member
 * gets names. Both bots here are guests, so the scenario asserts the counts —
 * which is the half every participant is entitled to — and asserts that the
 * names list is empty, because a guest receiving one would be the disclosure the
 * rule exists to prevent.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const ATRIUM_SLUG = 'atrium';

export const spaceDirectory: Scenario = {
  name: 'space-directory',
  covers: 'FR-8.12/8.13/8.14 — see the maps, walk to one, and go to a person',

  async run(ctx) {
    const scout = new Bot(ctx.url, 'directory-scout');
    const wanderer = new Bot(ctx.url, 'directory-wanderer');

    try {
      await Promise.all([scout.connect(), wanderer.connect()]);
      const [scoutJoin, wandererJoin] = await Promise.all([scout.join(), wanderer.join()]);

      // `FR-8.12` — the directory arrives inside the handshake, without being
      // asked for. A client that had to poll would show an empty map panel for
      // its first second.
      await waitUntil(() => scout.directory !== null, 3000, 'the directory to arrive unprompted');
      const directory = scout.directory!;

      assert(
        directory.maps.length >= 2,
        `the directory lists ${directory.maps.length} map(s); this scenario needs the two ` +
          `starter maps. Run "node assets/world/build-world.mjs" and restart the api.`,
      );
      assertEqual(
        directory.hereMapId,
        scoutJoin.mapId,
        'the directory disagrees with JOINED about which map the viewer is in',
      );

      const atrium = directory.maps.find((map) => map.slug === ATRIUM_SLUG);
      assert(atrium !== undefined, `no "${ATRIUM_SLUG}" map in the directory`);

      // Guests: counts yes, names no.
      assertEqual(
        directory.people.length,
        0,
        'a guest was sent a list of who is where — FR-8.12 is "subject to permissions"',
      );

      const hereBefore = directory.maps.find((map) => map.mapId === directory.hereMapId)!;
      assert(
        hereBefore.occupancy >= 2,
        `the landing map reports ${hereBefore.occupancy} people with two bots standing in it`,
      );

      // ── FR-8.13 — walk to a named room, no portal involved ────────────────
      wanderer.navigate({ mapId: atrium.mapId });
      await waitUntil(() => wanderer.transfers.length > 0, 5000, 'direct navigation to the atrium');
      assertEqual(
        wanderer.transfers[0]!.mapSlug,
        ATRIUM_SLUG,
        'NAVIGATE landed somewhere other than the map it named',
      );
      assertEqual(
        wanderer.transfers[0]!.reason,
        'navigate',
        'a direct navigation was reported as something else',
      );

      // The counts follow, on the next push rather than on request. That is the
      // requirement — the directory is a live view, not a snapshot somebody has
      // to refresh.
      await waitUntil(
        () => (scout.directory?.maps.find((map) => map.slug === ATRIUM_SLUG)?.occupancy ?? 0) >= 1,
        4000,
        'the directory to show somebody in the atrium',
      );

      // ── FR-8.14 — go to a person ──────────────────────────────────────────
      //
      // By session id, never by the instance id the directory happens to hold:
      // resolving it here would bypass the assignment rules and would go stale
      // the moment the person moved.
      scout.navigate({ followSessionId: wandererJoin.sessionId });
      await waitUntil(() => scout.transfers.length > 0, 5000, 'the scout to follow the wanderer');

      const followed = scout.transfers.at(-1)!;
      assertEqual(followed.reason, 'follow', 'following somebody was reported as something else');
      assertEqual(
        followed.instanceId,
        wanderer.transfers.at(-1)!.instanceId,
        'following somebody landed in a different copy of the room than the one they are in',
      );

      // And now they can hear each other, which is the point of having gone.
      scout.chatSend('room', 'found you');
      assert(
        await wanderer.waitForChat('found you', 3000),
        'the follower landed in the same instance but the two cannot reach each other',
      );

      ctx.log(
        `${directory.maps.length} maps · direct navigation and follow both landed in ` +
          `${followed.instanceId} · guests got counts and no names`,
      );

      void scoutJoin;
    } finally {
      scout.close();
      wanderer.close();
      await sleep(150);
    }
  },
};
