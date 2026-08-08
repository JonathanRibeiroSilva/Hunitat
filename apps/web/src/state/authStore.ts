/**
 * Who the person at this browser is — phase 6.
 *
 * Separate from `useStore`, which is about the *world*: what is on screen, who
 * is nearby, where they are standing. Identity outlives all of that. It is
 * established before the socket opens (`FR-6.18`), survives a reconnect that
 * resets the roster, and is still true on the entry screen where there is no
 * world at all. Folding it into the world store would mean `reset()` — which
 * runs on every "back to start" — signing the user out.
 *
 * The credential itself is not here. It lives in `authClient`, in memory, and
 * nothing renders it.
 */

import { create } from 'zustand';
import type { AccountDto, AuthConfigDto } from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';

/**
 * Three states, and `unknown` is load-bearing.
 *
 * At startup the client does not yet know whether the refresh cookie will
 * produce a session, and rendering "sign in" during that window makes a signed-in
 * user watch their own account flicker away and come back on every reload.
 */
export type AuthStatus = 'unknown' | 'anonymous' | 'signed-in';

interface AuthState {
  status: AuthStatus;
  account: AccountDto | null;
  /** What the server allows. Null until fetched; the entry screen waits for it
   *  rather than guessing whether guests are welcome. */
  config: AuthConfigDto | null;

  /**
   * The invite code from the URL, if the page was opened from a link.
   *
   * Kept here rather than re-read from `location` at each step, because it is
   * consumed across three of them — preview, register-or-sign-in, redeem — and
   * the URL is cleaned as soon as it is captured so a shared screenshot of the
   * address bar does not hand the code to a room.
   */
  pendingInvite: string | null;
  /** The reset token from the URL, same reasoning. */
  pendingReset: string | null;

  setConfig: (config: AuthConfigDto) => void;
  setAccount: (account: AccountDto | null) => void;
  setPendingInvite: (code: string | null) => void;
  setPendingReset: (token: string | null) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  account: null,
  config: null,
  pendingInvite: null,
  pendingReset: null,

  setConfig: (config) => set({ config }),

  setAccount: (account) => set({ account, status: account ? 'signed-in' : 'anonymous' }),

  setPendingInvite: (pendingInvite) => set({ pendingInvite }),
  setPendingReset: (pendingReset) => set({ pendingReset }),

  signOut: () => set({ account: null, status: 'anonymous' }),
}));

/**
 * The client's own sign-out, wired to the store.
 *
 * A refresh can fail at any moment — the family was revoked, the cookie expired,
 * somebody replayed a token. When it does, the interface must stop claiming to
 * be signed in. Registered once, at module load, so no component has to remember
 * to.
 */
auth.bindSignOutHandler(() => useAuthStore.getState().signOut());

/** `FR-6.13` — a member of the Space this world instance belongs to. */
export function isMember(account: AccountDto | null, slug: string | undefined): boolean {
  if (!account || !slug) return false;
  return account.memberships.some((membership) => membership.spaceSlug === slug);
}
