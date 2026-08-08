/**
 * appearance-replication — AC-4.2.
 *
 *   > Changing customization is visible to other participants promptly,
 *   > including to someone who walks up afterward.
 *
 * The second half is the one that breaks. A server that broadcasts
 * `PARTICIPANT_UPDATE` on change and stops there passes every test anybody
 * thinks to write, and then shows the *default* avatar to everyone who arrives
 * later — because the appearance was never put on the frames that describe a
 * participant to somebody seeing them for the first time.
 *
 * So all three arrival paths are checked:
 *
 *   already here   PARTICIPANT_UPDATE, live
 *   joins later    SNAPSHOT
 *   walks up       PARTICIPANT_ADD
 *
 * Also that a guest who offers no appearance is given a distinct one rather
 * than everybody sharing a default — the phase 1 capsules had `colorForId` for
 * exactly this reason, and replacing them with identical characters would be a
 * regression in a feature nobody would think to re-test.
 */

import { appearanceForSeed, type AvatarAppearance } from '@hubitat/protocol';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, type Scenario } from '../runner.js';

/** Deliberately not the default and not what any seed would produce for a low
 *  local id, so "the change arrived" cannot be confused with "nothing happened". */
const CHOSEN: AvatarAppearance = {
  baseModel: 'broad',
  colors: { skin: 4, hair: 6, top: 5, bottom: 3 },
  accessories: ['cap', 'glasses'],
};

export const appearanceReplication: Scenario = {
  name: 'appearance-replication',
  covers: 'AC-4.2 — a customization reaches watchers, late joiners and people who walk up',

  async run(ctx) {
    const dresser = new Bot(ctx.url, 'appearance-dresser');
    const watcher = new Bot(ctx.url, 'appearance-watcher');
    const joiner = new Bot(ctx.url, 'appearance-joiner');
    const walker = new Bot(ctx.url, 'appearance-walker');

    try {
      await dresser.connect();
      await dresser.join();
      await watcher.connect();
      await watcher.join();
      await walker.connect();
      await walker.join();

      const tuning = dresser.joined!.tuning;
      const spawn = dresser.joined!.spawn;

      // A join with no appearance must still produce one.
      const generated = dresser.joined!.appearance;
      assert(
        generated !== undefined && generated !== null,
        'JOINED carried no appearance; the client has nothing to open its customizer on',
      );

      // Positioned only after joining: `join` adopts the spawn the server issued,
      // so a move sent before it is overwritten by the handshake.
      dresser.moveTo(spawn.x, spawn.z);
      watcher.moveTo(spawn.x + 2, spawn.z);
      // Everyone spawns together, so the walker has to leave before it can walk
      // up — which is the case AC-4.2 singles out.
      walker.moveTo(spawn.x, spawn.z + tuning.aoiExitRadiusM + 10);

      for (let i = 0; i < 4; i++) {
        dresser.sendTransform();
        watcher.sendTransform();
        walker.sendTransform();
        await sleep(60);
      }
      await sleep(300);

      assert(
        watcher.remotes.has(dresser.localId),
        'the watcher never saw the dresser at all; the rest of this proves nothing',
      );
      await waitUntil(
        () => !walker.remotes.has(dresser.localId),
        2000,
        `the walker to leave the ${tuning.aoiExitRadiusM} m interest radius`,
      );

      watcher.resetEvents();

      // ── 1. someone already here ───────────────────────────────────────────
      dresser.setAppearance(CHOSEN);

      await waitUntil(
        () => matches(watcher.remotes.get(dresser.localId)?.appearance, CHOSEN),
        2000,
        'the watcher to receive the customization',
      );
      assert(
        watcher.updatesFor(dresser.localId, 'appearance').length > 0,
        'the watcher holds the right appearance but never received a PARTICIPANT_UPDATE ' +
          'carrying it — which means it arrived by some other path than FR-4.6',
      );

      // ── 2. someone who joins afterward ────────────────────────────────────
      await joiner.connect();
      await joiner.join();
      await waitUntil(() => joiner.snapshot.length > 0, 2000, 'the joiner snapshot');

      const inSnapshot = joiner.snapshot.find((p) => p.id === dresser.localId);
      assert(
        inSnapshot !== undefined,
        'the joiner did not see the dresser in its snapshot; it spawned out of range',
      );
      assert(
        matches(inSnapshot.appearance, CHOSEN),
        'SNAPSHOT carried a stale appearance — a late joiner sees the default until the ' +
          'next change, which is the exact failure the Phase 4 Rules call out',
      );

      // ── 3. someone who walks up ───────────────────────────────────────────
      walker.moveTo(spawn.x + 3, spawn.z);
      for (let i = 0; i < 4; i++) {
        walker.sendTransform();
        await sleep(60);
      }
      await waitUntil(
        () => walker.remotes.has(dresser.localId),
        2000,
        "the walker to enter the dresser's area of interest",
      );
      assert(
        matches(walker.remotes.get(dresser.localId)?.appearance, CHOSEN),
        'PARTICIPANT_ADD carried a stale appearance — someone walking up after a change ' +
          'sees the old look (Phase 4 Rules)',
      );

      // ── 4. guests who offer nothing must not all look the same ────────────
      // The client used to send its in-memory appearance unconditionally, which
      // for a browser with nothing stored is the shared default — so the server
      // read it as a request, `appearanceForSeed` never ran, and a room of
      // people who had not opened the customizer was a room of identical clones.
      // A regression on Phase 1's `colorForId`, and invisible to a test that
      // only ever checks one guest.
      const looks = [
        dresser.joined!.appearance,
        watcher.joined!.appearance,
        walker.joined!.appearance,
      ];
      const distinct = new Set(looks.map((look) => JSON.stringify(look)));
      assert(
        distinct.size === looks.length,
        `${looks.length} guests joined without offering an appearance and the server issued ` +
          `${distinct.size} distinct one(s). Everyone who has not customized looks identical.`,
      );

      // ── 5. an offered appearance is honoured at join ──────────────────────
      const offered = appearanceForSeed(4242);
      const offerer = new Bot(ctx.url, 'appearance-offerer');
      try {
        await offerer.connect();
        const joined = await offerer.join(undefined, offered);
        assert(
          matches(joined.appearance, offered),
          'JOIN offered an appearance and the server issued a different one; FR-4.8 has ' +
            'nowhere to persist to if the client cannot present what it remembered',
        );
      } finally {
        offerer.close();
      }

      ctx.log(
        `customization reached a watcher live, a joiner via SNAPSHOT and a walker via ` +
          `PARTICIPANT_ADD; 3 guests offering nothing were given 3 distinct looks, and a ` +
          `guest offering one kept it`,
      );
    } finally {
      dresser.close();
      watcher.close();
      joiner.close();
      walker.close();
      await sleep(100);
    }
  },
};

function matches(actual: AvatarAppearance | undefined, expected: AvatarAppearance): boolean {
  if (!actual) return false;
  return (
    actual.baseModel === expected.baseModel &&
    actual.colors.skin === expected.colors.skin &&
    actual.colors.hair === expected.colors.hair &&
    actual.colors.top === expected.colors.top &&
    actual.colors.bottom === expected.colors.bottom &&
    // Order is not meaningful — the server de-duplicates and is free to reorder.
    [...actual.accessories].sort().join(',') === [...expected.accessories].sort().join(',')
  );
}
