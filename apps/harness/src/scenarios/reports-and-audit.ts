/**
 * `AC-7.6` — a report is recorded and visible to moderators, and every
 * moderation action appears in the audit log with actor, target and time.
 *
 * ── The two halves are deliberately different tables ────────────────────────
 *
 * A **report** is what a user filed. It is a queue item: it can be marked
 * handled, because a queue that cannot be emptied is a queue nobody works.
 *
 * The **audit log** is what a moderator did. It is append-only — by a grant and
 * by a trigger, see the migration — because `FR-7.20` asks for a record that can
 * be trusted, and a table with one editable column is not append-only.
 *
 * So filing a report writes no audit row, and *handling* one does: the first is
 * a user acting, the second is a moderator taking responsibility.
 *
 * ── Why the context is asserted ─────────────────────────────────────────────
 *
 * `FR-7.17` asks for context, and `DC-7.6` names position. It is captured on the
 * server rather than sent by the reporter, because a client-supplied location is
 * a fact about the accused supplied by the accuser — so the scenario stands the
 * target somewhere specific and checks the record agrees.
 */

import { requireAccounts } from '../accounts.js';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertClose, assertEqual, type Scenario } from '../runner.js';

/**
 * Poll an HTTP read until it says what we are waiting for.
 *
 * `waitUntil` in `bot.ts` takes a synchronous predicate over frames a bot has
 * already received, which every scenario before this one could use. This phase
 * is the first where an action arrives on the **socket** and the record of it is
 * read over **REST**, so there is no local value to watch — and asserting
 * immediately would be racing the write.
 *
 * Returns the last read either way, so a failure is asserted against real data
 * rather than reported as a timeout with nothing in it.
 */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 25 && !done(value); attempt++) {
    await sleep(100);
    value = await read();
  }
  return value;
}

