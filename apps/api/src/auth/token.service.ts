/**
 * `DC-6.6 Auth Session` — `FR-6.17`, `FR-6.18`, ADR 0011.
 *
 * Two credentials with two jobs:
 *
 *   **Access token** — a signed JWT, fifteen minutes, held in the client's
 *   memory and never in `localStorage`. Stateless on purpose: it is checked on
 *   every HTTP request and on every WebSocket handshake, and a database read per
 *   check is the cost ADR 0011 rejected server-side sessions to avoid.
 *
 *   **Refresh token** — 256 bits of `randomBytes`, opaque, stored as a SHA-256
 *   digest, delivered in an `httpOnly` cookie and **rotated on every use**.
 *
 * ── The part that is easy to get wrong ──────────────────────────────────────
 *
 * Rotation without reuse detection is theatre. If a rotated token stays valid
 * after being exchanged, a stolen copy works alongside the legitimate one for
 * its full lifetime and nothing ever notices. So a *second* presentation of a
 * consumed token revokes the entire family — every token descended from that
 * one sign-in. The legitimate holder is signed out too, which is the point: one
 * of the two parties holding that token is a thief, and the server cannot tell
 * which, so it ends the session for both and lets the real owner sign in again.
 *
 * ── Why not `@nestjs/passport` ──────────────────────────────────────────────
 *
 * The Phase 6 implementation notes suggest it, and they are explicitly
 * non-normative. Passport's guards live in the HTTP pipeline, and `FR-6.18`
 * requires the same token to be resolved during a **WebSocket handshake**, which
 * that pipeline never touches. Rather than a passport strategy for HTTP and a
 * hand-rolled verifier for the socket — two implementations of one rule, which
 * is the shape every drift in this codebase has come from — there is one
 * `verifyAccess` and both callers use it.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsNull, LessThan, type DataSource, type Repository } from 'typeorm';
import { TUNING } from '@hubitat/protocol';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import { RefreshTokenEntity } from './auth.entities.js';

/** What a valid access token resolves to. Deliberately tiny: an identity and
 *  nothing that could go stale between issue and use. */
export interface AccessClaims {
  accountId: string;
  /** Which sign-in this token belongs to, so a revoked family can be recognised
   *  if a future phase decides to check. Phase 6 does not — the fifteen-minute
   *  lifetime *is* the revocation window (ADR 0011). */
  familyId: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresInSeconds: number;
  /** The raw refresh token. Written to the cookie and then forgotten — only its
   *  digest is stored, so this is the last moment it exists in this process. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** SHA-256, not argon2. The input is 256 bits of CSPRNG output: there is no
 *  guessable structure for a slow hash to defend, and a slow hash on the refresh
 *  path would cost 50 ms on every request the client makes after an expiry. */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * How long after a refresh token is spent a second presentation is read as a
 * race rather than as theft. See the long note in `rotate`.
 *
 * From `TUNING` rather than a literal here, so the harness can assert both sides
 * of the window against the same number the server uses. It is the one value in
 * `TUNING` with no environment variable behind it — see its comment there.
 */
const REUSE_LEEWAY_MS = TUNING.REFRESH_REUSE_LEEWAY_MS;

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly config: RuntimeConfig = loadConfig();
  private readonly secret: string;
  private readonly jwt = new JwtService();
  private readonly refreshTokens: Repository<RefreshTokenEntity> | null;

  constructor(@Inject(DATA_SOURCE) dataSource: DataSource | null) {
    this.refreshTokens = dataSource ? dataSource.getRepository(RefreshTokenEntity) : null;

    // An unset secret is legal and generates one, so `npm run dev` needs no
    // ceremony. `configWarnings` says so at boot, because the symptom of a
    // restart — everybody signed out at once — reads as a session bug rather
    // than as a missing variable.
    this.secret = this.config.authJwtSecret || randomBytes(48).toString('base64url');
  }

  get accessTtlSeconds(): number {
    return this.config.accessTokenTtlMin * 60;
  }

