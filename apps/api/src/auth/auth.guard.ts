/**
 * Bearer-token authentication for HTTP routes — `FR-6.2`, `NFR-31`.
 *
 * The counterpart to what the gateway does in the WebSocket handshake, and
 * deliberately the *same* verification: both go through
 * `AccountService.resolveAccessToken`. `NFR-34` will require authorization on
 * both paths from Phase 7, and two verifiers would be two places for that to be
 * subtly different.
 *
 * ── Why a plain guard and not `@nestjs/passport` ────────────────────────────
 *
 * The non-normative Phase 6 notes suggest passport. Its strategies only run
 * inside the HTTP pipeline, which the WebSocket upgrade never enters, so
 * adopting it would mean a passport strategy here and a hand-written verifier
 * there. See the header of `token.service.ts`.
 */

import {
  createParamDecorator,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccountService, type ResolvedAccount } from './account.service.js';

/** Where the guard leaves what it resolved. Read by `@CurrentAccount`. */
export interface AuthenticatedRequest extends Request {
  account?: ResolvedAccount;
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly accounts: AccountService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Sign in to do that.');
    }

    const account = await this.accounts.resolveAccessToken(header.slice('Bearer '.length).trim());
    if (!account) {
      // 401 and not 403, because the client's correct response is to refresh and
      // retry — which is what makes a fifteen-minute token survivable. A 403
      // would tell it to give up on a session that is simply due for a rotation.
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }

    request.account = account;
    return true;
  }
}

/** The account the guard resolved. Only ever valid behind `AccessTokenGuard`. */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedAccount => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.account) {
      // Reachable only by putting this decorator on an unguarded route, which is
      // a programming error rather than a request problem — and one that would
      // otherwise present as `undefined.accountId` deep inside a service.
      throw new UnauthorizedException('Sign in to do that.');
    }
    return request.account;
  },
);
