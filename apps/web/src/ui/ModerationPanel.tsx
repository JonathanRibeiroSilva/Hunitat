/**
 * The moderation panel — phase 7, the durable half.
 *
 * `FR-7.3` roles · `FR-7.11`–`FR-7.15` access · `FR-7.8` bans · `FR-7.17`
 * reports · `FR-7.20` the audit log.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * Mute, kick and respawn. Those act on somebody who is standing in front of you
 * and they live in the presence list, where the person is — asking a moderator
 * to find a name in a five-section admin panel while somebody is shouting is the
 * wrong shape for an urgent action. This panel is for the things that outlive a
 * session: who is an admin, who may enter, who is banned, what was reported, and
 * what everybody with a role has done.
 *
 * ── One request, five sections ──────────────────────────────────────────────
 *
 * `GET …/moderation` returns all of it at once. Five endpoints would mean five
 * loading states and a screen that could show a ban list next to a members list
 * from ten seconds earlier — and the two are read together precisely when they
 * disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Panel, cn } from '@hubitat/ui';
import type { ModerationOverviewDto, Role } from '@hubitat/protocol';
import { auth, AuthError } from '../auth/authClient.js';
import { useAuthStore } from '../state/authStore.js';

type Section = 'access' | 'people' | 'reports' | 'log';

export function ModerationPanel({ onClose }: { onClose: () => void }) {
  const slug = useAuthStore((state) => state.config?.spaceSlug ?? 'default');
  const [overview, setOverview] = useState<ModerationOverviewDto | null>(null);
  const [section, setSection] = useState<Section>('access');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void auth
      .moderationOverview(slug)
      .then((next) => {
        setOverview(next);
        setError(null);
      })
      .catch((problem: unknown) =>
        setError(problem instanceof AuthError ? problem.message : 'Could not load moderation.'),
      );
  }, [slug]);

  useEffect(load, [load]);

  /**
   * Run an action and re-read everything.
   *
   * Re-reading rather than patching local state: most of these have effects the
   * client cannot predict — banning somebody adds an audit row, a role change
   * can promote or demote, and lifting a ban does not delete it. A screen that
   * guessed would be wrong in exactly the cases somebody opened it to check.
   */
  const run = (action: () => Promise<unknown>) => {
    setError(null);
    void action()
      .then(load)
      .catch((problem: unknown) =>
        setError(problem instanceof AuthError ? problem.message : 'That did not work.'),
      );
  };

  return (
    <Panel
      role="dialog"
      aria-label="Moderation"
      className="pointer-events-auto flex max-h-[32rem] w-88 max-w-(--hud-rail) shrink-0 flex-col
                 overflow-hidden p-0 text-sm"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 className="font-medium">Moderation</h2>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            You are {overview ? roleLabel(overview.role) : 'loading…'}
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

      <nav className="mt-3 flex shrink-0 gap-1 border-b border-white/10 px-2">
        {(['access', 'people', 'reports', 'log'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSection(tab)}
            aria-current={section === tab}
            className={cn(
              'rounded-t-md px-3 py-2 text-xs capitalize',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
              section === tab
                ? 'border-b-2 border-sky-400 text-sky-100'
                : 'text-slate-400 hover:text-slate-200',
            )}
          >
            {tab}
            {tab === 'reports' && unreviewed(overview) > 0 && (
              <span className="ml-1 rounded bg-amber-500/20 px-1 text-[10px] text-amber-200">
                {unreviewed(overview)}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-950/40 px-3 py-2 text-xs text-rose-100">
            {error}
          </p>
        )}
        {!overview ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : section === 'access' ? (
          <AccessSection overview={overview} slug={slug} run={run} />
        ) : section === 'people' ? (
          <PeopleSection overview={overview} slug={slug} run={run} />
        ) : section === 'reports' ? (
          <ReportsSection overview={overview} slug={slug} run={run} />
        ) : (
          <LogSection overview={overview} />
        )}
      </div>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-7.11 – FR-7.15 — access
// ─────────────────────────────────────────────────────────────────────────────

function AccessSection({
  overview,
  slug,
  run,
}: {
  overview: ModerationOverviewDto;
  slug: string;
  run: (action: () => Promise<unknown>) => void;
}) {
  const { access } = overview;
  const allowed = overview.capabilities.includes('manage-access');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');

  if (!allowed) {
    return (
      <p className="text-xs text-slate-500">
        Only admins can change who may enter. This is what is set right now:{' '}
        {describeAccess(access)}.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* `FR-7.11`. The wording says what it does *not* do, because "lock" reads
          like an eviction to most people and locking a Space to get rid of
          somebody is the mistake this sentence prevents. */}
      <Toggle
        label="Locked — nobody new may enter"
        hint="People already inside stay. To remove somebody, use their name in the presence list."
        checked={access.locked}
        onChange={(locked) => run(() => auth.updateAccess(slug, { locked }))}
      />

      {/* `FR-6.8`, which phase 7 moves under `manage-access` — it is an access
          control like the other four. */}
      <Toggle
        label="Guests may enter"
        hint="Unchecked, this space requires an account."
        checked={access.allowGuests}
        onChange={(allowGuests) => {
          run(async () => {
            const updated = await auth.updateAccess(slug, { allowGuests });
            const config = useAuthStore.getState().config;
            if (config) useAuthStore.getState().setConfig({ ...config, allowGuests });
            return updated;
          });
        }}
      />

      {/* `FR-7.12`. The current password is never shown, because it is never
          sent — an admin who has forgotten it sets a new one. */}
      <div className="space-y-1.5 border-t border-white/10 pt-3">
        <p className="text-xs font-medium text-slate-400">
          Password {access.passwordSet ? '— one is set' : '— none'}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="New password"
            className={INPUT}
          />
          <Button
            variant="ghost"
            disabled={password.trim().length < 4}
            onClick={() =>
              run(async () => {
                const updated = await auth.updateAccess(slug, { password: password.trim() });
                setPassword('');
                return updated;
              })
            }
          >
            Set
          </Button>
        </div>
        {access.passwordSet && (
          <button
            type="button"
            onClick={() => run(() => auth.updateAccess(slug, { password: null }))}
            className="text-xs text-slate-500 hover:text-slate-300 focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-sky-300"
          >
            Remove the password
          </button>
        )}
        <p className="text-xs text-slate-500">
          Everyone types it once when they enter. Admins are never asked.
        </p>
      </div>

      {/* `FR-7.13`. By address, because the useful case is naming somebody
          before they have registered. */}
      <div className="space-y-2 border-t border-white/10 pt-3">
        <Toggle
          label="Allowlist — only these addresses may enter"
          hint="Guests have no address, so an allowlisted space admits nobody anonymously."
          checked={access.allowlistEnabled}
          onChange={(allowlistEnabled) => run(() => auth.updateAccess(slug, { allowlistEnabled }))}
        />
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            className={INPUT}
          />
          <Button
            variant="ghost"
            disabled={!email.includes('@')}
            onClick={() =>
              run(async () => {
                const updated = await auth.addToAllowlist(slug, email.trim().toLowerCase());
                setEmail('');
                return updated;
              })
            }
          >
            Add
          </Button>
        </div>
        {access.allowlist.length > 0 && (
          <ul className="space-y-1">
            {access.allowlist.map((entry) => (
              <li key={entry} className="flex items-center gap-2 text-xs text-slate-400">
                <span className="min-w-0 flex-1 truncate">{entry}</span>
                <button
                  type="button"
                  onClick={() => run(() => auth.removeFromAllowlist(slug, entry))}
                  className="shrink-0 rounded px-1 text-slate-500 hover:text-rose-300
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* `FR-7.14`. Stated as a number rather than a field, because the phase 8
          note in the spec matters: there is one instance, so the only honest
          policy is to refuse — and saying so is more useful than a control that
          implies overflow exists. */}
      <p className="border-t border-white/10 pt-3 text-xs text-slate-500">
        Capacity is {access.capacity ?? 'the map default'}. Beyond it, people are turned away with a
        reason rather than let in to a world that stutters.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-7.3, FR-7.8 — people
// ─────────────────────────────────────────────────────────────────────────────

function PeopleSection({
  overview,
  slug,
  run,
}: {
  overview: ModerationOverviewDto;
  slug: string;
  run: (action: () => Promise<unknown>) => void;
}) {
  const canManageRoles = overview.capabilities.includes('manage-roles');
  const canBan = overview.capabilities.includes('ban');
  const canTransfer = overview.capabilities.includes('transfer-ownership');

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs font-medium text-slate-400">Members</p>
        {overview.members.length === 0 && (
          <p className="text-xs text-slate-500">Nobody has joined this space yet.</p>
        )}
        <ul className="space-y-1">
          {overview.members.map((member) => (
            <li key={member.accountId} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  member.online ? 'bg-emerald-400' : 'bg-slate-700',
                )}
                title={member.online ? 'In the world now' : 'Not connected'}
              />
              <span className="min-w-0 flex-1 truncate text-slate-300" title={member.email}>
                {member.displayName}
              </span>

              {/* `FR-7.3` — `owner` is absent from the options on purpose. The
                  Rules require ownership to move through its own path, and a
                  dropdown that offered it would be the generic role change that
                  orphans a Space. */}
              {canManageRoles && member.role !== 'owner' ? (
                <select
                  value={member.role}
                  onChange={(event) =>
                    run(() =>
                      auth.setRole(
                        slug,
                        member.accountId,
                        event.target.value as 'admin' | 'member' | 'guest',
                      ),
                    )
                  }
                  className="shrink-0 cursor-pointer rounded bg-slate-800 px-1 py-0.5 text-[11px]
                             text-slate-300 focus-visible:outline-none focus-visible:ring-2
                             focus-visible:ring-sky-300"
                >
                  <option value="admin">admin</option>
                  <option value="member">member</option>
                  <option value="guest">remove</option>
                </select>
              ) : (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-sky-400/80">
                  {member.role}
                </span>
              )}

              {canBan && member.role !== 'owner' && (
                <button
                  type="button"
                  onClick={() => {
                    const reason = window.prompt(`Ban ${member.displayName}. Why? (optional)`);
                    if (reason === null) return;
                    run(() =>
                      auth.banAccount(slug, {
                        accountId: member.accountId,
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      }),
                    );
                  }}
                  className="shrink-0 rounded px-1 text-slate-500 hover:text-rose-300
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  ban
                </button>
              )}

              {canTransfer && member.role === 'admin' && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Hand this space to ${member.displayName}? You become an admin and cannot undo this yourself.`,
                      )
                    ) {
                      return;
                    }
                    run(() => auth.transferOwnership(slug, member.accountId));
                  }}
                  className="shrink-0 rounded px-1 text-slate-500 hover:text-sky-300
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  make owner
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* `FR-7.8`. Lifted rather than deleted, and the list keeps them, because
          "why can this person get in again" is a question it should answer. */}
      <div className="space-y-1 border-t border-white/10 pt-3">
        <p className="text-xs font-medium text-slate-400">Bans</p>
        {overview.bans.length === 0 && <p className="text-xs text-slate-500">Nobody is banned.</p>}
        <ul className="space-y-1">
          {overview.bans.map((ban) => {
            const active =
              ban.liftedAt === null &&
              (ban.expiresAt === null || new Date(ban.expiresAt).getTime() > Date.now());
            return (
              <li key={ban.id} className="flex items-start gap-2 text-xs">
                <span
                  className={cn(
                    'min-w-0 flex-1',
                    active ? 'text-slate-300' : 'text-slate-600 line-through',
                  )}
                >
                  <span className="truncate">{ban.displayName}</span>
                  <span className="block text-[10px] text-slate-500">
                    {ban.kind === 'guest' ? 'guest · weak' : 'account'}
                    {ban.expiresAt
                      ? ` · until ${new Date(ban.expiresAt).toLocaleString()}`
                      : ' · permanent'}
                    {ban.reason ? ` · ${ban.reason}` : ''}
                  </span>
                </span>
                {canBan && active && (
                  <button
                    type="button"
                    onClick={() => run(() => auth.liftBan(slug, ban.id))}
                    className="shrink-0 rounded px-1 text-slate-500 hover:text-emerald-300
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                  >
                    lift
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-7.17 — reports
// ─────────────────────────────────────────────────────────────────────────────

function ReportsSection({
  overview,
  slug,
  run,
}: {
  overview: ModerationOverviewDto;
  slug: string;
  run: (action: () => Promise<unknown>) => void;
}) {
  if (overview.reports.length === 0) {
    return <p className="text-xs text-slate-500">Nobody has reported anybody.</p>;
  }

  return (
    <ul className="space-y-2">
      {overview.reports.map((report) => (
        <li
          key={report.id}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            report.reviewedAt
              ? 'border-white/10 bg-white/5 text-slate-500'
              : 'border-amber-400/30 bg-amber-950/30 text-amber-100',
          )}
        >
          <p>
            <strong>{report.reporterName}</strong> reported <strong>{report.targetName}</strong>
          </p>
          {report.reason && <p className="mt-1 text-slate-300">{report.reason}</p>}
          {/* `DC-7.6` — the context, captured server-side at the moment of
              filing. It is what turns "they were rude" into something a
              moderator can go and look at. */}
          <p className="mt-1 text-[10px] text-slate-500">
            {new Date(report.createdAt).toLocaleString()} · {report.context.mapId} at (
            {report.context.x.toFixed(1)}, {report.context.z.toFixed(1)})
            {report.context.zoneIds.length > 0 && ` · in ${report.context.zoneIds.join(', ')}`}
          </p>
          {report.reviewedAt ? (
            <p className="mt-1 text-[10px] text-slate-500">Reviewed by {report.reviewedBy}</p>
          ) : (
            <button
              type="button"
              onClick={() => run(() => auth.reviewReport(slug, report.id))}
              className="mt-1 rounded px-1 text-[11px] text-amber-300 hover:text-amber-100
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              Mark as handled
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-7.19, FR-7.20 — the audit log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sentence for each action, built at read time.
 *
 * The rows store a verb and a `detail` blob rather than a sentence, so a wording
 * change does not require rewriting rows the database will not let anybody
 * rewrite. This is where the wording lives.
 */
const AUDIT_VERB: Record<string, string> = {
  mute: 'muted',
  unmute: 'unmuted',
  'disable-video': 'turned off video for',
  'enable-video': 'restored video for',
  kick: 'removed',
  ban: 'banned',
  unban: 'lifted the ban on',
  respawn: 'sent back to the entrance',
  role: 'changed the role of',
  'ownership-transfer': 'handed the space to',
  access: 'changed access settings',
  allowlist: 'changed the allowlist',
  'report-reviewed': 'handled a report about',
};

function LogSection({ overview }: { overview: ModerationOverviewDto }) {
  if (overview.audit.length === 0) {
    return <p className="text-xs text-slate-500">Nothing has been done yet.</p>;
  }

  return (
    <ul className="space-y-1.5">
      {overview.audit.map((entry) => (
        <li key={entry.id} className="text-xs text-slate-400">
          <span className="text-slate-200">{entry.actorName}</span>{' '}
          {AUDIT_VERB[entry.action] ?? entry.action}
          {entry.targetName && <span className="text-slate-200"> {entry.targetName}</span>}
          <span className="block text-[10px] text-slate-500">
            {new Date(entry.at).toLocaleString()}
            {detailLine(entry.detail) && ` · ${detailLine(entry.detail)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The interesting parts of a `detail` blob, in one line.
 *
 * A whitelist rather than a dump: the blob also carries the roles at the time,
 * which matter for review and clutter a list. A reason and a duration are what
 * somebody scanning the log is looking for.
 */
function detailLine(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.from === 'string' && typeof detail.to === 'string') {
    parts.push(`${detail.from} → ${detail.to}`);
  }
  if (typeof detail.durationMinutes === 'number') {
    parts.push(`${Math.round(detail.durationMinutes / 60)}h`);
  }
  if (detail.expiresAt === null && detail.reason !== undefined) parts.push('permanent');
  if (typeof detail.reason === 'string' && detail.reason) parts.push(`“${detail.reason}”`);
  if (detail.locked === true) parts.push('locked');
  if (detail.locked === false) parts.push('unlocked');
  if (typeof detail.password === 'string') parts.push(`password ${detail.password}`);
  if (detail.allowGuests === true) parts.push('guests allowed');
  if (detail.allowGuests === false) parts.push('guests refused');
  if (typeof detail.added === 'string') parts.push(`+${detail.added}`);
  if (typeof detail.removed === 'string') parts.push(`−${detail.removed}`);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────

const INPUT = cn(
  'min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-800/80 px-2 py-1.5 text-xs',
  'text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none',
  'focus:ring-2 focus:ring-sky-400/40',
);

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-0.5">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="h-3.5 w-3.5 rounded border-white/20 bg-slate-800 accent-sky-500"
        />
        {label}
      </label>
      <p className="pl-5.5 text-[10px] leading-snug text-slate-500">{hint}</p>
    </div>
  );
}

function roleLabel(role: Role): string {
  return role === 'owner'
    ? 'the owner of this space'
    : role === 'admin'
      ? 'an admin here'
      : role === 'member'
        ? 'a member here'
        : 'not a member of this space';
}

function describeAccess(access: ModerationOverviewDto['access']): string {
  const parts: string[] = [];
  parts.push(access.locked ? 'locked' : 'open');
  if (access.passwordSet) parts.push('password required');
  if (access.allowlistEnabled) parts.push('allowlisted');
  parts.push(access.allowGuests ? 'guests welcome' : 'accounts only');
  return parts.join(', ');
}

/** Shown on the tab, because a report nobody has looked at is the one thing in
 *  this panel that is waiting on a person. */
function unreviewed(overview: ModerationOverviewDto | null): number {
  return overview?.reports.filter((report) => report.reviewedAt === null).length ?? 0;
}
