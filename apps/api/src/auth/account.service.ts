/**
 * `DC-6.1`–`DC-6.3` — accounts, profiles, and the guest that becomes one.
 *
 * Everything in phase 6 that is about *who somebody is*. Invites are next door
 * because they are about who may come in; this file is about identity, and the
 * one rule it exists to hold is `FR-6.11`:
 *
 *   > The identity referenced by other phases is the durable account identity
 *   > for logged-in users, and the ephemeral one for guests.
 *
 * `resolveAccessToken` is that resolver, and it is the only one. Chat, the world
 * registry and the gateway all read identity through what it returns rather than
 * each deciding for themselves what a token means.
 *
 * ── Not enumerable ──────────────────────────────────────────────────────────
 *
 * For an internal company tool, "does this address have an account" is a staff
 * list. So sign-in answers the same way for an unknown address and a wrong
 * password, spends the same time on both (`PasswordService.burnTime`), and
 * recovery answers 202 whether or not there was anything to send.
 */

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DEFAULT_APPEARANCE,
  appearanceForSeed,
  type AccountDto,
  type AvatarAppearance,
  type MembershipDto,
  type PresenceStatus,
  type ProfileUpdateRequest,
} from '@hubitat/protocol';
import { QueryFailedError, type DataSource, type Repository } from 'typeorm';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import {
  AccountEntity,
  MembershipEntity,
  PasswordResetEntity,
  ProfileEntity,
  SpaceEntity,
} from './auth.entities.js';
import { IdentityBridge, type SessionIdentity } from './identity-bridge.js';
import { InviteRefusal, InviteService } from './invite.service.js';
import { MailerService } from './mailer.service.js';
import { PasswordService } from './password.service.js';
import { SpaceService } from './space.service.js';
import { TokenService, type IssuedSession } from './token.service.js';

/** Postgres unique-violation. Caught rather than pre-checked — see `create`. */
const UNIQUE_VIOLATION = '23505';

/** What the gateway needs to turn a token into a participant (`FR-6.18`). */
export interface ResolvedAccount {
  accountId: string;
  displayName: string;
  appearance: AvatarAppearance;
  statusPreference: PresenceStatus;
  member: boolean;
}

export interface SignedIn {
  session: IssuedSession;
  account: AccountDto;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly config: RuntimeConfig = loadConfig();

