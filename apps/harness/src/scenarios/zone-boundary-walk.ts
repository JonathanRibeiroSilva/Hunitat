/**
 * zone-boundary-walk — FR-3.3, FR-3.18 and the Phase 3 edge-flap rule.
 *
 *   > Zone boundaries must not flap for a participant standing on an edge
 *   > (apply hysteresis).
 *
 * The same failure as `aoi-boundary-walk`, one phase later and with worse
 * consequences: a flapping interest set makes an avatar strobe, a flapping
 * private zone connects and drops someone's audio twenty times a second.
 *
 * Two properties, in one pass:
 *
 *   1. Loitering across the enter edge produces exactly one enter, because the
 *      exit test uses a volume ZONE_HYSTERESIS_M larger.
 *   2. A clean pass-through of a trigger produces exactly one enter and one
 *      exit, in that order, carrying the authored key (AC-3.5, DC-3.3).
 */

import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

const OSCILLATIONS = 20;

/** `huddle-meeting` spans x ∈ [-12.1, -5.1]; the east face is the edge walked. */
const EDGE_X = -5.1;
/** `west-corridor` spans z ∈ [1.5, 4.5] at x ∈ [-11, -5]. */
const CORRIDOR = { x: -8, southOfIt: 6, northOfIt: 0 };

export const zoneBoundaryWalk: Scenario = {
  name: 'zone-boundary-walk',
  covers: 'FR-3.3/3.18 — zone membership does not flap, and triggers fire once',

  async run(ctx) {
    const walker = new Bot(ctx.url, 'zone-walker');

    try {
      await walker.connect();
      await walker.join();

      const hysteresis = 0.3;

      // Start well clear, so the measured phase begins from a known-empty state
      // rather than from wherever the spawn rule placed them.
      walker.moveTo(0, 0);
      await sleep(200);
      walker.resetEvents();

      // ── 1. the edge ────────────────────────────────────────────────────────
      walker.moveTo(EDGE_X - 0.2, -5);
      await waitUntil(
        () => walker.zoneEventsFor('huddle-meeting').length > 0,
        3000,
        'walker to enter the private zone',
      );

      // Oscillate across the enter edge, staying inside the hysteresis band. A
      // single-volume implementation emits an enter/exit pair on every crossing.
      for (let i = 0; i < OSCILLATIONS; i++) {
        walker.moveTo(EDGE_X - 0.2, -5);
        await sleep(60);
        walker.moveTo(EDGE_X + hysteresis - 0.1, -5);
        await sleep(60);
      }

      const edgeEvents = walker.zoneEventsFor('huddle-meeting');
      assertEqual(
        edgeEvents.filter((e) => e.kind === 'enter').length,
        1,
        `expected one enter across ${OSCILLATIONS * 2} crossings of the zone edge`,
      );
      assertEqual(
        edgeEvents.filter((e) => e.kind === 'exit').length,
        0,
        'exited while still inside the hysteresis band',
      );

      // Clear the band properly: now it must exit, exactly once.
      walker.moveTo(EDGE_X + 2, -5);
      await waitUntil(
        () => walker.zoneEventsFor('huddle-meeting').some((e) => e.kind === 'exit'),
        3000,
        'walker to leave the private zone',
      );
      assertEqual(
        walker.zoneEventsFor('huddle-meeting').filter((e) => e.kind === 'exit').length,
        1,
        'expected exactly one exit',
      );

      // ── 2. a pass-through ──────────────────────────────────────────────────
      walker.resetEvents();
      walker.moveTo(CORRIDOR.x, CORRIDOR.southOfIt);
      await sleep(200);

      walker.moveTo(CORRIDOR.x, 3); // inside
      await waitUntil(
        () => walker.zoneEventsFor('west-corridor').length > 0,
        3000,
        'walker to enter the trigger volume',
      );

      walker.moveTo(CORRIDOR.x, CORRIDOR.northOfIt); // out the far side
      await waitUntil(
        () => walker.zoneEventsFor('west-corridor').length > 1,
        3000,
        'walker to leave the trigger volume',
      );
      await sleep(150);

      const pass = walker.zoneEventsFor('west-corridor');
      assertEqual(pass.length, 2, `one pass-through produced ${pass.length} events, expected 2`);
      assertEqual(pass[0]!.kind, 'enter', 'first event of a pass-through must be the enter');
      assertEqual(pass[1]!.kind, 'exit', 'second event of a pass-through must be the exit');
      assertEqual(pass[0]!.key, 'west-corridor', 'trigger event lost its authored key (DC-3.3)');
      assert(pass[0]!.at > 0, 'trigger event carries no timestamp (DC-3.3)');

      ctx.log(`${OSCILLATIONS * 2} edge crossings → 1 enter · pass-through → 1 enter, 1 exit`);
    } finally {
      walker.close();
      await sleep(100);
    }
  },
};
