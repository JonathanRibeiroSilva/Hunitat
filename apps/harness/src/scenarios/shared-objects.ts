/**
 * shared-objects — `FR-10.11`–`FR-10.14`, `FR-10.16`, `AC-10.3`–`AC-10.6`.
 *
 * Two people on one whiteboard, a third arriving late, and whether any of it is
 * still there tomorrow.
 *
 * ── Why each assertion is here ──────────────────────────────────────────────
 *
 *   **`AC-10.3`** — two clients draw and both end with both strokes. The
 *   requirement is convergence, so the assertion is on *both* documents rather
 *   than on one of them receiving a message.
 *
 *   **`AC-10.4`** — a third client connects after the fact and finds the strokes
 *   already there. This is the one that a naive relay implementation fails
 *   silently: relaying updates to whoever is connected works perfectly until
 *   somebody arrives late, at which point they see an empty board and nothing
 *   anywhere errors.
 *
 *   **`AC-10.5`** — everybody disconnects, the server flushes, and a fresh
 *   client finds the board intact. The flush is debounced, so the scenario waits
 *   for it rather than assuming.
 *
 *   **`FR-10.14`** — a bot standing across the room is refused. Proximity is an
 *   access control here, not a hint: the prompt is client-side and could be
 *   skipped by anybody who wanted to.
 *
 *   **`AC-10.6`** — the content type is a closed enum, and a document naming one
 *   outside it is refused at publish. That is the deferred-framework boundary
 *   expressed as something a test can observe.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { CollabClient } from '../collab.js';
import { Account, requireAccounts, SkipScenario, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';
import type { EditorStateDto, MapDocument } from '@hubitat/protocol';
import { YJS_KEYS } from '@hubitat/protocol';

/** Where the board stands, and where the bots stand to use it. */
const BOARD = { x: 0, y: 0, z: 0 };
const NEARBY = { x: 1, z: 1 };
const FAR = { x: 9, z: 9 };

