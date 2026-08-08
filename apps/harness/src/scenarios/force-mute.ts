/**
 * `AC-7.2` — force-mute silences a target until lifted, the target is informed,
 * and they cannot get it back themselves.
 *
 * ── What can and cannot be asserted without an SFU ──────────────────────────
 *
 * The harness runs without LiveKit, and deliberately: it asserts the server's
 * *decisions*, and the server decides who may publish without any media
 * existing. So "cannot self-unmute" is checked as the property that actually
 * makes it true rather than by trying to publish audio:
 *
 *   - the world-side state is the authoritative copy, and nothing a client sends
 *     changes it — there is no unmute frame, which is itself the assertion;
 *   - it **survives a reconnect**, which is the loophole worth testing. A
 *     participant who dropped their socket and came back would otherwise be
 *     issued a fresh LiveKit token with `canPublish: true`, and a moderation
 *     action with a ten-second workaround is not one.
 *
 * The remaining half — that LiveKit itself refuses the publish — is the two-call
 * pattern in `MediaService.applyPublishPermission`, and is verified by hand
 * against a real SFU (docs/remote-media-testing.md).
 */

import { requireAccounts } from '../accounts.js';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const forceMute: Scenario = {
  name: 'force-mute',
  covers: 'AC-7.2, FR-7.5, FR-7.6, FR-7.10 — a mute that holds, and says who did it',

  async run(ctx) {
    const { member: owner } = await requireAccounts(ctx.url);

    // The name is the *profile's*, not the one asked for here: `FR-6.9` makes an
    // account's profile authoritative over whatever a client offers on `JOIN`.
    // Asserted against `owner.dto.displayName` below for that reason — hard-coding
    // a name here would be testing a rule phase 6 deliberately inverted.
    const moderator = new Bot(ctx.url, 'ignored-for-an-account');
    moderator.accessToken = owner.accessToken;
    const target = new Bot(ctx.url, 'Loud Person');
    const observer = new Bot(ctx.url, 'Observer');

    for (const bot of [moderator, target, observer]) {
      await bot.connect();
      await bot.join();
    }

    await waitUntil(
      () => moderator.remotes.size >= 2 && observer.remotes.size >= 2,
      4000,
      'everybody in range',
    );

    const targetSession = target.joined!.sessionId;
    const targetLocalId = target.localId;

    // ── FR-7.5 — the mute, and the notification ─────────────────────────────
    moderator.moderate('mute', targetSession, { reason: 'Please use the stage.' });

    await waitUntil(() => target.moderationStates.length > 0, 3000, 'AC-7.2: the target is told');
    const told = target.moderationStates[0]!;
    assertEqual(told.micMuted, true, 'AC-7.2: muted');
    assertEqual(
      told.cameraDisabled,
      false,
      'FR-7.6 is a separate requirement and was not asked for',
    );
    assertEqual(
      told.byName,
      owner.dto.displayName,
      'AC-7.2: the target is told who — a mute with no author is indistinguishable from a fault',
    );
    assertEqual(told.reason, 'Please use the stage.', 'and why, when there is a why');

    // ── Observers get the fact, and only the fact ───────────────────────────
    await waitUntil(
      () => observer.remoteBySession(targetSession)?.moderation.micMuted === true,
      3000,
      'observers see that they are muted',
    );
    const observed = observer.updatesFor(targetLocalId, 'moderation');
    assert(observed.length > 0, 'the room was told through PARTICIPANT_UPDATE');
    assert(
      observed.every((update) => !('byName' in update) && !('reason' in update)),
      'and NOT told who did it or why — that goes to the target alone',
    );

    // The moderator is not exempt from being an observer: they see the same
    // fact everybody else does, which is what makes the presence list agree.
    assertEqual(
      moderator.remoteBySession(targetSession)?.moderation.micMuted,
      true,
      'including the moderator',
    );

    // ── FR-7.6 — camera is separate, and both can hold at once ─────────────
    moderator.moderate('disable-video', targetSession);
    await waitUntil(
      () => target.moderationStates.some((state) => state.cameraDisabled),
      3000,
      'FR-7.6: video can be taken away too',
    );
    const both = target.moderationStates[target.moderationStates.length - 1]!;
    assertEqual(both.micMuted, true, 'and disabling video did not quietly restore the microphone');

    // ── "Until unmuted" survives a reconnect ────────────────────────────────
    //
    // The loophole this closes: drop the socket, get a fresh media grant, be
    // back. The state lives on the participant rather than the connection, and
    // the grant is built from it.
    const resumeToken = target.joined!.resumeToken;
    target.terminate();
    await sleep(200);

    const returning = new Bot(ctx.url, 'Loud Person');
    // The same browser, which is what a real reconnect is.
    returning.fingerprint = target.fingerprint;
    await returning.connect();
    const rejoined = await returning.join(resumeToken);

    assertEqual(rejoined.resumed, true, 'the reconnect resumed the retained participant');
    await waitUntil(
      () => returning.moderationStates.length > 0,
      3000,
      'AC-7.2: the mute is re-stated on the new socket, so nothing on screen says it is over',
    );
    assertEqual(
      returning.moderationStates[0]?.micMuted,
      true,
      'AC-7.2: and it is still in force — a reconnect is not an unmute',
    );

    // ── Lifted, and only by a moderator ─────────────────────────────────────
    moderator.moderate('unmute', returning.joined!.sessionId);
    moderator.moderate('enable-video', returning.joined!.sessionId);

    await waitUntil(
      () => returning.moderationStates.some((state) => !state.micMuted && !state.cameraDisabled),
      3000,
      'AC-7.2: lifting it reaches the target',
    );
    const lifted = returning.moderationStates[returning.moderationStates.length - 1]!;
    assert(
      lifted.byName === undefined,
      'restoring a permission names nobody — "you were unmuted by Ana" reads like a second sanction',
    );

    await waitUntil(
      () => observer.remoteBySession(returning.joined!.sessionId)?.moderation.micMuted === false,
      3000,
      'and the room',
    );

    for (const bot of [moderator, returning, observer]) bot.close();
    ctx.log('muted with a reason, survived a reconnect, and lifted');
  },
};