  get refreshTtlMs(): number {
    return this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Access tokens
  // ───────────────────────────────────────────────────────────────────────────

  signAccess(claims: AccessClaims): string {
    return this.jwt.sign(
      { sub: claims.accountId, fam: claims.familyId },
      { secret: this.secret, expiresIn: this.accessTtlSeconds },
    );
  }

  /**
   * Null for anything that does not verify — expired, tampered, or signed by a
   * key this process does not have (which is what a restart without
   * `AUTH_JWT_SECRET` produces for every token issued before it).
   *
   * Never throws. Both callers are on paths where an exception would be a 500
   * for what is an ordinary, expected outcome: tokens expire.
   */
  verifyAccess(token: string): AccessClaims | null {
    try {
      const payload = this.jwt.verify<{ sub?: string; fam?: string }>(token, {
        secret: this.secret,
      });
      if (!payload.sub || !payload.fam) return null;
      return { accountId: payload.sub, familyId: payload.fam };
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Refresh tokens
  // ───────────────────────────────────────────────────────────────────────────

  /** A brand-new family — one sign-in, one registration, or one guest upgrade. */
  async startSession(accountId: string): Promise<IssuedSession> {
    return this.issue(accountId, randomUUID());
  }

  /**
   * Exchange a refresh token for a new one — `FR-6.17`.
   *
   * Returns null for anything that should end the session, and the *reasons* are
   * not equivalent:
   *
   *   - unknown digest → never existed, or the family was pruned. Nothing to do.
   *   - already consumed → **reuse**. The family is revoked, here, immediately.
   *   - revoked or expired → the session is over.
   *
   * The whole exchange runs in one transaction with `SELECT ... FOR UPDATE` on
   * the row. Two tabs refreshing in the same instant is ordinary — one of them
   * loses the race, and without the lock both would be handed valid successors
   * from the same parent, which is the fork this design exists to prevent.
   */
  async rotate(refreshToken: string): Promise<IssuedSession | null> {
    if (!this.refreshTokens) return null;
    const hash = digest(refreshToken);

    const outcome = await this.refreshTokens.manager.transaction(async (manager) => {
      const rows = await manager.query<
        {
          id: string;
          account_id: string;
          family_id: string;
          expires_at: Date;
          consumed_at: Date | null;
          revoked_at: Date | null;
        }[]
      >(
        `SELECT "id", "account_id", "family_id", "expires_at", "consumed_at", "revoked_at"
           FROM "refresh_tokens"
          WHERE "token_hash" = $1
          FOR UPDATE`,
        [hash],
      );

      const row = rows[0];
      if (!row) return null;

      if (row.consumed_at !== null) {
        /**
         * A consumed token, presented again. Two very different things look
         * identical here, and the age of the consumption is what separates them.
         *
         * **Within the leeway window** it is almost always one client racing
         * itself. Two tabs restored at the same instant both read the same
         * cookie out of the shared jar and both refresh; the second one arrives
         * before the browser has stored the first one's `Set-Cookie`. Revoking
         * there would sign somebody out of both tabs for opening two tabs, which
         * breaks `FR-6.17` in the ordinary case in the name of an attack that is
         * not happening. So the family survives and a fresh token is issued into
         * it — whichever response lands last wins the cookie, and the other tab's
         * access token is valid for its full fifteen minutes either way.
         *
         * **Outside it**, a token that was spent minutes or hours ago is being
         * presented by somebody who should not have it. That is the signal ADR
         * 0011 exists for, and the whole family dies — including the legitimate
         * holder's, because one of the two parties is a thief and the server
         * cannot tell which.
         *
         * The cost is stated plainly: a thief who replays a stolen token inside
         * the same few seconds as its real owner is not caught. That window is
         * far narrower than the alternative, which is having no rotation at all
         * because it made the product unusable with two tabs.
         */
        const consumedMsAgo = Date.now() - row.consumed_at.getTime();
        if (consumedMsAgo <= REUSE_LEEWAY_MS && row.revoked_at === null) {
          this.logger.debug(
            `Refresh token re-presented ${consumedMsAgo} ms after use; treating it as a ` +
              `concurrent client rather than reuse.`,
          );
          return { reuse: false, accountId: row.account_id, familyId: row.family_id };
        }

        // The theft signal. Everything in this family dies, including whatever
        // the legitimate holder is currently using — see above.
        await manager.query(
          `UPDATE "refresh_tokens"
              SET "revoked_at" = now()
            WHERE "family_id" = $1 AND "revoked_at" IS NULL`,
          [row.family_id],
        );
        return { reuse: true, accountId: row.account_id, familyId: row.family_id };
      }

      if (row.revoked_at !== null || row.expires_at.getTime() <= Date.now()) return null;

      await manager.query(`UPDATE "refresh_tokens" SET "consumed_at" = now() WHERE "id" = $1`, [
        row.id,
      ]);

      return { reuse: false, accountId: row.account_id, familyId: row.family_id };
    });

    if (!outcome) return null;

    if (outcome.reuse) {
      this.logger.warn(
        `Refresh token reuse detected for account ${outcome.accountId}; family ` +
          `${outcome.familyId} revoked. Someone is holding a token they should not have, ` +
          `or a client is retrying a consumed one.`,
      );
      return null;
    }

    // Same family, so a session survives many rotations and logout still ends
    // all of it in one statement.
    return this.issue(outcome.accountId, outcome.familyId);
  }

  /** `FR-6.4` — end this sign-in. The family, not the row: the token being
   *  presented is one link in a chain, and revoking only it would leave every
   *  earlier unconsumed link alive. */
  async revokeFamilyOf(refreshToken: string): Promise<void> {
    if (!this.refreshTokens) return;
    await this.refreshTokens.query(
      `UPDATE "refresh_tokens"
          SET "revoked_at" = now()
        WHERE "revoked_at" IS NULL
          AND "family_id" = (SELECT "family_id" FROM "refresh_tokens" WHERE "token_hash" = $1)`,
      [digest(refreshToken)],
    );
  }

  /**
   * Every session this account has anywhere.
   *
   * Used by password reset, and that is not optional: the reason somebody resets
   * a password is usually that they believe someone else has it, and leaving
   * that someone's existing sessions alive makes the reset ceremonial.
   */
  async revokeAllFor(accountId: string): Promise<void> {
    if (!this.refreshTokens) return;
    await this.refreshTokens.update({ accountId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /**
   * Drop rows nobody can present any more.
   *
   * Consumed and revoked rows are kept until they expire rather than deleted on
   * the spot, because a deleted row cannot be recognised as reuse — it reads as
   * "unknown token", which is the quiet outcome instead of the loud one. After
   * expiry there is nothing left to detect.
   */
  async pruneExpired(): Promise<number> {
    if (!this.refreshTokens) return 0;
    const result = await this.refreshTokens.delete({ expiresAt: LessThan(new Date()) });
    return result.affected ?? 0;
  }

  /**
   * Constant-time comparison for anything that arrives from a client and is
   * matched against a stored secret.
   *
   * Used for the reset token, whose lookup is by digest and therefore already
   * constant-time in the database — this covers the one place a plain `===`
   * would otherwise creep in.
   */
  static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  /** Opaque, URL-safe, and long enough that guessing is not a strategy. */
  static mintOpaque(): string {
    return randomBytes(32).toString('base64url');
  }

  static digestOf(token: string): string {
    return digest(token);
  }

  private async issue(accountId: string, familyId: string): Promise<IssuedSession> {
    const refreshToken = TokenService.mintOpaque();
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlMs);

    if (this.refreshTokens) {
      await this.refreshTokens.insert({
        tokenHash: digest(refreshToken),
        accountId,
        familyId,
        expiresAt: refreshExpiresAt,
        consumedAt: null,
        revokedAt: null,
      });
    }

    return {
      accessToken: this.signAccess({ accountId, familyId }),
      expiresInSeconds: this.accessTtlSeconds,
      refreshToken,
      refreshExpiresAt,
    };
  }
}
