/**
 * The account panel — phase 6, from inside the world.
 *
 * Everything an identity can do without leaving: rename yourself (`FR-6.10`),
 * become an account without losing your place (`FR-6.7`), issue an invite
 * (`FR-6.12`), close the Space to guests (`FR-6.8`), sign out (`FR-6.4`).
 *
 * ── Why the upgrade form is here and not on the entry screen ────────────────
 *
 * Because that is the requirement. `FR-6.7` says a guest upgrades "carrying over
 * their current session identity", and the Rules say it "must not lose the
 * user's place/state mid-session where avoidable". A sign-up that sent somebody
 * back to the entry screen would satisfy neither: they would arrive back at a
 * spawn point, in a conversation they had walked out of. This posts to
 * `/auth/upgrade` alongside a socket that is never touched, and the server
 * answers by rebinding the live session — the person watches their own nameplate
 * change without moving.
 *
 * The resume token is what proves ownership of that session. A session id would
 * not: every participant in range is told one.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Panel, cn } from '@hubitat/ui';
import { TUNING, type InviteDto } from '@hubitat/protocol';
import { auth, AuthError } from '../auth/authClient.js';
import { useAuthStore } from '../state/authStore.js';
import { useStore } from '../state/store.js';

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const account = useAuthStore((state) => state.account);
  const config = useAuthStore((state) => state.config);
  const identity = useStore((state) => state.joined?.identity);

  return (
    <Panel
      role="dialog"
      aria-label="Your account"
      className="pointer-events-auto flex max-h-104 w-80 max-w-(--hud-rail) shrink-0 flex-col
                 overflow-y-auto p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{account ? 'Your account' : 'You are a guest'}</h2>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {account?.email ?? config?.spaceName ?? 'hubitat'}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded px-1.5 text-slate-500 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          ×
        </button>
      </div>

      <div className="mt-4 space-y-4">
        {account ? (
          <>
            <ProfileForm />
            <MembershipNote member={identity?.member === true} />
            {identity?.member && <InviteSection />}
            {identity?.member && <GuestPolicy />}
            <SignOut />
          </>
        ) : (
          <UpgradeForm />
        )}
      </div>
    </Panel>
  );
}

/** `FR-6.10` — the name persists, and the change is live. */
function ProfileForm() {
  const account = useAuthStore((state) => state.account)!;
  const [name, setName] = useState(account.displayName);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  // Somebody else's device changed it, or the panel reopened after a refresh.
  useEffect(() => setName(account.displayName), [account.displayName]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === account.displayName) return;
    void run(async () => {
      const updated = await auth.updateProfile({ displayName: trimmed });
      useAuthStore.getState().setAccount(updated);
      // The world is not told from here. The server pushes the change to every
      // live session of this account itself (`refreshAccountSessions`), which is
      // what makes it arrive on the other tab too.
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="account-name" className="block text-xs font-medium text-slate-400">
        Display name
      </label>
      <div className="flex gap-2">
        <input
          id="account-name"
          value={name}
          maxLength={TUNING.MAX_DISPLAY_NAME_CHARS}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-800/80 px-2 py-1.5
                     text-slate-100 focus:border-sky-400 focus:outline-none focus:ring-2
                     focus:ring-sky-400/40"
        />
        <Button type="submit" disabled={busy || name.trim() === account.displayName}>
          {busy ? '…' : 'Save'}
        </Button>
      </div>
      {saved && <p className="text-xs text-emerald-300">Saved.</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {/* FR-6.9 — worth saying, because phase 4 taught people the opposite. */}
      <p className="text-xs text-slate-500">
        Your avatar is saved with your account. Change it from <strong>Avatar</strong>.
      </p>
    </form>
  );
}

/** `FR-6.13` — an account is not automatically a member. */
function MembershipNote({ member }: { member: boolean }) {
  const account = useAuthStore((state) => state.account)!;
  const config = useAuthStore((state) => state.config);

  if (member) {
    const joined = account.memberships.find((m) => m.spaceSlug === config?.spaceSlug);
    return (
      <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-400">
        Member of{' '}
        <strong className="text-slate-200">{joined?.spaceName ?? config?.spaceName}</strong>
        {joined && ` since ${new Date(joined.joinedAt).toLocaleDateString()}`}.
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-amber-400/30 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
      You&apos;re signed in but not a member of this space. Open an invite link to join — your
      account and avatar are already yours either way.
    </p>
  );
}

/** `FR-6.12`, `FR-6.14`. */
function InviteSection() {
  const config = useAuthStore((state) => state.config)!;
  const [invites, setInvites] = useState<InviteDto[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(() => {
    void auth
      .listInvites(config.spaceSlug)
      .then(setInvites)
      .catch(() => setInvites([]));
  }, [config.spaceSlug]);

  useEffect(load, [load]);

  const create = (maxUses: number | null) =>
    run(async () => {
      const invite = await auth.createInvite(config.spaceSlug, { maxUses });
      setInvites((current) => [invite, ...(current ?? [])]);
      await copy(invite.url);
      setCopied(invite.code);
      window.setTimeout(() => setCopied(null), 2500);
    });

  const live = (invites ?? []).filter(
    (invite) =>
      !invite.revoked &&
      new Date(invite.expiresAt).getTime() > Date.now() &&
      (invite.maxUses === null || invite.uses < invite.maxUses),
  );

  return (
    <div className="space-y-2 border-t border-white/10 pt-3">
      <p className="text-xs font-medium text-slate-400">Invite someone</p>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void create(1)} className="flex-1">
          One person
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void create(null)}
          className="flex-1"
        >
          Reusable
        </Button>
      </div>
      {/* FR-6.14 — every invite expires, including the reusable one. Said out
          loud so nobody believes they have made a permanent door. */}
      <p className="text-xs text-slate-500">
        Both expire in {Math.round(TUNING.INVITE_DEFAULT_TTL_HOURS / 24)} days. The link is copied
        to your clipboard.
      </p>

      {copied && <p className="text-xs text-emerald-300">Copied the link for {copied}.</p>}
      {error && <p className="text-xs text-rose-300">{error}</p>}

      {live.length > 0 && (
        <ul className="space-y-1 pt-1">
          {live.slice(0, 4).map((invite) => (
            <li key={invite.id} className="flex items-center gap-2 text-xs text-slate-400">
              <code className="min-w-0 flex-1 truncate font-mono text-slate-300">
                {invite.code}
              </code>
              <span className="shrink-0 text-slate-500">
                {invite.maxUses === null ? 'reusable' : `${invite.uses}/${invite.maxUses}`}
              </span>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await auth.revokeInvite(config.spaceSlug, invite.id);
                    load();
                  })
                }
                className="shrink-0 rounded px-1 text-slate-500 hover:text-rose-300
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `FR-6.8` — the setting an operator can actually change. */
function GuestPolicy() {
  const config = useAuthStore((state) => state.config)!;
  const { busy, error, run } = useAction();

  return (
    <div className="space-y-1 border-t border-white/10 pt-3">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={config.allowGuests}
          disabled={busy}
          onChange={(event) =>
            void run(async () => {
              const space = await auth.setAllowGuests(config.spaceSlug, event.target.checked);
              useAuthStore.getState().setConfig({ ...config, allowGuests: space.allowGuests });
            })
          }
          className="h-3.5 w-3.5 rounded border-white/20 bg-slate-800 accent-sky-500"
        />
        Anyone with the link can enter as a guest
      </label>
      <p className="text-xs text-slate-500">
        Unchecked, this space requires an account. People already inside stay where they are.
      </p>
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </div>
  );
}

function SignOut() {
  const { busy, run } = useAction();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() =>
        void run(async () => {
          await auth.logout();
          useAuthStore.getState().signOut();
          // Deliberately not disconnecting. `FR-6.4` ends the *authenticated*
          // session; the person is still standing in a world that admits guests,
          // and throwing them out of it would be a kick nobody asked for. The
          // next reconnect sends no token and they come back as a guest.
          useStore.getState().notify('Signed out. You are a guest until you sign in again.');
        })
      }
      className="w-full border-t border-white/10 pt-3 text-left text-xs text-slate-500
                 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2
                 focus-visible:ring-sky-300"
    >
      Sign out
    </button>
  );
}

/**
 * `FR-6.7` / `AC-6.2` — become an account without going anywhere.
 *
 * The name and avatar fields are absent on purpose: both are carried over from
 * the session by the server, which is the requirement. Asking for a display name
 * here would invite somebody to type the one they already have.
 */
function UpgradeForm() {
  const config = useAuthStore((state) => state.config);
  const pendingInvite = useAuthStore((state) => state.pendingInvite);
  const displayName = useStore((state) => state.displayName);
  const { busy, error, run } = useAction();

  if (!config?.accountsEnabled) {
    return (
      <p className="text-xs text-slate-500">
        This server is running without a database, so there are no accounts. Nothing about this
        session is saved.
      </p>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      // The resume token is the proof of ownership for this session — see the
      // file header for why it is not the session id.
      const resumeToken = useStore.getState().joined?.resumeToken;
      if (!resumeToken) throw new AuthError(0, 'Not connected to the world.');

      const account = await auth.upgrade({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
        resumeToken,
        ...(pendingInvite ? { inviteCode: pendingInvite } : {}),
      });
      useAuthStore.getState().setAccount(account);
      useAuthStore.getState().setPendingInvite(null);
      // Nothing else to do. The server has already rebound the live session and
      // sent `IDENTITY`, which the net client applies — the nameplate updates
      // without this component knowing anything about the world.
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-slate-400">
        Keep <strong className="text-slate-200">{displayName || 'this name'}</strong> and your
        avatar. You won&apos;t leave the world or lose your place.
      </p>

      <input
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="Email"
        className={UPGRADE_INPUT}
      />
      <input
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={config.passwordMinLength}
        placeholder={`Password (${config.passwordMinLength}+ characters)`}
        className={UPGRADE_INPUT}
      />

      {error && <p className="text-xs text-rose-300">{error}</p>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Creating…' : 'Create an account'}
      </Button>
    </form>
  );
}

const UPGRADE_INPUT = cn(
  'w-full rounded-lg border border-white/10 bg-slate-800/80 px-2 py-1.5 text-slate-100',
  'placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2',
  'focus:ring-sky-400/40',
);

/** One in-flight action with its failure on screen. The `busy` guard is what
 *  stops a double-click registering twice and reading the second 409 as "that
 *  address is taken" for an address nobody else has. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (problem) {
        setError(problem instanceof AuthError ? problem.message : 'That did not work. Try again.');
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return { busy, error, run };
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access is refused in an insecure context and by some policies.
    // The code is on screen either way, which is why this is not worth
    // reporting — the link is still usable, it just has to be read.
  }
}