export const reportsAndAudit: Scenario = {
  name: 'reports-and-audit',
  covers: 'AC-7.6, FR-7.17, FR-7.19, FR-7.20 — reports reach moderators, actions reach the log',

  async run(ctx) {
    const { member: owner } = await requireAccounts(ctx.url);

    /**
     * Unique per run, and that is not decoration.
     *
     * The harness runs against a live server whose database persists between
     * runs, so a fixed sentence would match yesterday's report — which has since
     * been marked handled by this very scenario, and the "unreviewed" assertion
     * would fail against a row that was never this run's. The same reasoning as
     * `uniqueEmail` in `accounts.ts`, one phase later.
     */
    const complaint = `Kept following me around the lobby (${Date.now().toString(36)}).`;

    // Named by its profile, not by this string — `FR-6.9`. See `force-mute`.
    const moderator = new Bot(ctx.url, 'ignored-for-an-account');
    moderator.accessToken = owner.accessToken;
    const reporter = new Bot(ctx.url, 'Concerned Person');
    const subject = new Bot(ctx.url, 'Reported Person');

    for (const bot of [moderator, reporter, subject]) {
      await bot.connect();
      await bot.join();
    }
    await waitUntil(
      () => reporter.remotes.size >= 2 && moderator.remotes.size >= 2,
      4000,
      'everybody in range',
    );

    // Somewhere specific, so the captured context can be checked against a known
    // position rather than against whatever a spawn happened to be.
    subject.moveTo(7.5, -3.25);
    await waitUntil(
      () => {
        const seen = moderator.remoteBySession(subject.joined!.sessionId);
        return seen !== undefined && Math.abs(seen.transform.x - 7.5) < 0.5;
      },
      4000,
      'the server has the target’s reported position',
    );

    // ── FR-7.17 — file it ───────────────────────────────────────────────────
    const before = await owner.moderation();
    reporter.report(subject.joined!.sessionId, complaint);

    // Polled over HTTP rather than through `waitUntil`, which takes a
    // synchronous predicate: the frame arrives on a socket and the record is
    // read over REST, so there is no single value to watch. The wait is real —
    // the report is written by the same tick that received the frame, and the
    // read is a separate request.
    const overview = await until(
      () => owner.moderation(),
      (state) => state.reports.length > before.reports.length,
    );

    const filed = overview.reports.find((report) => report.reason === complaint);
    assert(filed !== undefined, 'AC-7.6: a report is recorded and visible to moderators');
    assertEqual(filed!.reporterName, 'Concerned Person', 'naming who filed it');
    assertEqual(filed!.targetName, 'Reported Person', 'and who it is about');
    assertEqual(filed!.reviewedAt, null, 'unreviewed, which is what puts it in front of somebody');
    assertEqual(
      overview.reports[0]?.reviewedAt,
      null,
      'AC-7.6: unreviewed reports sort first — a queue ordered the other way is one nobody works',
    );

    // `DC-7.6` — the where, captured server-side.
    assertClose(
      filed!.context.x,
      7.5,
      0.5,
      'FR-7.17: the context is the server’s view of where they were standing',
    );
    assertClose(filed!.context.z, -3.25, 0.5, 'on both axes');

    // ── FR-7.19 — moderation actions reach the log ──────────────────────────
    moderator.moderate('mute', subject.joined!.sessionId, { reason: 'Following people.' });
    await waitUntil(
      () => subject.moderationStates.length > 0,
      3000,
      'the mute lands before the log is read',
    );

    const audited = await until(
      () => owner.moderation(),
      (state) => state.audit.some((entry) => entry.action === 'mute'),
    );

    const muteEntry = audited.audit.find(
      (entry) => entry.action === 'mute' && entry.targetName === 'Reported Person',
    );
    assert(muteEntry !== undefined, 'AC-7.6: the mute appears in the audit log');
    assertEqual(muteEntry!.actorName, owner.dto.displayName, 'FR-7.19: with the actor');
    assert(
      muteEntry!.actorIdentity.startsWith('acct:'),
      'FR-7.19: identified durably, not by a session that will not exist tomorrow',
    );
    assert(Number.isFinite(new Date(muteEntry!.at).getTime()), 'FR-7.19: and a time');
    assertEqual(
      muteEntry!.detail.reason,
      'Following people.',
      'the reason is kept with the action rather than left to memory',
    );
    assertEqual(
      muteEntry!.detail.actorRole,
      'owner',
      'and the roles at the time, which cannot be recovered later — roles change',
    );

    // Newest first, which is the order somebody reviewing reads in.
    const times = audited.audit.map((entry) => new Date(entry.at).getTime());
    assert(
      times.every((time, index) => index === 0 || times[index - 1]! >= time),
      'FR-7.20: the log reads newest first',
    );

    // ── Handling a report is itself a moderation act ────────────────────────
    await owner.reviewReport(filed!.id);

    const handled = await until(
      () => owner.moderation(),
      (state) => state.audit.some((entry) => entry.action === 'report-reviewed'),
    );

    const reviewed = handled.reports.find((report) => report.id === filed!.id);
    assert(reviewed?.reviewedAt !== null, 'AC-7.6: the report can be marked handled');
    assertEqual(reviewed?.reviewedBy, owner.dto.displayName, 'by whoever handled it');
    assert(
      handled.audit.some((entry) => entry.action === 'report-reviewed'),
      'FR-7.19: and taking responsibility for a report is itself in the log',
    );

    // ── The log is not readable by everybody ────────────────────────────────
    //
    // `FR-7.20` says *permitted roles* can review it. A plain participant gets
    // their own capabilities and empty lists rather than somebody else's
    // complaints.
    const guestView = new Bot(ctx.url, 'Nosy');
    await guestView.connect();
    await guestView.join();
    assert(
      !guestView.capabilities.includes('review'),
      'FR-7.20: an ordinary participant has no review capability',
    );
    guestView.close();

    moderator.moderate('unmute', subject.joined!.sessionId);
    for (const bot of [moderator, reporter, subject]) bot.close();
    ctx.log(`report recorded with its context; ${handled.audit.length} audit entries readable`);
  },
};