  private readonly accounts: Repository<AccountEntity> | null;
  private readonly profiles: Repository<ProfileEntity> | null;
  private readonly memberships: Repository<MembershipEntity> | null;
  private readonly resets: Repository<PasswordResetEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource | null,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly spaces: SpaceService,
    private readonly invites: InviteService,
    private readonly mailer: MailerService,
    private readonly bridge: IdentityBridge,
  ) {
    this.accounts = dataSource ? dataSource.getRepository(AccountEntity) : null;
    this.profiles = dataSource ? dataSource.getRepository(ProfileEntity) : null;
    this.memberships = dataSource ? dataSource.getRepository(MembershipEntity) : null;
    this.resets = dataSource ? dataSource.getRepository(PasswordResetEntity) : null;
  }

  /** False when there is no database. Every route guards on it and answers 503
   *  rather than 500 — "accounts are not available here" is a configuration
   *  fact, not a failure. */
  get enabled(): boolean {
    return this.accounts !== null;
  }

  private require(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(
        'Accounts are not available on this server: it is running without a database. ' +
          'Guests can still enter.',
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-6.1, FR-6.2 — registration and sign-in
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-6.1` — create a local account.
   *
   * The appearance is carried in when there is one: a guest who has spent five
   * minutes on the customizer and then signs up must not be handed a default
   * (`FR-6.7`). Absent, one is derived the same way a new guest's is, so a fresh
   * account is a distinguishable person rather than the same avatar as everybody
   * else who skipped the step.
   */
  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    appearance?: AvatarAppearance;
    inviteCode?: string;
  }): Promise<SignedIn> {
    this.require();

    const complaint = this.passwords.validate(input.password);
    if (complaint) throw new ConflictException(complaint);

    const account = await this.create(input.email, input.password, {
      displayName: input.displayName ?? defaultNameFor(input.email),
      appearance: input.appearance ?? appearanceForEmail(input.email),
    });

    if (input.inviteCode) await this.redeemQuietly(input.inviteCode, account.id);

    return this.signIn(account.id);
  }

  /**
   * `FR-6.2` — the same identity across sessions and devices.
   *
   * One failure message and one timing profile for every way this can fail. The
   * `burnTime` call on the unknown-address path is what makes the second half
   * true: without it the endpoint answers in 2 ms for an address nobody owns and
   * 60 ms for one somebody does, which enumerates the staff list at leisure.
   */
  async login(email: string, password: string): Promise<SignedIn> {
    this.require();

    const account = await this.accounts!.findOne({ where: { email } });
    if (!account) {
      await this.passwords.burnTime();
      throw new UnauthorizedException('That email and password do not match.');
    }

    const ok = await this.passwords.verify(account.passwordHash, password);
    if (!ok) throw new UnauthorizedException('That email and password do not match.');

    // The only moment the plain password is in hand, and therefore the only
    // moment a hash made with weaker parameters can be upgraded. Failure here is
    // not worth refusing a valid sign-in over.
    if (this.passwords.needsRehash(account.passwordHash)) {
      try {
        const upgraded = await this.passwords.hash(password);
        await this.accounts!.update({ id: account.id }, { passwordHash: upgraded });
        this.logger.log(`Re-hashed credentials for ${account.id} at the current parameters.`);
      } catch (error) {
        this.logger.warn(`Could not re-hash credentials: ${(error as Error).message}`);
      }
    }

    return this.signIn(account.id);
  }

  /**
   * `FR-6.7` — a guest becomes an account and keeps their place.
   *
   * The order matters. The guest's current name and appearance are read *first*,
   * from the live session, so they are what the new profile is created with —
   * building the account from the request body and patching it afterwards would
   * leave a window where the profile says something the person never chose.
   *
   * The socket is never touched. This is an HTTP call alongside a live
   * connection, and `bridge.bindSession` rebinds the identity in place and
   * announces it, which is what "must not lose the user's place mid-session"
   * asks for.
   */
  async upgrade(input: {
    email: string;
    password: string;
    resumeToken: string;
    inviteCode?: string;
  }): Promise<SignedIn> {
    this.require();

    const complaint = this.passwords.validate(input.password);
    if (complaint) throw new ConflictException(complaint);

    // Null when the session has gone — a guest who closed the tab mid-form. That
    // is not a failure: they get an ordinary account with an ordinary default,
    // which is better than refusing the registration they just asked for.
    const guest = this.bridge.readGuestSession(input.resumeToken);
    if (!guest) {
      this.logger.debug('Upgrade with no live guest session; registering without carry-over.');
    }

    const account = await this.create(input.email, input.password, {
      displayName: guest?.displayName ?? defaultNameFor(input.email),
      appearance: guest?.appearance ?? appearanceForEmail(input.email),
    });

    if (input.inviteCode) await this.redeemQuietly(input.inviteCode, account.id);

    const signed = await this.signIn(account.id);

    if (guest) {
      const bound = this.bridge.bindSession(guest.sessionId, {
        kind: 'account',
        accountId: account.id,
        member: signed.account.memberships.length > 0,
        displayName: signed.account.displayName,
        appearance: signed.account.appearance,
        statusPreference: signed.account.statusPreference,
      });
      this.logger.log(
        bound
          ? `Guest session ${guest.sessionId} upgraded to account ${account.id} in place.`
          : `Account ${account.id} created, but session ${guest.sessionId} had already gone.`,
      );
    }

    return signed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-6.17 — session lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /** Rotate. Null means the session is over and the client should sign out — see
   *  `TokenService.rotate` for what "over" covers. */
  async refresh(refreshToken: string): Promise<SignedIn | null> {
    if (!this.enabled) return null;

    const session = await this.tokens.rotate(refreshToken);
    if (!session) return null;

    const claims = this.tokens.verifyAccess(session.accessToken);
    if (!claims) return null;

    const account = await this.describe(claims.accountId);
    if (!account) return null;

    return { session, account };
  }

  /** `FR-6.4`. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!this.enabled || !refreshToken) return;
    await this.tokens.revokeFamilyOf(refreshToken);
  }

  /**
   * `FR-6.18` — the resolver the WebSocket handshake runs before joining.
   *
   * Null for a token that does not verify **and** for one that verifies against
   * an account that has since been deleted. The caller refuses the join in both
   * cases rather than downgrading to a guest, because somebody who believes they
   * are signed in must not silently start acting under an identity that
   * evaporates.
   */
  async resolveAccessToken(token: string): Promise<ResolvedAccount | null> {
    if (!this.enabled) return null;

    const claims = this.tokens.verifyAccess(token);
    if (!claims) return null;

    const profile = await this.profiles!.findOne({ where: { accountId: claims.accountId } });
    if (!profile) return null;

    return {
      accountId: claims.accountId,
      displayName: profile.displayName,
      appearance: profile.avatarAppearance,
      statusPreference: profile.statusPreference,
      member: await this.isMember(claims.accountId),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-6.9, FR-6.10 — the profile
  // ───────────────────────────────────────────────────────────────────────────

  /** Null when the account has gone. Callers on an authenticated path treat that
   *  as an expired session rather than a 404 — the token outlived its subject. */
  async describe(accountId: string): Promise<AccountDto | null> {
    if (!this.enabled) return null;

    const account = await this.accounts!.findOne({ where: { id: accountId } });
    const profile = await this.profiles!.findOne({ where: { accountId } });
    if (!account || !profile) return null;

    return {
      id: account.id,
      email: account.email,
      displayName: profile.displayName,
      appearance: profile.avatarAppearance,
      statusPreference: profile.statusPreference,
      memberships: await this.membershipsOf(accountId),
    };
  }

  /**
   * `FR-6.10` — persist, and reflect it now rather than "next time".
   *
   * The requirement's floor is that a change survives to the next appearance.
   * Pushing it to any live session the account already has costs one call
   * through the bridge and means somebody who renames themselves in the account
   * panel watches their own nameplate change, which is the behaviour phase 4
   * established for appearance and there is no reason to regress it here.
   */
  async updateProfile(accountId: string, patch: ProfileUpdateRequest): Promise<AccountDto> {
    this.require();

    await this.profiles!.update(
      { accountId },
      {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.appearance !== undefined ? { avatarAppearance: patch.appearance } : {}),
        ...(patch.statusPreference !== undefined
          ? { statusPreference: patch.statusPreference }
          : {}),
      },
    );

    const account = await this.describe(accountId);
    if (!account) throw new UnauthorizedException('That account no longer exists.');

    this.bridge.refreshAccountSessions(accountId, {
      kind: 'account',
      accountId,
      member: account.memberships.length > 0,
      displayName: account.displayName,
      appearance: account.appearance,
      statusPreference: account.statusPreference,
    });

    return account;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-6.5 — recovery
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Always succeeds from the caller's point of view.
   *
   * An unknown address, a disabled relay and a successful send are one response,
   * because the alternative is an endpoint that reports whether an address has
   * an account here. The operator learns about a disabled relay from the boot
   * warning and from the log line in `MailerService`.
   */
  async requestPasswordReset(email: string, resetUrlBase: string): Promise<void> {
    if (!this.enabled) return;

    const account = await this.accounts!.findOne({ where: { email } });
    if (!account) {
      this.logger.debug('Password reset requested for an address with no account; ignoring.');
      return;
    }

    const token = TokenService.mintOpaque();
    await this.resets!.insert({
      tokenHash: TokenService.digestOf(token),
      accountId: account.id,
      expiresAt: new Date(Date.now() + this.config.resetTokenTtlMin * 60 * 1000),
      usedAt: null,
    });

    const url = `${resetUrlBase.replace(/\/+$/, '')}/?reset=${token}`;
    await this.mailer.sendPasswordReset(account.email, url, this.config.resetTokenTtlMin);
  }

  /**
   * Single-use, expiring, and it ends every other session.
   *
   * Revoking all refresh families is the part that is easy to leave out and is
   * the reason people reset passwords: they believe somebody else has the old
   * one. Leaving that somebody's sessions alive makes the reset ceremonial.
   */
  async confirmPasswordReset(token: string, password: string): Promise<void> {
    this.require();

    const complaint = this.passwords.validate(password);
    if (complaint) throw new ConflictException(complaint);

    const row = await this.resets!.findOne({
      where: { tokenHash: TokenService.digestOf(token) },
    });

    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(
        'That reset link is no longer valid. Links work once and expire; ask for a new one.',
      );
    }

    const hash = await this.passwords.hash(password);
    await this.dataSource!.transaction(async (manager) => {
      await manager.update(AccountEntity, { id: row.accountId }, { passwordHash: hash });
      await manager.update(
        PasswordResetEntity,
        { tokenHash: row.tokenHash },
        { usedAt: new Date() },
      );
    });

    await this.tokens.revokeAllFor(row.accountId);
    this.logger.log(`Password reset for account ${row.accountId}; all sessions revoked.`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Membership
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The address on an account, for the phase 7 allowlist (`FR-7.13`).
   *
   * A narrow read rather than `describe`, because it runs on the join path: the
   * allowlist check needs one column, and `describe` would fetch a profile and
   * every membership to get it. Null when the account has gone, which the caller
   * treats as "not on the list" — the safe answer for an identity that no longer
   * exists.
   */
  async emailOf(accountId: string): Promise<string | null> {
    if (!this.enabled) return null;
    const account = await this.accounts!.findOne({
      where: { id: accountId },
      select: { email: true },
    });
    return account?.email ?? null;
  }

  /** `FR-6.15` — durable, so a returning member needs no new invite. */
  async isMember(accountId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const space = await this.spaces.current();
    if (!space) return false;
    const count = await this.memberships!.count({ where: { accountId, spaceId: space.id } });
    return count > 0;
  }

  /** `FR-6.16` — an account may hold many, and they travel with it. */
  async membershipsOf(accountId: string): Promise<MembershipDto[]> {
    if (!this.enabled) return [];

    const rows = await this.memberships!.find({
      where: { accountId },
      relations: { space: true },
      order: { joinedAt: 'ASC' },
    });

    return rows
      .filter((row): row is MembershipEntity & { space: SpaceEntity } => row.space !== undefined)
      .map((row) => ({
        spaceId: row.spaceId,
        spaceSlug: row.space.slug,
        spaceName: row.space.name,
        joinedAt: row.joinedAt.toISOString(),
      }));
  }

  /**
   * Grant membership without an invite.
   *
   * Used by the first account on an empty Space, which would otherwise have
   * nobody able to create the first invite — a Space that requires accounts and
   * has none is a locked door with the key inside. Everything after that goes
   * through `InviteService.redeem`.
   */
  async grantFoundingMembership(accountId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const space = await this.spaces.current();
    if (!space) return false;

    const existing = await this.memberships!.count({ where: { spaceId: space.id } });
    if (existing > 0) return false;

    await this.memberships!.insert({ accountId, spaceId: space.id, inviteId: null });
    this.logger.log(
      `Account ${accountId} is the first member of space "${space.slug}" and was admitted ` +
        `without an invite — there was nobody to issue one.`,
    );
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Insert and let the unique index decide, rather than checking first.
   *
   * A `SELECT` then an `INSERT` is a check-then-act: two registrations for the
   * same address in the same instant both pass the check, and the second one
   * fails with a 500 instead of "that address is already registered". The
   * constraint is the only thing that can actually adjudicate, so it does.
   */
  private async create(
    email: string,
    password: string,
    profile: { displayName: string; appearance: AvatarAppearance },
  ): Promise<AccountEntity> {
    const passwordHash = await this.passwords.hash(password);

    try {
      return await this.dataSource!.transaction(async (manager) => {
        const account = await manager.save(manager.create(AccountEntity, { email, passwordHash }));
        await manager.insert(ProfileEntity, {
          accountId: account.id,
          displayName: profile.displayName,
          avatarAppearance: profile.appearance,
          statusPreference: 'available',
        });
        return account;
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === UNIQUE_VIOLATION
      ) {
        throw new ConflictException('That email address already has an account. Sign in instead.');
      }
      throw error;
    }
  }

  private async signIn(accountId: string): Promise<SignedIn> {
    // The empty-Space case. Checked on every sign-in rather than only at
    // registration, because a Space can be emptied and would otherwise have no
    // path back to having a member.
    await this.grantFoundingMembership(accountId);

    const account = await this.describe(accountId);
    if (!account) throw new UnauthorizedException('That account no longer exists.');

    return { session: await this.tokens.startSession(accountId), account };
  }

  /**
   * Redeem an invite that arrived alongside a registration.
   *
   * A bad code does **not** undo the account. Somebody who followed a stale link
   * and typed a password has still created the account they asked for, and
   * telling them "registration failed" would leave them unable to try again with
   * the address they just used. The refusal is logged and they arrive as a
   * non-member, which the client can then act on with a fresh invite.
   */
  private async redeemQuietly(code: string, accountId: string): Promise<void> {
    try {
      await this.invites.redeem(code, accountId);
    } catch (error) {
      if (error instanceof InviteRefusal) {
        this.logger.warn(
          `Account ${accountId} registered with invite ${code}, which was ${error.reason}. ` +
            `The account exists; they are not a member.`,
        );
        return;
      }
      throw error;
    }
  }
}

/** The local part, which is a better first guess at a name than "Guest 4821"
 *  and is immediately editable in the account panel. */
function defaultNameFor(email: string): string {
  const local = email.split('@')[0] ?? 'member';
  return local.slice(0, 32) || 'member';
}

/**
 * A distinct-looking avatar for an account that offered none.
 *
 * Seeded from the address rather than from a counter, so the same person gets
 * the same starting look on a re-registration and two accounts created in the
 * same second do not collide on a shared sequence. `DEFAULT_APPEARANCE` is the
 * fallback if the catalogue ever has nothing to give.
 */
function appearanceForEmail(email: string): AvatarAppearance {
  let seed = 0;
  for (let i = 0; i < email.length; i++) seed = (seed * 31 + email.charCodeAt(i)) % 0xffff;
  return appearanceForSeed(seed || 1) ?? DEFAULT_APPEARANCE;
}
