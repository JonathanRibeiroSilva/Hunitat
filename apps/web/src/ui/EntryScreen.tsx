/**
 * ENTRY — specs/ux/phase-01-screens.md, extended by phase 6.
 *
 * No 3D, no connection yet. Phase 1 asked for a name and a button; this is the
 * same screen with the three ways in that phase 6 defines:
 *
 *   sign in     `FR-6.2`
 *   register    `FR-6.1`, optionally redeeming an invite in the same step
 *   guest       `FR-6.6`, and only when the Space allows it (`FR-6.8`)
 *
 * ── What is fetched before anything renders ─────────────────────────────────
 *
 * `GET /auth/config`. Every branch below depends on an answer only the server
 * has: whether accounts exist at all (they do not without a database), whether
 * guests are admitted, how long a password must be, and whether recovery is
 * configured. Guessing any of them produces a form that cannot succeed —
 * offering "continue as guest" to a closed Space is `AC-6.5`'s failure, made by
 * the client instead of by the server.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Panel } from '@hubitat/ui';
import { INVITE_QUERY_PARAM, RESET_QUERY_PARAM, TUNING } from '@hubitat/protocol';
import type { InvitePreviewDto } from '@hubitat/protocol';
import { auth, AuthError } from '../auth/authClient.js';
import { useAuthStore } from '../state/authStore.js';
import { useStore } from '../state/store.js';

type Mode = 'choose' | 'sign-in' | 'register' | 'guest' | 'forgot' | 'reset';

export function EntryScreen({
  onEnter,
}: {
  /** `spacePassword` is phase 7, `FR-7.12` — collected here when the server says
   *  one is needed, because it gates entry and this is the screen that enters. */
  onEnter: (displayName: string, spacePassword?: string) => void;
}) {
  const config = useAuthStore((state) => state.config);
  const status = useAuthStore((state) => state.status);
  const account = useAuthStore((state) => state.account);
  const pendingInvite = useAuthStore((state) => state.pendingInvite);
  const pendingReset = useAuthStore((state) => state.pendingReset);

  const [mode, setMode] = useState<Mode>('choose');
  const [invitePreview, setInvitePreview] = useState<InvitePreviewDto | null>(null);

  // A reset link is not a choice — somebody clicked it and expects a form.
  useEffect(() => {
    if (pendingReset) setMode('reset');
  }, [pendingReset]);

  /**
   * `AC-6.4` — check the invite before asking anybody to fill in a form.
   *
   * A person who followed a dead link should be told so on arrival, not after
   * they have chosen a password. The preview is deliberately vague about codes
   * that do not exist (see `InviteService.preview`), so this cannot be used to
   * hunt for valid ones.
   */
  useEffect(() => {
    if (!pendingInvite) return;
    let cancelled = false;
    void auth
      .previewInvite(pendingInvite)
      .then((preview) => {
        if (cancelled) return;
        setInvitePreview(preview);
        // A good invite is an invitation to make an account, so start there
        // rather than on a menu that buries it.
        if (preview.valid) setMode((current) => (current === 'choose' ? 'register' : current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pendingInvite]);

  // The server has not answered yet. Rendering a form now would mean rendering
  // the wrong one for a moment.
  if (!config || status === 'unknown') {
    return (
      <Shell>
        <p className="mt-8 text-sm text-slate-400">Checking with the server…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      {invitePreview && <InviteBanner preview={invitePreview} />}
      {/* `FR-7.11` — told up front rather than after a name, a password and a
          click. It discloses nothing an attempted join would not. */}
      {config.spaceLocked && (
        <p className="mt-6 rounded-lg border border-amber-400/30 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
          This space is closed to new arrivals right now. Admins can still get in to reopen it.
        </p>
      )}

      {mode === 'choose' && (
        <ChooseHow
          onSignIn={() => setMode('sign-in')}
          onRegister={() => setMode('register')}
          onGuest={() => setMode('guest')}
          signedInAs={account?.displayName ?? null}
          onEnterAsAccount={(spacePassword) => onEnter(account?.displayName ?? '', spacePassword)}
        />
      )}

      {mode === 'sign-in' && (
        <SignInForm
          onDone={onEnter}
          onBack={() => setMode('choose')}
          onForgot={() => setMode('forgot')}
        />
      )}
      {mode === 'register' && <RegisterForm onDone={onEnter} onBack={() => setMode('choose')} />}
      {mode === 'guest' && <GuestForm onEnter={onEnter} onBack={() => setMode('choose')} />}
      {mode === 'forgot' && <ForgotForm onBack={() => setMode('sign-in')} />}
      {mode === 'reset' && <ResetForm onDone={() => setMode('sign-in')} />}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const config = useAuthStore((state) => state.config);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-slate-950 p-6">
      <Panel className="w-full max-w-md p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{config?.spaceName ?? 'hubitat'}</h1>
        <p className="mt-1 text-sm text-slate-400">
          A shared 3D space. Walk up to people to talk to them.
        </p>
        {children}
      </Panel>
    </div>
  );
}

/**
 * `AC-6.4` — an invite that will not work says which kind of not-working it is.
 *
 * The Rules require expired and used-up to read differently, because the
 * recovery differs: one needs a fresh link from the same person, the other needs
 * a link at all.
 */
const INVITE_MESSAGE: Record<InvitePreviewDto['reason'], string> = {
  ok: '',
  expired: 'This invite has expired. Ask whoever sent it for a new one.',
  exhausted: 'This invite has already been used. Ask whoever sent it for a new one.',
  revoked: 'This invite was withdrawn. Ask whoever sent it for a new one.',
  unknown: 'That invite link is not valid. Check it for typos, or ask for a new one.',
};

function InviteBanner({ preview }: { preview: InvitePreviewDto }) {
  if (preview.valid) {
    return (
      <p className="mt-6 rounded-lg border border-emerald-400/30 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100">
        You&apos;ve been invited to <strong>{preview.spaceName}</strong>. Create an account or sign
        in to join.
      </p>
    );
  }
  return (
    <p className="mt-6 rounded-lg border border-amber-400/30 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
      {INVITE_MESSAGE[preview.reason]}
    </p>
  );
}

/**
 * The three doors, and which of them exist.
 *
 * `accountsEnabled` false means this server has no database: guests are the only
 * way in, and a sign-in form would be a form that cannot succeed. `allowGuests`
 * false is `FR-6.8`, and the guest button is simply absent rather than present
 * and refused — the Rules ask for an invite path, and that is what is left.
 */
function ChooseHow({
  onSignIn,
  onRegister,
  onGuest,
  signedInAs,
  onEnterAsAccount,
}: {
  onSignIn: () => void;
  onRegister: () => void;
  onGuest: () => void;
  signedInAs: string | null;
  onEnterAsAccount: (spacePassword?: string) => void;
}) {
  const config = useAuthStore((state) => state.config)!;
  const [spacePassword, setSpacePassword] = useState('');

  // FR-6.17 — the refresh cookie survived the reload, so this person is already
  // signed in and should not be asked again.
  if (signedInAs) {
    return (
      <div className="mt-8 space-y-3">
        {config.spacePasswordRequired && (
          <SpacePasswordField value={spacePassword} onChange={setSpacePassword} />
        )}
        <Button onClick={() => onEnterAsAccount(spacePassword || undefined)} className="w-full">
          Enter as {signedInAs}
        </Button>
        <button
          type="button"
          onClick={() => void auth.logout().then(() => useAuthStore.getState().signOut())}
          className="w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-3">
      {config.accountsEnabled && (
        <>
          <Button onClick={onSignIn} className="w-full">
            Sign in
          </Button>
          <Button onClick={onRegister} variant="ghost" className="w-full">
            Create an account
          </Button>
        </>
      )}

      {config.allowGuests ? (
        <button
          type="button"
          onClick={onGuest}
          className="w-full rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          {config.accountsEnabled ? 'Continue as a guest' : 'Enter'}
        </button>
      ) : (
        // AC-6.5, on the client side of the same rule the server enforces: this
        // Space requires an account, and the way in is a login or an invite.
        <p className="pt-2 text-xs text-slate-500">
          This space requires an account. Sign in, or open the invite link you were sent.
        </p>
      )}
    </div>
  );
}

/** `FR-6.6` — the phase 1 path, plus the Space password when there is one. */
function GuestForm({
  onEnter,
  onBack,
}: {
  onEnter: (displayName: string, spacePassword?: string) => void;
  onBack: () => void;
}) {
  const remembered = useStore((state) => state.displayName);
  const [name, setName] = useState(remembered);
  const [spacePassword, setSpacePassword] = useState('');
  const config = useAuthStore((state) => state.config)!;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // FR-1.2: blank is allowed, and the server generates one.
        onEnter(name.trim(), spacePassword || undefined);
      }}
      className="mt-8 space-y-4"
    >
      <Field label="Display name" htmlFor="displayName">
        <input
          id="displayName"
          autoFocus
          value={name}
          maxLength={TUNING.MAX_DISPLAY_NAME_CHARS}
          onChange={(event) => setName(event.target.value)}
          placeholder="Leave blank for a generated name"
          className={INPUT}
        />
      </Field>
      {/* FR-1.8: names need not be unique, so no uniqueness check and no
          warning — saying otherwise would imply a guarantee we do not make. */}
      <p className="text-xs text-slate-500">
        Names don&apos;t have to be unique. Up to {TUNING.MAX_DISPLAY_NAME_CHARS} characters.
      </p>

      {config.spacePasswordRequired && (
        <SpacePasswordField value={spacePassword} onChange={setSpacePassword} />
      )}

      <Button type="submit" className="w-full">
        Enter
      </Button>
      {config.accountsEnabled && <BackLink onClick={onBack} />}

      {/* FR-1.7 for guests, still true and still worth saying. FR-6.7 is the
          answer, and it is available from inside the world without losing your
          place — so this is a note rather than a warning. */}
      <p className="border-t border-white/10 pt-4 text-xs text-slate-500">
        {config.accountsEnabled
          ? 'Nothing about a guest session is saved. You can create an account later without leaving the world.'
          : 'This server is running without a database, so nothing about this session is saved.'}
      </p>
    </form>
  );
}

/** `FR-6.2`. */
function SignInForm({
  onDone,
  onBack,
  onForgot,
}: {
  onDone: (displayName: string, spacePassword?: string) => void;
  onBack: () => void;
  onForgot: () => void;
}) {
  const config = useAuthStore((state) => state.config)!;
  const pendingInvite = useAuthStore((state) => state.pendingInvite);
  const [spacePassword, setSpacePassword] = useState('');
  const { busy, error, submit } = useSubmit(async (form: FormData) => {
    const account = await auth.login(
      String(form.get('email') ?? ''),
      String(form.get('password') ?? ''),
    );
    // Somebody who arrived on an invite link and turned out to already have an
    // account still expects the link to do what it said. FR-6.15 makes a second
    // redemption harmless: they are already a member and stay one.
    const joined = pendingInvite ? await redeemQuietly(pendingInvite, account) : account;
    useAuthStore.getState().setAccount(joined);
    useAuthStore.getState().setPendingInvite(null);
    onDone(joined.displayName, spacePassword || undefined);
  });

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <Field label="Email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          className={INPUT}
        />
      </Field>
      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={INPUT}
        />
      </Field>

      {/* `FR-7.12`. Asked alongside the credentials rather than after them: the
          two are answered by the same person at the same moment, and splitting
          them into two screens is one more step for no gain. Admins are never
          refused by it, but they are not told that here — advertising which
          people can skip a check is a small map of who to attack. */}
      {config.spacePasswordRequired && (
        <SpacePasswordField value={spacePassword} onChange={setSpacePassword} />
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>

      {/* FR-6.5 — offered only when a relay is configured. A link that silently
          does nothing is worse than no link (ADR 0011). */}
      {config.passwordResetEnabled && (
        <button
          type="button"
          onClick={onForgot}
          className="w-full text-xs text-slate-500 hover:text-slate-300 focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          Forgot your password?
        </button>
      )}
      <BackLink onClick={onBack} />
    </form>
  );
}

/** `FR-6.1`, and `FR-6.13` when an invite came with it. */
function RegisterForm({
  onDone,
  onBack,
}: {
  onDone: (displayName: string, spacePassword?: string) => void;
  onBack: () => void;
}) {
  const config = useAuthStore((state) => state.config)!;
  const pendingInvite = useAuthStore((state) => state.pendingInvite);
  const appearance = useStore((state) => state.appearance);
  const appearanceRemembered = useStore((state) => state.appearanceRemembered);
  const [spacePassword, setSpacePassword] = useState('');

  const { busy, error, submit } = useSubmit(async (form: FormData) => {
    const displayName = String(form.get('displayName') ?? '').trim();
    const account = await auth.register({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      ...(displayName ? { displayName } : {}),
      // Carried over when this browser has an avatar its owner actually chose —
      // the same rule `JOIN` uses. Sending the untouched default would land a
      // profile on a look nobody picked.
      ...(appearanceRemembered ? { appearance } : {}),
      ...(pendingInvite ? { inviteCode: pendingInvite } : {}),
    });
    useAuthStore.getState().setAccount(account);
    useAuthStore.getState().setPendingInvite(null);
    onDone(account.displayName, spacePassword || undefined);
  });

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <Field label="Email" htmlFor="new-email">
        <input
          id="new-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          className={INPUT}
        />
      </Field>
      <Field label="Display name" htmlFor="new-name">
        <input
          id="new-name"
          name="displayName"
          maxLength={TUNING.MAX_DISPLAY_NAME_CHARS}
          placeholder="What people will see"
          className={INPUT}
        />
      </Field>
      <Field label="Password" htmlFor="new-password">
        <input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={config.passwordMinLength}
          className={INPUT}
        />
        {/* Told by the server, not imported: `PASSWORD_MIN_LENGTH` is tunable,
            and a hard-coded copy would go on refusing what the server accepts. */}
        <p className="mt-2 text-xs text-slate-500">
          At least {config.passwordMinLength} characters. Length is what matters — a phrase beats a
          short scramble.
        </p>
      </Field>

      {config.spacePasswordRequired && (
        <SpacePasswordField value={spacePassword} onChange={setSpacePassword} />
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Creating…' : 'Create account'}
      </Button>
      <BackLink onClick={onBack} />
    </form>
  );
}

/** `FR-6.5`, the asking half. */
function ForgotForm({ onBack }: { onBack: () => void }) {
  const [sent, setSent] = useState(false);
  const { busy, error, submit } = useSubmit(async (form: FormData) => {
    await auth.requestPasswordReset(String(form.get('email') ?? ''));
    setSent(true);
  });

  if (sent) {
    return (
      <div className="mt-8 space-y-4">
        {/* Deliberately says nothing about whether that address has an account.
            The server answers the same way either way, and a message here that
            distinguished them would undo it. */}
        <p className="text-sm text-slate-300">
          If that address has an account, a reset link is on its way. It works once and expires
          shortly.
        </p>
        <BackLink onClick={onBack} label="Back to sign in" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <Field label="Email" htmlFor="forgot-email">
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          className={INPUT}
        />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Sending…' : 'Send a reset link'}
      </Button>
      <BackLink onClick={onBack} label="Back to sign in" />
    </form>
  );
}

/** `FR-6.5`, the acting half — reached by opening the link from the mail. */
function ResetForm({ onDone }: { onDone: () => void }) {
  const config = useAuthStore((state) => state.config)!;
  const token = useAuthStore((state) => state.pendingReset);
  const [done, setDone] = useState(false);

  const { busy, error, submit } = useSubmit(async (form: FormData) => {
    await auth.confirmPasswordReset(token ?? '', String(form.get('password') ?? ''));
    useAuthStore.getState().setPendingReset(null);
    setDone(true);
  });

  if (done) {
    return (
      <div className="mt-8 space-y-4">
        <p className="text-sm text-slate-300">
          Your password has been changed, and every other session has been signed out.
        </p>
        <Button onClick={onDone} className="w-full">
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <Field label="New password" htmlFor="reset-password">
        <input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          minLength={config.passwordMinLength}
          className={INPUT}
        />
        <p className="mt-2 text-xs text-slate-500">
          At least {config.passwordMinLength} characters.
        </p>
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Saving…' : 'Set the new password'}
      </Button>
      <p className="text-xs text-slate-500">
        Changing it signs out every device that is currently signed in, including this one.
      </p>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────────

const INPUT =
  'mt-2 w-full rounded-lg border border-white/10 bg-slate-800/80 px-3 py-2 text-slate-100 ' +
  'placeholder:text-slate-500 focus:border-sky-400 focus:outline-none focus:ring-2 ' +
  'focus:ring-sky-400/40';

/**
 * `FR-7.12` — the Space password.
 *
 * Its own component because four entry paths need it and each one would
 * otherwise spell the explanation differently. The wording says what it is
 * *not*: people conflate this with their account password constantly, and
 * getting that wrong means typing a real credential into a field whose value is
 * shared with a room full of colleagues.
 */
function SpacePasswordField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Space password" htmlFor="space-password">
      <input
        id="space-password"
        name="spacePassword"
        type="password"
        // Not `current-password`: that is the account credential, and offering a
        // saved one here invites somebody to submit it into a field whose value
        // everybody in the space knows.
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT}
      />
      <p className="mt-2 text-xs text-slate-500">
        This space asks everyone for a password. It is not your account password — whoever invited
        you has it.
      </p>
    </Field>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      {children}
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-rose-400/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-100"
    >
      {children}
    </p>
  );
}

function BackLink({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-xs text-slate-500 hover:text-slate-300 focus-visible:outline-none
                 focus-visible:ring-2 focus-visible:ring-sky-300"
    >
      {label}
    </button>
  );
}

/**
 * Submit-once with the failure on screen.
 *
 * The `busy` flag is not decoration: registering twice because a slow network
 * invited a second click produces a 409 on the second attempt and reads as "that
 * email is already taken" for an address the person has never used before.
 */
function useSubmit(action: (form: FormData) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy) return;
      const form = new FormData(event.currentTarget);
      setBusy(true);
      setError(null);
      void action(form)
        .catch((problem: unknown) => {
          setError(
            problem instanceof AuthError
              ? problem.message
              : 'Something went wrong. Try again in a moment.',
          );
        })
        .finally(() => setBusy(false));
    },
    [action, busy],
  );

  return { busy, error, submit };
}

/**
 * Redeem an invite that came with a sign-in, without letting a bad code block
 * the sign-in itself.
 *
 * They typed a correct password; refusing to let them in because a link they
 * were sent has expired would be punishing them for somebody else's timing. The
 * expired invite is already reported by the banner above.
 */
async function redeemQuietly<T extends { memberships: unknown[] }>(
  code: string,
  fallback: T,
): Promise<T> {
  try {
    return (await auth.redeemInvite(code)) as unknown as T;
  } catch {
    return fallback;
  }
}

/**
 * Pull `?invite=` / `?reset=` out of the URL and take them out of the address
 * bar.
 *
 * Cleaned immediately, and that is not tidiness: both are credentials. An invite
 * code in a shared screenshot hands somebody a door into the Space, and a reset
 * token in a screen-shared address bar is a password. `replaceState` also keeps
 * them out of the back button.
 *
 * Exported and called from `main.tsx`, before React renders, so no component
 * ever reads a URL that has already been rewritten.
 */
export function captureUrlCredentials(): void {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get(INVITE_QUERY_PARAM);
  const reset = params.get(RESET_QUERY_PARAM);
  if (!invite && !reset) return;

  if (invite) useAuthStore.getState().setPendingInvite(invite);
  if (reset) useAuthStore.getState().setPendingReset(reset);

  params.delete(INVITE_QUERY_PARAM);
  params.delete(RESET_QUERY_PARAM);
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  );
}
