/**
 * map-editing — `FR-9.4`, `FR-9.17`–`FR-9.22`, `AC-9.5`, `AC-9.6`.
 *
 * The half of the editor that is not a user interface: drafts that do not touch
 * the live map, publishing that does, versions that can be returned to, and the
 * two mechanisms that stop two authors destroying each other's afternoon.
 *
 * ── What makes this worth a scenario ────────────────────────────────────────
 *
 * Every one of these is a claim about something *not* happening, and none of
 * them is visible from the editor:
 *
 *   **A draft is invisible to participants** (`FR-9.4`). A bot in the map fetches
 *   the published document after a draft is saved and finds it unchanged. This is
 *   the requirement most likely to be met by accident and lost by refactor.
 *
 *   **Publishing is not a hard break** (`FR-9.20`). The bot standing inside is
 *   *told* and stays connected. A client that was disconnected, or a world that
 *   was swapped underneath it, would both be the break the requirement rules out.
 *
 *   **A stale save is refused** (`FR-9.22`). Two saves against the same revision;
 *   the second is a 409 rather than an overwrite. Retrying a stale write is
 *   precisely the clobber the requirement forbids, so the code matters as much as
 *   the refusal.
 *
 *   **A member cannot edit** (`FR-9.21`, `NFR-34`), on the HTTP path, which is
 *   the only path the editor has.
 *
 * ── It builds its own map ───────────────────────────────────────────────────
 *
 * Everything happens on a Map this scenario creates and deletes, so a failure
 * part-way through cannot leave the starter maps edited.
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { Account, requireAccounts, SkipScenario, uniqueEmail } from '../accounts.js';
import { assert, assertEqual, type Scenario } from '../runner.js';
import type { EditorStateDto, MapDocument } from '@hubitat/protocol';

export const mapEditing: Scenario = {
  name: 'map-editing',
  covers: 'FR-9.4/9.18/9.19/9.20/9.21/9.22 — drafts, publishing, versions, and no clobbering',

  async run(ctx) {
    const { base, member } = await requireAccounts(ctx.url);

    const overview = await member.moderation();
    if (!overview.capabilities.includes('manage-roles')) {
      throw new SkipScenario(
        'the shared harness account does not own this space, so it cannot appoint an admin. ' +
          'Reset the database: docker compose down -v && docker compose up -d postgres',
      );
    }

    const admin = new Account(base, uniqueEmail('editor-admin'), 'harness-editor-admin-1234');
    await admin.register('Editor Admin');
    await admin.tryRedeem((await member.createInvite({ maxUses: 1 })).code);
    await member.setRole(admin.dto.id, 'admin');

    // An ordinary member, for `FR-9.21`. Fresh rather than the shared one, which
    // owns the Space and can do everything.
    const ordinary = new Account(base, uniqueEmail('editor-member'), 'harness-editor-1234');
    await ordinary.register('Editor Member');
    await ordinary.tryRedeem((await member.createInvite({ maxUses: 1 })).code);

    const slug = `editable-${Date.now().toString(36)}`;
    const occupant = new Bot(ctx.url, 'editor-occupant');
    let mapId: string | null = null;

    try {
      const created = await admin.createMap({ slug, name: 'Editable Room' });
      mapId = created.id;

      // ── FR-9.21 — a member cannot edit ────────────────────────────────────
      const refused = await ordinary.tryCall('GET', `/spaces/default/editor/maps/${mapId}`);
      assertEqual(
        refused.status,
        403,
        `an ordinary member opening the editor was answered ${refused.status}; FR-9.21 is ` +
          `admin-level and NFR-34 requires the HTTP path to enforce it`,
      );

      // ── FR-9.22 — take the lock, and read the state ───────────────────────
      const opened = (await admin.tryJson(
        'POST',
        `/spaces/default/editor/maps/${mapId}/lock`,
      )) as EditorStateDto | null;
      assert(opened !== null, 'the editor state could not be read');
      assert(opened.lock?.mine === true, 'taking the editor lock did not grant it (FR-9.22)');
      assertEqual(opened.dirty, false, 'a freshly-created map reports an unsaved draft');
      assert(
        opened.assets.length > 0,
        'the asset library is empty — a map cannot be built without uploads (FR-9.15). Run ' +
          '"node assets/library/build-library.mjs" and restart the api.',
      );

      // Somebody is standing in the room while it is edited.
      await occupant.connect();
      await occupant.join();
      occupant.navigate({ mapId });
      await waitUntil(() => occupant.transfers.length > 0, 5000, 'the occupant to reach the room');
      occupant.resetEvents();

      // ── FR-9.4 — a draft does not touch the live map ──────────────────────
      const asset = opened.assets.find((candidate) => candidate.status === 'ready')!;
      const edited: MapDocument = {
        ...opened.draft,
        objects: [
          ...opened.draft.objects,
          {
            id: 'harness-object-1',
            assetId: asset.slug,
            transform: {
              position: { x: 2, y: 0, z: 2 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          },
        ],
      };

      const saved = (await admin.tryJson('PUT', `/spaces/default/editor/maps/${mapId}/draft`, {
        document: edited,
        revision: opened.revision,
      })) as EditorStateDto | null;
      assert(saved !== null, 'saving the draft failed');
      assertEqual(saved.dirty, true, 'a saved draft that differs from the published map is clean');

      const publishedBefore = await fetchDocument(base, mapId);
      assertEqual(
        publishedBefore.objects.length,
        0,
        'a draft reached the published map — FR-9.4 requires editing to be non-destructive ' +
          'to what participants are standing in',
      );

      // ── FR-9.22 — a stale save is refused, not merged ─────────────────────
      const stale = await admin.tryCall('PUT', `/spaces/default/editor/maps/${mapId}/draft`, {
        document: edited,
        // The revision the first save was made against, which has since moved.
        revision: opened.revision,
      });
      assertEqual(
        stale.status,
        409,
        `a save against a stale revision was answered ${stale.status}; FR-9.22 requires ` +
          `conflicting overwrites to be prevented, and 409 is what tells a client to reload ` +
          `rather than retry`,
      );

      // ── FR-9.18, FR-9.20 — publishing ─────────────────────────────────────
      const published = (await admin.tryJson(
        'POST',
        `/spaces/default/editor/maps/${mapId}/publish`,
        { notes: 'harness' },
      )) as EditorStateDto | null;
      assert(published !== null, 'publishing failed');
      assert(
        published.publishedVersion > opened.publishedVersion,
        'publishing did not bump the version',
      );

      const publishedAfter = await fetchDocument(base, mapId);
      assertEqual(
        publishedAfter.objects.length,
        1,
        'publishing did not make the draft live (FR-9.18)',
      );

      // `FR-9.20` — the occupant is *told*, and is still there. A disconnect or a
      // forced reload would both be the hard break the requirement rules out.
      await sleep(500);
      assert(
        occupant.events.errors.length === 0,
        `publishing disconnected the occupant: ${occupant.events.errors.map((e) => e.code).join(', ')}`,
      );
      assertEqual(
        occupant.transfers.length,
        0,
        'publishing moved the occupant — FR-9.20 asks for "not a hard break"',
      );

      // ── FR-9.19 — revert copies forward ───────────────────────────────────
      const first = published.versions.reduce((lowest, version) =>
        version.version < lowest.version ? version : lowest,
      );
      const reverted = (await admin.tryJson('POST', `/spaces/default/editor/maps/${mapId}/revert`, {
        version: first.version,
        publish: true,
      })) as EditorStateDto | null;
      assert(reverted !== null, 'reverting failed');

      const afterRevert = await fetchDocument(base, mapId);
      assertEqual(
        afterRevert.objects.length,
        0,
        'reverting did not restore the earlier document (FR-9.19)',
      );
      assert(
        reverted.publishedVersion > published.publishedVersion,
        'reverting rolled the version pointer backwards — FR-9.19 needs the newer version to ' +
          'stay reachable, which copy-forward is what guarantees',
      );
      assert(
        reverted.versions.some((version) => version.version === published.publishedVersion),
        'the version that was reverted away from is gone — there is no way back to it',
      );

      ctx.log(
        `member refused (403) · draft stayed off the live map · stale save refused (409) · ` +
          `published v${published.publishedVersion} without disturbing the occupant · ` +
          `reverted forward to v${reverted.publishedVersion}`,
      );
    } finally {
      occupant.close();
      if (mapId) {
        await admin
          .deleteMap(mapId, slug)
          .catch(() => ctx.log(`warning: could not clean up the "${slug}" map`));
      }
      await sleep(150);
    }
  },
};

/** The document participants actually get — unauthenticated, exactly as the
 *  world loader fetches it. Reading it through the *public* route is the point:
 *  asserting on the editor's own view of the draft would prove nothing about
 *  what is live. */
async function fetchDocument(base: string, mapId: string): Promise<MapDocument> {
  const response = await fetch(`${base}/maps/${mapId}/document`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`GET /maps/${mapId}/document → ${response.status}`);
  return (await response.json()) as MapDocument;
}
