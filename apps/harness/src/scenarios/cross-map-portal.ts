/**
 * cross-map-portal — `FR-8.5`, `FR-8.6`, `FR-8.7`, `AC-8.1`, `AC-8.2`.
 *
 * The phase's headline: walk through a portal and be in a different Map, with
 * presence re-established at the far side.
 *
 * ── What is actually worth asserting ────────────────────────────────────────
 *
 * Not "did the position change" — phase 3 already covers that for a same-map
 * portal. The four things this proves are the four that move together in
 * `WorldInstanceService.transfer`, and a partial failure of any one of them
 * leaves a participant present in two places or in none:
 *
 *   1. `MAP_TRANSFER` names the destination Map and a spawn inside it, so the
 *      client has a world to load rather than a position in the old one.
 *   2. Somebody standing in the destination **sees them arrive**, which is
 *      `FR-8.6`'s "presence re-established at the destination".
 *   3. Somebody standing in the *origin* **sees them leave**. This is the half
 *      that silently fails: a transfer that adds without removing leaves a ghost
 *      in the map behind.
 *   4. Nothing crosses afterwards. A room message sent in the destination must
 *      not reach the origin, which is `FR-8.10` for the Maps case and is the
 *      only isolation failure that would be *retained* rather than merely heard.
 *
 * `AC-8.2` rides along at the top: both bots enter the Space with no destination
 * named and land on the Space's default Map, which is what `FR-8.7` asks for.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

/** `portal-to-atrium`: a cylinder at (-11.4, 5) in the office, radius 0.9. */
const PORTAL = { x: -11.4, z: 5 };
/** The office spawn the atrium's own portal comes back to. */
const OFFICE_SLUG = 'office';
const ATRIUM_SLUG = 'atrium';

export const crossMapPortal: Scenario = {
  name: 'cross-map-portal',
  covers: 'FR-8.5/8.6/8.7 — a portal moves you to another map, presence and all',

  async run(ctx) {
    const traveller = new Bot(ctx.url, 'portal-traveller-8');
    const stayer = new Bot(ctx.url, 'office-stayer');
    const greeter = new Bot(ctx.url, 'atrium-greeter');

    try {
      await Promise.all([traveller.connect(), stayer.connect(), greeter.connect()]);
      const [travellerJoin, , greeterJoin] = await Promise.all([
        traveller.join(),
        stayer.join(),
        greeter.join(),
      ]);

      // `AC-8.2` / `FR-8.7` — nobody named a destination, and everybody landed on
      // the Space's default Map at a real spawn.
      traveller.requestDirectory();
      await waitUntil(() => traveller.directory !== null, 3000, 'the space directory');
      const directory = traveller.directory!;
      const landing = directory.maps.find((map) => map.mapId === directory.defaultMapId);
      assert(landing !== undefined, 'the space directory names no landing map (FR-8.7)');
      assertEqual(
        travellerJoin.mapId,
        landing.mapId,
        'a fresh arrival did not land on the default map (FR-8.7, AC-8.2)',
      );

      const office = directory.maps.find((map) => map.slug === OFFICE_SLUG);
      const atrium = directory.maps.find((map) => map.slug === ATRIUM_SLUG);
      assert(
        office !== undefined && atrium !== undefined,
        `this space has no "${OFFICE_SLUG}" and "${ATRIUM_SLUG}" maps, so there is no ` +
          `cross-map portal to walk through. Run "node assets/world/build-world.mjs" and ` +
          `restart the api.`,
      );

      // Put the greeter in the atrium first, so there is somebody at the far end
      // to observe the arrival rather than an empty room.
      greeter.navigate({ mapId: atrium.mapId });
      await waitUntil(() => greeter.transfers.length > 0, 5000, 'the greeter to reach the atrium');
      assertEqual(
        greeter.transfers[0]!.mapSlug,
        ATRIUM_SLUG,
        'NAVIGATE went somewhere other than the map it named (FR-8.13)',
      );

      // Everybody settles where they are. The stayer stands well clear of the
      // portal so it is not their own transfer being observed.
      traveller.moveTo(0, 0);
      stayer.moveTo(2, 0);
      await sleep(300);
      traveller.resetEvents();
      stayer.resetEvents();
      greeter.resetEvents();

      // ── The walk ───────────────────────────────────────────────────────────
      traveller.moveTo(PORTAL.x, PORTAL.z);
      await waitUntil(() => traveller.transfers.length > 0, 5000, 'the cross-map portal to fire');

      const transfer = traveller.transfers[0]!;
      assertEqual(transfer.reason, 'portal', 'the move happened, but not through a portal');
      assertEqual(
        transfer.mapSlug,
        ATRIUM_SLUG,
        `the portal led to "${transfer.mapSlug}" rather than "${ATRIUM_SLUG}"`,
      );
      assert(
        transfer.mapUrl.length > 0 && transfer.mapDocumentUrl.length > 0,
        'MAP_TRANSFER carried no world for the client to load',
      );
      assert(
        transfer.instanceId.startsWith(atrium.mapId),
        `the destination instance ${transfer.instanceId} does not belong to the atrium`,
      );

      // 2 — presence re-established at the destination (`FR-8.6`).
      await waitUntil(
        () => greeter.remoteBySession(travellerJoin.sessionId) !== undefined,
        5000,
        'the traveller to appear to somebody standing in the atrium',
      );

      // 3 — and gone from the origin. The half that fails silently.
      await waitUntil(
        () => stayer.remoteBySession(travellerJoin.sessionId) === undefined,
        5000,
        'the traveller to disappear from the map they left',
      );

      // 4 — the room channel does not cross a door (`FR-8.10`, `FR-5.1`).
      traveller.chatSend('room', 'hello from the atrium');
      assert(
        await greeter.waitForChat('hello from the atrium', 3000),
        'a room message did not reach somebody in the same map',
      );
      assert(
        !stayer.received('hello from the atrium'),
        'a room message crossed into another map — instances are not isolated (FR-8.10)',
      );

      // The re-trigger rule, one phase on: arriving in the atrium must not put
      // the traveller on top of the portal back to the office.
      await sleep(2200);
      assertEqual(
        traveller.transfers.length,
        1,
        `the traveller moved ${traveller.transfers.length} times — the arrival spawn is not ` +
          `clear of the return portal (FR-3.16)`,
      );

      assert(
        traveller.events.errors.length === 0,
        `unexpected error frames: ${traveller.events.errors.map((e) => e.code).join(', ')}`,
      );

      ctx.log(
        `${OFFICE_SLUG} → ${transfer.mapSlug} · seen arriving by the greeter, gone from the ` +
          `office, room chat did not cross`,
      );

      // Left where they started, so the next scenario inherits a Space that
      // looks like the one it expects.
      void greeterJoin;
    } finally {
      traveller.close();
      stayer.close();
      greeter.close();
      await sleep(150);
    }
  },
};
