/**
 * `AC-7.1` — a member cannot do admin things, an admin can, and the owner can do
 * everything an admin can plus manage roles.
 *
 * ── Why this asserts on both transports ─────────────────────────────────────
 *
 * `NFR-34`:
 *
 *   > From Phase 7, authorization is enforced on **both** HTTP and WebSocket
 *   > paths. A capability hidden in the UI is not enforced.
 *
 * and the Phase 7 implementation notes name the unguarded WebSocket handler as
 * the single most likely way this phase ships broken. A scenario that only
 * exercised the REST surface would pass against exactly that bug — the moderation
 * *frames* are where the bypass would be, and they are the ones a modified client
 * would send.
 *
 * So every refusal here is checked twice: once as an `ERROR forbidden` frame on a
 * socket, once as an HTTP 403.
 *
 * ── Why the roles are built rather than assumed ─────────────────────────────
 *
 * The shared harness member is the founding account and therefore the owner
 * (`RolesService.claimOwner`). Everybody else is created here, admitted with an
 * invite, and promoted or left alone — so the scenario controls the whole
 * hierarchy rather than depending on what a previous run happened to leave
 * behind.
 */

import { Account, requireAccounts, uniqueEmail } from '../accounts.js';
import { Bot, waitUntil } from '../bot.js';
import { assert, assertEqual, type Scenario } from '../runner.js';

