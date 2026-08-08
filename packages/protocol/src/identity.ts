/**
 * Who somebody is, durably — phase 6, `FR-6.11`.
 *
 * Its own module, and not part of `auth.ts`, for a mechanical reason: the
 * `JOINED` frame in `messages.ts` carries an identity, and `auth.ts` needs the
 * avatar and status schemas that live in `messages.ts`. Putting these three
 * functions in either file would make the two import each other, and both
 * evaluate Zod schemas at module load — an import cycle there is not a style
 * problem, it is a `undefined is not a function` at boot.
 *
 * Everything here is pure string work so the browser, the server and the bots
 * derive identical values (ADR 0001).
 */

import { z } from 'zod';

/**
 * `DC-6.1` / `DC-6.3` — which kind of identity is behind a participant.
 *
 * The whole of `FR-6.11` in one field. Everything that needs to know "is this
 * durable" asks this rather than inferring it from the presence of an account
 * id, because inferring it is how a call site ends up reading an absent id as
 * "not loaded yet" when it means "this is a guest".
 */
export const identityKindSchema = z.enum(['guest', 'account']);
export type IdentityKind = z.infer<typeof identityKindSchema>;

/**
 * The identity string used wherever another phase stores "who".
 *
 * Prefixed, so an account id and a session id can never collide in a column that
 * holds both. `messages.sender_session_id` and `read_state.identity` hold exactly
 * this from phase 6 onward, which is what the Phase 5 note meant by "the tables
 * do not change shape; what goes in the identity columns does".
 */
export function accountIdentity(accountId: string): string {
  return `acct:${accountId}`;
}

/**
 * A guest's identity: session-scoped, and gone when the session is.
 *
 * Prefixed like the durable one rather than left bare, so that a row written
 * before phase 6 (a raw session UUID) is visibly distinguishable from one
 * written after. There is no migration of old rows: a guest identity that no
 * longer exists cannot be resolved to anything either way.
 */
export function guestIdentity(sessionId: string): string {
  return `guest:${sessionId}`;
}

/** True for an identity that outlives the session that produced it. */
export function isDurableIdentity(identity: string): boolean {
  return identity.startsWith('acct:');
}