export const sharedObjects: Scenario = {
  name: 'shared-objects',
  covers: 'FR-10.11–10.14/10.16 — a shared board converges, admits late joiners, and is kept',

  async run(ctx) {
    const { base, member } = await requireAccounts(ctx.url);

    const overview = await member.moderation();
    if (!overview.capabilities.includes('manage-roles')) {
      throw new SkipScenario(
        'the shared harness account does not own this space, so it cannot appoint an admin. ' +
          'Reset the database: docker compose down -v && docker compose up -d postgres',
      );
    }

    const admin = new Account(base, uniqueEmail('objects-admin'), 'harness-objects-1234');
    await admin.register('Objects Admin');
    await admin.tryRedeem((await member.createInvite({ maxUses: 1 })).code);
    await member.setRole(admin.dto.id, 'admin');

    const slug = `board-room-${Date.now().toString(36)}`;
    const ana = new Bot(ctx.url, 'board-ana');
    const bea = new Bot(ctx.url, 'board-bea');
    const cass = new Bot(ctx.url, 'board-cass');
    let mapId: string | null = null;
    const clients: CollabClient[] = [];

    try {
      const created = await admin.createMap({ slug, name: 'Board Room' });
      mapId = created.id;

      const opened = (await admin.tryJson(
        'POST',
        `/spaces/default/editor/maps/${mapId}/lock`,
      )) as EditorStateDto;

      const board = opened.assets.find((asset) => asset.slug === 'whiteboard') ?? opened.assets[0];
      assert(board !== undefined, 'the built-in asset library is empty (FR-9.15)');

      // A shared, persisted whiteboard at the origin.
      const withBoard: MapDocument = {
        ...opened.draft,
        objects: [
          {
            id: 'board',
            assetId: board.slug,
            transform: {
              position: BOARD,
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
            interactive: {
              contentType: 'note',
              content: { surface: 'whiteboard' },
              shared: true,
              // `FR-10.16` — this is the half `AC-10.5` is about.
              persistShared: true,
            },
          },
        ],
      };

      await admin.tryJson('PUT', `/spaces/default/editor/maps/${mapId}/draft`, {
        document: withBoard,
        revision: opened.revision,
      });
      const published = (await admin.tryJson(
        'POST',
        `/spaces/default/editor/maps/${mapId}/publish`,
        {},
      )) as EditorStateDto | null;
      assert(published !== null, 'publishing the board room failed');

      // ── AC-10.6 — the closed enum, enforced ───────────────────────────────
      const bogus = await admin.tryCall('PUT', `/spaces/default/editor/maps/${mapId}/draft`, {
        document: {
          ...withBoard,
          objects: [
            {
              ...withBoard.objects[0],
              interactive: {
                // Not one of the five. There is no "app" type and no way to add
                // one without a schema bump — which is exactly what `AC-10.6`
                // asks to be confirmed.
                contentType: 'app',
                content: { url: 'https://example.com/app' },
                shared: false,
                persistShared: false,
              },
            },
          ],
        },
        revision: published.revision,
      });
      assert(
        bogus.status === 400 || bogus.status === 409,
        `a content type outside the built-in set was accepted (${bogus.status}) — AC-10.6 asks ` +
          `for confirmation that no generic app hosting exists`,
      );

      // ── Two people on one board (AC-10.3) ─────────────────────────────────
      await Promise.all([ana.connect(), bea.connect(), cass.connect()]);
      await Promise.all([ana.join(), bea.join(), cass.join()]);

      for (const bot of [ana, bea, cass]) {
        bot.navigate({ mapId });
      }
      await waitUntil(
        () => ana.transfers.length > 0 && bea.transfers.length > 0 && cass.transfers.length > 0,
        6000,
        'everybody to reach the board room',
      );

      ana.moveTo(NEARBY.x, NEARBY.z);
      bea.moveTo(-NEARBY.x, -NEARBY.z);
      // `FR-10.14` — well outside the interaction range.
      cass.moveTo(FAR.x, FAR.z);
      await sleep(300);

      const anaBoard = new CollabClient(ctx.url, mapId, 'board', ana.joined!.resumeToken);
      clients.push(anaBoard);
      await anaBoard.ready;

      const beaBoard = new CollabClient(ctx.url, mapId, 'board', bea.joined!.resumeToken);
      clients.push(beaBoard);
      await beaBoard.ready;

      anaBoard.transact(() =>
        anaBoard.doc
          .getArray(YJS_KEYS.strokes)
          .push([{ color: '#fff', width: 3, points: [0, 0, 1, 1] }]),
      );
      beaBoard.transact(() =>
        beaBoard.doc
          .getArray(YJS_KEYS.strokes)
          .push([{ color: '#f00', width: 5, points: [1, 0, 0, 1] }]),
      );

      // Convergence: *both* documents hold *both* strokes. Asserting on one
      // would pass for a relay that only forwards in one direction.
      await waitUntil(
        () =>
          anaBoard.doc.getArray(YJS_KEYS.strokes).length === 2 &&
          beaBoard.doc.getArray(YJS_KEYS.strokes).length === 2,
        4000,
        'both boards to converge on both strokes (AC-10.3)',
      );

      // ── FR-10.14 — proximity is an access control ─────────────────────────
      const farBoard = new CollabClient(ctx.url, mapId, 'board', cass.joined!.resumeToken);
      clients.push(farBoard);
      let refused = false;
      await farBoard.ready.catch(() => {
        refused = true;
      });
      assert(
        refused,
        'somebody across the room was allowed onto the board — FR-10.14 scopes shared updates ' +
          'to participants who are actually there, and the prompt is client-side',
      );

      // ── AC-10.4 — a late joiner sees the current state ────────────────────
      cass.moveTo(NEARBY.x, -NEARBY.z);
      await sleep(300);
      const lateBoard = new CollabClient(ctx.url, mapId, 'board', cass.joined!.resumeToken);
      clients.push(lateBoard);
      await lateBoard.ready;

      await waitUntil(
        () => lateBoard.doc.getArray(YJS_KEYS.strokes).length === 2,
        4000,
        'a late joiner to receive the strokes already on the board (AC-10.4)',
      );

      // ── AC-10.5 — still there after everybody leaves ──────────────────────
      for (const client of clients) client.close();
      clients.length = 0;
      // The flush happens when the last socket closes, and the write is a round
      // trip to Postgres. A second is generous.
      await sleep(1200);

      const returning = new CollabClient(ctx.url, mapId, 'board', ana.joined!.resumeToken);
      clients.push(returning);
      await returning.ready;
      await waitUntil(
        () => returning.doc.getArray(YJS_KEYS.strokes).length === 2,
        4000,
        'the board to still hold both strokes after everybody left (AC-10.5)',
      );

      assertEqual(
        returning.doc.getArray(YJS_KEYS.strokes).length,
        2,
        'persisted shared state came back incomplete',
      );

      ctx.log(
        'two clients converged on two strokes · somebody out of range was refused · a late ' +
          'joiner saw both · both survived everybody leaving',
      );
    } finally {
      for (const client of clients) client.close();
      ana.close();
      bea.close();
      cass.close();
      if (mapId) {
        await admin
          .deleteMap(mapId, slug)
          .catch(() => ctx.log(`warning: could not clean up the "${slug}" map`));
      }
      await sleep(150);
    }
  },
};