export const moderationCapabilities: Scenario = {
  name: 'moderation-capabilities',
  covers: 'AC-7.1, FR-7.2–FR-7.4, NFR-34 — roles gate authority on both transports',

  async run(ctx) {
    const { base, member: owner } = await requireAccounts(ctx.url);

    const overview = await owner.moderation();
    assertEqual(
      overview.role,
      'owner',
      'the founding account holds the owner role — a space whose members are all ' +
        '`member` has nobody who can appoint anybody (FR-7.3)',
    );
    assert(overview.capabilities.includes('manage-roles'), 'FR-7.2: the owner can manage roles');

    // ── Build a member and an admin ─────────────────────────────────────────
    const invite = await owner.createInvite({ maxUses: null, expiresInHours: 1 });

    const plain = new Account(base, uniqueEmail('mod-member'), 'mod-member-passphrase-x');
    const admin = new Account(base, uniqueEmail('mod-admin'), 'mod-admin-passphrase-x');
    await Promise.all([plain.register('Plain Member'), admin.register('Admin Person')]);
    await Promise.all([plain.tryRedeem(invite.code), admin.tryRedeem(invite.code)]);

    const adminId = admin.dto.id;
    await owner.setRole(adminId, 'admin');
    ctx.log(`owner ${owner.dto.displayName}, admin ${admin.dto.displayName}, one plain member`);

    // ── Everybody joins ─────────────────────────────────────────────────────
    const target = new Bot(ctx.url, 'Target');
    const memberBot = new Bot(ctx.url, 'Member Bot');
    const adminBot = new Bot(ctx.url, 'Admin Bot');
    const ownerBot = new Bot(ctx.url, 'Owner Bot');

    memberBot.accessToken = plain.accessToken;
    adminBot.accessToken = admin.accessToken;
    ownerBot.accessToken = owner.accessToken;

    for (const bot of [target, memberBot, adminBot, ownerBot]) {
      await bot.connect();
      await bot.join();
    }

    assertEqual(memberBot.role, 'member', 'FR-7.1: the invited account joins as a member');
    assertEqual(adminBot.role, 'admin', 'FR-7.1: the promoted account joins as an admin');
    assertEqual(ownerBot.role, 'owner', 'FR-7.1: and the founder as the owner');

    assert(
      !memberBot.capabilities.includes('moderate'),
      'FR-7.2: a member has no moderation capability',
    );
    assert(adminBot.capabilities.includes('moderate'), 'FR-7.2: an admin does');
    assert(
      adminBot.capabilities.includes('manage-invites'),
      'FR-7.2: and every lower-role ability with it — higher roles supersede',
    );
    assert(
      !adminBot.capabilities.includes('manage-roles'),
      'FR-7.3: but not role management, which is the owner’s',
    );

    // Everybody has to be able to see everybody, or a refusal could be "that
    // person is not here" rather than "you may not".
    await waitUntil(
      () => [memberBot, adminBot, ownerBot].every((bot) => bot.remotes.size >= 3),
      4000,
      'all four bots in range of each other',
    );

    // ── A member cannot moderate — on the socket ────────────────────────────
    memberBot.resetEvents();
    memberBot.moderate('mute', target.joined!.sessionId);

    await waitUntil(
      () => memberBot.errorsWithCode('forbidden').length > 0,
      3000,
      'AC-7.1: the member’s mute is refused',
    );
    assert(
      /member/i.test(memberBot.errorsWithCode('forbidden')[0]?.message ?? ''),
      'FR-7.4: the refusal says what they are, not which permission string they lack',
    );
    // The point of `FR-7.4` is that it is *refused*, not ignored — so the target
    // must be unchanged as well as the sender told.
    assertEqual(
      adminBot.remoteBySession(target.joined!.sessionId)?.moderation.micMuted,
      false,
      'AC-7.1: and nothing happened to the target',
    );

    // ── …and on HTTP, which is the other half of NFR-34 ────────────────────
    const httpRefusal = await plain.tryCall('PATCH', '/spaces/default/moderation/access', {
      locked: true,
    });
    assertEqual(httpRefusal.status, 403, 'NFR-34: the same refusal over HTTP');
    assert(
      /admin/i.test(httpRefusal.message),
      `the HTTP refusal names the role that could — got "${httpRefusal.message}"`,
    );

    // ── An admin can ────────────────────────────────────────────────────────
    adminBot.moderate('mute', target.joined!.sessionId, { reason: 'testing' });
    await waitUntil(
      () => target.moderationStates.length > 0,
      3000,
      'AC-7.1: the admin’s mute lands',
    );
    assertEqual(target.moderationStates[0]?.micMuted, true, 'and the target is muted');

    // ── …but not on somebody who outranks them (FR-7.3) ────────────────────
    adminBot.resetEvents();
    adminBot.moderate('kick', ownerBot.joined!.sessionId);
    await waitUntil(
      () => adminBot.errorsWithCode('forbidden').length > 0,
      3000,
      'FR-7.3: an admin cannot act on the owner',
    );
    assert(
      /owner/i.test(adminBot.errorsWithCode('forbidden')[0]?.message ?? ''),
      'and is told why',
    );
    assert(ownerBot.joined !== null, 'the owner is still in the world');

    // ── Roles are the owner’s alone ─────────────────────────────────────────
    const roleRefusal = await admin.tryCall(
      'PATCH',
      `/spaces/default/moderation/members/${plain.dto.id}/role`,
      { role: 'admin' },
    );
    assertEqual(roleRefusal.status, 403, 'FR-7.3: an admin cannot assign roles');

    // ── FR-7.10 — a demotion reaches a session that is already in the world ──
    await owner.setRole(adminId, 'member');
    await waitUntil(
      () => adminBot.role === 'member',
      4000,
      'FR-7.10: the demotion reaches the live session without a rejoin',
    );
    assert(
      !adminBot.capabilities.includes('moderate'),
      'AC-7.1: and its capability list goes with it',
    );

    adminBot.resetEvents();
    adminBot.moderate('unmute', target.joined!.sessionId);
    await waitUntil(
      () => adminBot.errorsWithCode('forbidden').length > 0,
      3000,
      'the demoted admin is refused, which is the point of not caching a role on a token',
    );

    // Left tidy for the scenarios that follow, and because a muted target is a
    // side effect this scenario had no business leaving behind.
    ownerBot.moderate('unmute', target.joined!.sessionId);
    await waitUntil(
      () => target.moderationStates.some((state) => !state.micMuted),
      3000,
      'the owner can undo what the admin did',
    );

    for (const bot of [target, memberBot, adminBot, ownerBot]) bot.close();
    ctx.log('member refused on both transports; admin allowed; owner outranks both');
  },
};
