/**
 * The harness entry point.
 *
 * This project has no unit test suite. These scenarios are the test mechanism:
 * they run against a live server, so an interest-management or codec regression
 * fails here rather than showing up later as avatars in the wrong place.
 *
 *   npm run harness
 *
 * Requires the api to be running (`npm run dev --workspace @hubitat/api`).
 * See docs/testing-strategy.md.
 */

import { runAll, type Scenario } from './runner.js';
import { codecRoundtripFuzz } from './scenarios/codec-roundtrip-fuzz.js';
import { aoiCoverage } from './scenarios/aoi-coverage.js';
import { aoiBoundaryWalk } from './scenarios/aoi-boundary-walk.js';
import { lateJoinSnapshot } from './scenarios/late-join-snapshot.js';
import { reconnectResume } from './scenarios/reconnect-resume.js';
import { presenceChurn } from './scenarios/presence-churn.js';
import { sessionReaping } from './scenarios/session-reaping.js';
import { zoneBoundaryWalk } from './scenarios/zone-boundary-walk.js';
import { privateZoneIsolation } from './scenarios/private-zone-isolation.js';
import { spotlightReach } from './scenarios/spotlight-reach.js';
import { portalTeleport } from './scenarios/portal-teleport.js';
import { spawnPlacement } from './scenarios/spawn-placement.js';
import { audibleVisibleRange } from './scenarios/audible-visible-range.js';
import { mediaBudget } from './scenarios/media-budget.js';
import { emoteThrottle } from './scenarios/emote-throttle.js';
import { appearanceReplication } from './scenarios/appearance-replication.js';
import { presenceStatus } from './scenarios/presence-status.js';
import { chatScoping } from './scenarios/chat-scoping.js';
import { chatOrdering } from './scenarios/chat-ordering.js';
import { chatMentions } from './scenarios/chat-mentions.js';
import { chatHistory } from './scenarios/chat-history.js';
import { chatTypingChannels } from './scenarios/chat-typing-channels.js';
import { accountIdentity } from './scenarios/account-identity.js';
import { guestUpgrade } from './scenarios/guest-upgrade.js';
import { inviteMembership } from './scenarios/invite-membership.js';
import { guestsNotAllowed } from './scenarios/guests-not-allowed.js';
import { sessionLifecycle } from './scenarios/session-lifecycle.js';
import { moderationCapabilities } from './scenarios/moderation-capabilities.js';
import { forceMute } from './scenarios/force-mute.js';
import { kickAndBan } from './scenarios/kick-and-ban.js';
import { accessControls } from './scenarios/access-controls.js';
import { blocking } from './scenarios/blocking.js';
import { reportsAndAudit } from './scenarios/reports-and-audit.js';
import { crossMapPortal } from './scenarios/cross-map-portal.js';
import { spaceDirectory } from './scenarios/space-directory.js';
import { mapInstancing } from './scenarios/map-instancing.js';
import { mapLifecycle } from './scenarios/map-lifecycle.js';
import { mapEditing } from './scenarios/map-editing.js';
import { sharedObjects } from './scenarios/shared-objects.js';

const URL = process.env.HARNESS_WS_URL ?? 'ws://localhost:3000/ws';

/**
 * Ordered fastest-first, so a broken build fails in seconds rather than after
 * the half-open reaping scenario has waited out two ping intervals.
 */
const SCENARIOS: Scenario[] = [
  codecRoundtripFuzz,
  lateJoinSnapshot,
  privateZoneIsolation,
  spotlightReach,
  audibleVisibleRange,
  spawnPlacement,
  appearanceReplication,
  chatOrdering,
  chatHistory,
  aoiBoundaryWalk,
  mediaBudget,
  emoteThrottle,
  // The three chat scenarios that assert a message did NOT arrive sit here
  // rather than at the front: proving a negative costs a timeout each, and the
  // ordering rule for this list is fastest-first.
  chatMentions,
  chatTypingChannels,
  chatScoping,
  zoneBoundaryWalk,
  portalTeleport,
  // Phase 8's two blockless scenarios sit with the rest of the world tests: they
  // need no database and no account, because walking through a door and reading
  // the directory are things a guest does. The two that *configure* a map are
  // further down with phase 7, where the accounts are.
  crossMapPortal,
  spaceDirectory,
  presenceChurn,
  presenceStatus,
  reconnectResume,
  aoiCoverage,
  sessionReaping,
  // Phase 6 runs last, and not only because argon2 costs ~50 ms per hash. These
  // are the only scenarios that touch a database, the only ones that can skip,
  // and `guests-not-allowed` briefly closes the space to guests — every scenario
  // above it joins as one, so it must not run while they are in flight.
  accountIdentity,
  guestUpgrade,
  sessionLifecycle,
  inviteMembership,
  guestsNotAllowed,
  // Phase 7 runs last, after phase 6, and the ordering inside it is not
  // arbitrary either. Every one of these needs an account with a role, so they
  // inherit phase 6's database requirement and its ability to skip.
  //
  // `access-controls` is the `guests-not-allowed` of this phase: it locks the
  // space, sets a password and drops capacity to one, and every scenario before
  // it joins as an ordinary guest. It restores all four in a `finally` and then
  // proves it — but it must not run while anything else is in flight, so it sits
  // at the end with only the two blockless scenarios after it.
  moderationCapabilities,
  forceMute,
  kickAndBan,
  blocking,
  reportsAndAudit,
  // Phase 8's administrative half, after phase 7 and for the same reasons: both
  // need an account with a role, so they inherit the database requirement and
  // the ability to skip. `map-instancing` lowers the atrium's capacity and
  // `map-lifecycle` archives a room with somebody in it — neither should be in
  // flight while a scenario above is asserting on where people are, and both
  // restore what they changed.
  mapInstancing,
  mapLifecycle,
  // Phase 9. Same requirements as phase 8's administrative half — an account
  // with a role — and one more: it builds a map, edits it, publishes it and
  // deletes it, so it must not run while anything else is asserting on the
  // catalogue.
  mapEditing,
  // Phase 10. It builds a room, puts a shared board in it, and drives the CRDT
  // socket with the same `y-protocols` the browser uses — so a change to the
  // sync handshake, to `/collab`'s authorization or to the persistence flush
  // fails here rather than as a whiteboard that quietly forgot an afternoon.
  sharedObjects,
  accessControls,
];

const only = process.argv[2];
const selected = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;

if (selected.length === 0) {
  console.error(`No scenario matches "${only}". Available:`);
  for (const scenario of SCENARIOS) console.error(`  ${scenario.name}`);
  process.exit(1);
}

await assertServerReachable(URL);

const failed = await runAll(selected, URL);
process.exit(failed === 0 ? 0 : 1);

/** A connection-refused error buried in the first scenario reads as a protocol
 *  bug. Check once, up front, and say what is actually wrong. */
async function assertServerReachable(wsUrl: string): Promise<void> {
  const healthUrl = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(
      `\n  Cannot reach the api at ${healthUrl}\n` +
        `  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `  Start it first:  npm run dev --workspace @hubitat/api\n`,
    );
    process.exit(1);
  }
}
