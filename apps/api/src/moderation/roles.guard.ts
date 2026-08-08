/**
 * `FR-7.4` on the HTTP path — and half of `NFR-34`.
 *
 * The other half is in `world.gateway.ts`, and the pair is the requirement:
 *
 *   > From Phase 7, authorization is enforced on **both** HTTP and WebSocket
 *   > paths. A capability hidden in the UI is not enforced.
 *
 * Both halves ask `hasCapability` from `@hubitat/protocol` about the same matrix.
 * There is no second copy of the rules on either side, because the failure this
 * phase is most likely to ship — the Phase 7 notes say so outright — is one
 * transport being guarded and the other not.
 *
 * ── Why the role is resolved here and not carried on the token ──────────────
 *
 * An access token lives for fifteen minutes (`ACCESS_TOKEN_TTL_MIN`). A role
 * baked into it would keep working for fifteen minutes after it was revoked,
 * which makes a demotion advisory — and the whole point of `FR-7.3` is that it is
 * not. So the role is read from `memberships` on every guarded request. That is
 * one indexed lookup on a path that already did several, against a window in
 * which a removed admin can still act.
 */

import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasCapability, type Capability, type Role } from '@hubitat/protocol';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { RolesService } from '../auth/roles.service.js';

const CAPABILITY_KEY = 'hubitat:capability';

/**
 * What a route needs. Read by `RolesGuard`, which must be listed **after**
 * `AccessTokenGuard` on the route — the account has to be resolved before there
 * is anything to look a role up for.
 */
export const RequireCapability = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, capability);

/** Where the guard leaves what it resolved, so a handler can record the actor's
 *  role in the audit entry without asking a second time. */
export interface RoleAwareRequest extends AuthenticatedRequest {
  role?: Role;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roles: RolesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Capability | undefined>(CAPABILITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RoleAwareRequest>();
    if (!request.account) {
      // Reachable only by putting this guard on a route without
      // `AccessTokenGuard` in front of it, which is a programming error rather
      // than a request problem — and one that would otherwise present as
      // everybody being a guest.
      throw new UnauthorizedException('Sign in to do that.');
    }

    const role = await this.roles.roleOf(request.account.accountId);
    request.role = role;

    // No decorator means "any signed-in account", which several read routes
    // legitimately are. The guard still runs, because resolving the role is what
    // the handler needs even when nothing is being gated.
    if (!required) return true;

    if (!hasCapability(role, required)) {
      // 403 and not 404: the Phase 7 Rules require an attempt to be *refused*,
      // and http-api.md is explicit that 403 means "authenticated, and not
      // allowed — retrying will not help". A 404 would also be a worse answer
      // for a different reason: it would tell an ordinary member that the
      // moderation surface does not exist, which is untrue and unhelpful.
      throw new ForbiddenException(refusal(role, required));
    }

    return true;
  }
}

/**
 * The sentence a refused caller reads.
 *
 * Names the role they hold rather than the capability they lack, because
 * "admins can do that, you are a member" is actionable and "you lack
 * `manage-access`" is a permission string leaking into a person's day.
 */
function refusal(role: Role, capability: Capability): string {
  const needed =
    capability === 'manage-roles' || capability === 'transfer-ownership' ? 'the owner' : 'an admin';
  return `Only ${needed} can do that. You are ${role === 'guest' ? 'not a member of' : `a ${role} in`} this space.`;
}
