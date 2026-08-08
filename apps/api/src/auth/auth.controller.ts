/**
 * `POST /auth/*` — phase 6, `FR-6.1`–`FR-6.5`, `FR-6.10`, `FR-6.17`.
 *
 * ── Where the two credentials go, and why ───────────────────────────────────
 *
 * The **access token** is in the response body. It goes into the client's memory
 * and never into `localStorage`, so a script injected into the page has no store
 * to read it out of after the fact.
 *
 * The **refresh token** is in an `httpOnly` cookie, which JavaScript cannot read
 * at all — including the attacker's. Scoped to `/auth`, so it is not attached to
 * the hundreds of other requests a session makes and cannot leak through one of
 * them. `SameSite=Lax` by default, which is correct while the client and the api
 * share a registrable domain (including `localhost:5173` → `localhost:3000`,
 * same-site despite being cross-origin).
 *
 * ADR 0011 in one sentence: neither credential is useful alone for long — the
 * access token expires in fifteen minutes, and the refresh token is rotated and
 * detected on reuse.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  loginRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  profileUpdateRequestSchema,
  registerRequestSchema,
  upgradeRequestSchema,
  type AccountDto,
  type AuthConfigDto,
  type AuthSessionDto,
  type LoginRequest,
  type PasswordResetConfirmRequest,
  type PasswordResetRequest,
  type ProfileUpdateRequest,
  type RegisterRequest,
  type UpgradeRequest,
} from '@hubitat/protocol';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { AccountService, type SignedIn } from './account.service.js';
import { AccessTokenGuard, CurrentAccount } from './auth.guard.js';
import { MailerService } from './mailer.service.js';
import { PasswordService } from './password.service.js';
import { SpaceService } from './space.service.js';
import { ZodBody } from './zod.pipe.js';

/**
 * Scoped to `/auth`, so the browser attaches it to five endpoints instead of to
 * every request the application makes. A cookie sent everywhere is a cookie with
 * many more chances to end up in a log.
 */
const REFRESH_COOKIE = 'hubitat_refresh';
const REFRESH_COOKIE_PATH = '/auth';

@Controller('auth')
export class AuthController {
  /** Named `runtime` rather than `config` because `GET /auth/config` below is a
   *  handler called `config`, and a field and a method cannot share a name. */
  private readonly runtime: RuntimeConfig = loadConfig();

  constructor(
    private readonly accounts: AccountService,
    private readonly passwords: PasswordService,
    private readonly spaces: SpaceService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Everything the entry screen must know **before** anybody connects.
   *
   * Unauthenticated by necessity — it is what tells a first-time visitor whether
   * there is a sign-in form to show at all — and it says nothing an unauthorised
   * caller could not learn by trying to enter.
   */
  @Get('config')
  async config(): Promise<AuthConfigDto> {
    const space = await this.spaces.current();
    return {
      accountsEnabled: this.accounts.enabled,
      // FR-6.8. True with no database, because a server with no accounts and no
      // guests is a server nobody can use — see SpaceService.allowsGuests.
      allowGuests: await this.spaces.allowsGuests(),
      passwordMinLength: this.passwords.minLength,
      passwordResetEnabled: this.mailer.enabled && this.accounts.enabled,
      spaceSlug: space?.slug ?? this.runtime.spaceSlug,
      spaceName: space?.name ?? this.runtime.spaceName,
      // Phase 7. Both are policy facts a first-time visitor needs *before* the
      // entry form renders, for the same reason `allowGuests` is here: a client
      // that guessed would take a name and a click before the server said no.
      // Neither discloses anything an attempted join would not — and the
      // password itself is never on this route (`FR-7.12`), only that one is
      // wanted.
      spacePasswordRequired: Boolean(space?.accessPasswordHash),
      spaceLocked: space?.locked ?? false,
    };
  }

  /** `FR-6.1`. */
  @Post('register')
  async register(
    @Body(new ZodBody(registerRequestSchema)) body: RegisterRequest,
    @Res({ passthrough: true }) response: Response,
    @Req() request: Request,
  ): Promise<AuthSessionDto> {
    const signed = await this.accounts.register(body);
    return this.completeSignIn(signed, response, request);
  }

  /** `FR-6.2`. */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodBody(loginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
    @Req() request: Request,
  ): Promise<AuthSessionDto> {
    const signed = await this.accounts.login(body.email, body.password);
    return this.completeSignIn(signed, response, request);
  }

  /**
   * `FR-6.7` — a guest becomes an account without dropping the socket.
   *
   * Its own endpoint rather than a flag on `register`, because the two differ in
   * what they are allowed to take from a live session and therefore in what they
   * have to prove: this one requires a resume token.
   */
  @Post('upgrade')
  async upgrade(
    @Body(new ZodBody(upgradeRequestSchema)) body: UpgradeRequest,
    @Res({ passthrough: true }) response: Response,
    @Req() request: Request,
  ): Promise<AuthSessionDto> {
    const signed = await this.accounts.upgrade(body);
    return this.completeSignIn(signed, response, request);
  }

  /**
   * `FR-6.17` — rotate, and hand back a fresh access token.
   *
   * 200 with a new session, or 401 with the cookie cleared. There is no third
   * answer: a refresh that cannot succeed means the session is over, and leaving
   * a dead cookie in place would make the client retry it forever — and, because
   * a consumed token presented twice is the theft signal, would make its own
   * retries look like an attack.
   */
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionDto> {
    const token = readRefreshCookie(request);
    const signed = token ? await this.accounts.refresh(token) : null;

    if (!signed) {
      this.clearRefreshCookie(response, request);
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }

    return this.completeSignIn(signed, response, request);
  }

  /** `FR-6.4` — revokes the whole family, not just the token presented. */
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.accounts.logout(readRefreshCookie(request));
    this.clearRefreshCookie(response, request);
  }

  /** `FR-6.9` — the profile, its appearance, and every Space it belongs to. */
  @Get('me')
  @UseGuards(AccessTokenGuard)
  async me(@CurrentAccount() account: { accountId: string }): Promise<AccountDto> {
    const described = await this.accounts.describe(account.accountId);
    if (!described) throw new UnauthorizedException('That account no longer exists.');
    return described;
  }

  /** `FR-6.10`. */
  @Patch('me')
  @UseGuards(AccessTokenGuard)
  async updateProfile(
    @CurrentAccount() account: { accountId: string },
    @Body(new ZodBody(profileUpdateRequestSchema)) body: ProfileUpdateRequest,
  ): Promise<AccountDto> {
    return this.accounts.updateProfile(account.accountId, body);
  }

  /**
   * `FR-6.5` — ask for a reset link.
   *
   * 202 for every address, always. An unknown address, a disabled relay and a
   * successful send are indistinguishable from out here, because the alternative
   * is an endpoint that reports whether somebody has an account — which for an
   * internal tool is a staff list.
   */
  @Post('password-reset/request')
  @HttpCode(202)
  async requestReset(
    @Body(new ZodBody(passwordResetRequestSchema)) body: PasswordResetRequest,
    @Req() request: Request,
  ): Promise<{ accepted: true }> {
    if (this.accounts.enabled) {
      await this.accounts.requestPasswordReset(body.email, this.publicBaseUrl(request));
    }
    return { accepted: true };
  }

  /** `FR-6.5` — single-use, expiring, and it ends every other session. */
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmReset(
    @Body(new ZodBody(passwordResetConfirmSchema)) body: PasswordResetConfirmRequest,
    @Res({ passthrough: true }) response: Response,
    @Req() request: Request,
  ): Promise<void> {
    await this.accounts.confirmPasswordReset(body.token, body.password);
    // Every family for that account was just revoked, including whichever one
    // this browser is holding. Leaving the cookie would mean the next refresh
    // presents a revoked token and gets a 401 that reads as a bug.
    this.clearRefreshCookie(response, request);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Set the cookie, return the body. The one place a session becomes visible to
   *  a client, so the two halves cannot get out of step. */
  private completeSignIn(signed: SignedIn, response: Response, request: Request): AuthSessionDto {
    response.cookie(REFRESH_COOKIE, signed.session.refreshToken, {
      httpOnly: true,
      secure: this.cookieSecure(request),
      sameSite: this.runtime.authCookieSameSite,
      path: REFRESH_COOKIE_PATH,
      expires: signed.session.refreshExpiresAt,
    });

    return {
      accessToken: signed.session.accessToken,
      expiresInSeconds: signed.session.expiresInSeconds,
      account: signed.account,
    };
  }

  /**
   * Cleared with the *same* attributes it was set with.
   *
   * A browser matches a clearing cookie on name, path, domain and `Secure` — get
   * any of them wrong and the old cookie survives untouched, so the client keeps
   * presenting a revoked token and every refresh 401s. That failure looks
   * exactly like a broken session and has nothing to do with sessions.
   */
  private clearRefreshCookie(response: Response, request: Request): void {
    response.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.cookieSecure(request),
      sameSite: this.runtime.authCookieSameSite,
      path: REFRESH_COOKIE_PATH,
    });
  }

  /**
   * `auto` reads the connection; the explicit settings override it.
   *
   * Neither fixed answer is right everywhere. Always-on silently drops the
   * cookie on plain HTTP against a LAN address, so sign-in appears to work and
   * the first refresh fails. Always-off would put a bearer credential on the
   * wire in cleartext. `x-forwarded-proto` is read because the deployment target
   * is Compose behind a proxy, where `req.secure` is false on a TLS request.
   */
  private cookieSecure(request: Request): boolean {
    if (this.runtime.authCookieSecure === 'true') return true;
    if (this.runtime.authCookieSecure === 'false') return false;
    if (this.runtime.authCookieSameSite === 'none') return true;
    return request.secure || request.headers['x-forwarded-proto'] === 'https';
  }

  /** `PUBLIC_WEB_URL` when set, otherwise the request's own origin — which is
   *  what makes reset links work behind a tunnel whose name nobody knew at boot. */
  private publicBaseUrl(request: Request): string {
    if (this.runtime.publicWebUrl) return this.runtime.publicWebUrl;
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) return origin;
    const proto = (request.headers['x-forwarded-proto'] as string) ?? request.protocol;
    return `${proto}://${request.headers.host ?? 'localhost'}`;
  }
}

/**
 * The refresh cookie, or undefined.
 *
 * `cookie-parser` populates `request.cookies`; the cast keeps this readable
 * without pulling its type augmentation into every file that touches a request.
 */
function readRefreshCookie(request: Request): string | undefined {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE];
}

/** Exported so anything that needs to name the cookie — a future admin route, a
 *  test — does not spell it a second time. */
export { REFRESH_COOKIE, REFRESH_COOKIE_PATH };
