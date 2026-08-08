/**
 * `FR-8.15`–`FR-8.17` — adding, configuring, archiving and deleting Maps.
 *
 * ── Why this lives inside the Places panel ──────────────────────────────────
 *
 * Because the thing being managed is the list directly above it. A separate
 * "space settings" screen would show the same rooms a second time, in a
 * different order, with different counts — and the one question an administrator
 * has while archiving a room is "is anybody in it", which the directory is
 * already answering. Moderation went in its own panel for the opposite reason:
 * roles, bans and the audit log are about people who may not be here at all.
 *
 * ── Nothing here is trusted ─────────────────────────────────────────────────
 *
 * The section is drawn from `canManageMaps` on the overview, which the server
 * computes from the same capability matrix its guard reads. That is advisory in
 * one direction only (`NFR-34`): it hides buttons the server would refuse, and it
 * cannot enable one it would not.
 *
 * ── Confirmation is the name, typed ─────────────────────────────────────────
 *
 * `FR-8.17` asks for "appropriate confirmation" on delete. A second button is
 * one mis-click on the wrong row; typing the room's own slug is the only
 * confirmation that cannot be given by accident. Archive has no confirmation at
 * all and needs none — it is reversible, and the people in the room are moved out
 * and told (`FR-8.18`) rather than losing anything.
 */

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@hubitat/ui';
import type { MapRecordDto, SpaceOverviewDto } from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';
import { useStore } from '../state/store.js';

export function RoomManager({
  slug,
  /** `FR-9.1` — open this Map in the editor. The management list is where a Map
   *  is a *thing*, so it is where "edit its contents" belongs. */
  onEdit,
}: {
  slug: string;
  onEdit: (mapId: string, spaceSlug: string) => void;
}) {
  const [overview, setOverview] = useState<SpaceOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(async () => {
    try {
      setOverview(await auth.spaceOverview(slug));
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every mutation, through one wrapper.
   *
   * It reloads the overview afterwards rather than patching the row in place,
   * because most of these have consequences beyond the row: archiving a Map
   * moves people out of it, deleting one can break portals in others, and making
   * one the landing Map un-makes another. A patched list would show one of those
   * and not the rest.
   */
  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await load();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!overview) {
    return error ? <Problem message={error} /> : null;
  }
  if (!overview.canManageMaps) return null;

  return (
    <section className="border-t border-white/10 pt-3">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-wide text-slate-500">Manage rooms</h3>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-400
                     hover:bg-sky-500/15 focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-sky-300"
        >
          {adding ? 'cancel' : 'add room'}
        </button>
      </div>

      {error && <Problem message={error} />}

      {adding && (
        <AddRoom
          maps={overview.maps}
          busy={busy}
          onCreate={(body) =>
            void run(async () => {
              await auth.createMap(slug, body);
              setAdding(false);
            })
          }
        />
      )}

      <ul className="space-y-1">
        {overview.maps.map((map) => (
          <li key={map.id} className="rounded-lg px-2 py-1.5 text-xs odd:bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  map.archivedAt ? 'text-slate-600 line-through' : 'text-slate-200',
                )}
                title={`${map.slug} · version ${map.version}`}
              >
                {map.name}
              </span>
              {map.isDefault && (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
                  landing
                </span>
              )}
              <span
                className="shrink-0 tabular-nums text-slate-500"
                title={`${map.occupancy} here now, across ${map.instanceCount} copy/copies`}
              >
                {map.occupancy}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {!map.archivedAt && (
                <Action
                  label="edit"
                  busy={busy}
                  title="Open this map in the editor (FR-9.1)"
                  onClick={() => onEdit(map.id, slug)}
                />
              )}
              {!map.archivedAt && !map.isDefault && (
                <Action
                  label="make landing"
                  busy={busy}
                  title="Where people land when they arrive (FR-8.7)"
                  onClick={() =>
                    void run(() => auth.updateMap(slug, map.id, { makeDefault: true }))
                  }
                />
              )}
              <Action
                label={map.archivedAt ? 'restore' : 'archive'}
                busy={busy}
                title={
                  map.archivedAt
                    ? 'Make it enterable again'
                    : map.occupancy > 0
                      ? `${map.occupancy} person(s) in there will be moved to the landing map and told`
                      : 'Keep it, but stop anybody entering it'
                }
                onClick={() =>
                  void run(() => auth.updateMap(slug, map.id, { archived: !map.archivedAt }))
                }
              />
              <Action
                label="delete"
                danger
                busy={busy}
                title="Removes it and everything authored in it. Cannot be undone."
                onClick={() => {
                  setConfirming(confirming === map.id ? null : map.id);
                  setConfirmText('');
                }}
              />
            </div>

            {confirming === map.id && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={`type "${map.slug}"`}
                  aria-label={`Type ${map.slug} to confirm deleting it`}
                  className="min-w-0 flex-1 rounded border border-rose-400/30 bg-slate-950/60 px-2
                             py-1 text-[11px] text-slate-200 placeholder:text-slate-600
                             focus-visible:outline-none focus-visible:ring-2
                             focus-visible:ring-rose-300"
                />
                <button
                  type="button"
                  disabled={busy || confirmText !== map.slug}
                  onClick={() =>
                    void run(async () => {
                      const result = await auth.deleteMap(slug, map.id, confirmText);
                      setConfirming(null);
                      if (result.brokenPortals.length > 0) {
                        useStore
                          .getState()
                          .notify(
                            `${map.name} is gone. ${result.brokenPortals.length} portal(s) now ` +
                              `point nowhere and will refuse rather than move anybody.`,
                          );
                      }
                    })
                  }
                  className="shrink-0 rounded px-2 py-1 text-[10px] uppercase tracking-wide
                             text-rose-300 hover:bg-rose-500/15 disabled:opacity-40
                             focus-visible:outline-none focus-visible:ring-2
                             focus-visible:ring-rose-300"
                >
                  delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* The Rules' dangling-portal case, from the other end: damage a previous
          delete left, shown so it can be repaired rather than discovered by
          somebody walking into a doorway that refuses. */}
      {overview.brokenPortals.length > 0 && (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-200/90">
          {overview.brokenPortals.length} portal(s) point at a room that no longer exists:{' '}
          {overview.brokenPortals
            .map((portal) => `${portal.mapName} → ${portal.targetMapId}`)
            .join(', ')}
          . Walking into one refuses with a message rather than moving anybody.
        </p>
      )}
    </section>
  );
}

/**
 * `FR-8.15` — a new Map.
 *
 * Contents are copied from an existing one rather than started empty, because a
 * Map with no floor and no spawn is a room `FR-8.7` cannot place anybody in.
 * Authoring the contents is phase 9; this phase adds rooms as units.
 */
function AddRoom({
  maps,
  busy,
  onCreate,
}: {
  maps: MapRecordDto[];
  busy: boolean;
  onCreate: (body: { slug: string; name: string; copyFromMapId?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState(maps.find((map) => map.isDefault)?.id ?? maps[0]?.id);

  // A slug people can type and a portal can name (`portalTargetSchema.mapId`),
  // derived rather than asked for: two fields where one will do is two fields to
  // get wrong, and the server refuses anything that is not lowercase-and-hyphens.
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return (
    <form
      className="mb-2 space-y-1.5 rounded-lg border border-white/10 bg-slate-950/40 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!slug) return;
        onCreate({ slug, name: name.trim(), ...(copyFrom ? { copyFromMapId: copyFrom } : {}) });
      }}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Room name"
        aria-label="Room name"
        className="w-full rounded border border-white/10 bg-slate-950/60 px-2 py-1 text-[11px]
                   text-slate-200 placeholder:text-slate-600 focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-sky-300"
      />
      <label className="flex items-center gap-2 text-[11px] text-slate-500">
        <span className="shrink-0">Copy layout from</span>
        <select
          value={copyFrom}
          onChange={(event) => setCopyFrom(event.target.value)}
          className="min-w-0 flex-1 rounded border border-white/10 bg-slate-950/60 px-1 py-1
                     text-slate-300 focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-sky-300"
        >
          {maps
            .filter((map) => !map.archivedAt)
            .map((map) => (
              <option key={map.id} value={map.id} className="bg-slate-900">
                {map.name}
              </option>
            ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-slate-600">
          {slug || 'name it first'}
        </span>
        <button
          type="submit"
          disabled={busy || !slug}
          className="shrink-0 rounded px-2 py-1 text-[10px] uppercase tracking-wide text-sky-300
                     hover:bg-sky-500/15 disabled:opacity-40 focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          create
        </button>
      </div>
    </form>
  );
}

function Action({
  label,
  title,
  onClick,
  busy,
  danger,
}: {
  label: string;
  title: string;
  onClick: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      title={title}
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide disabled:opacity-40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        danger ? 'text-rose-400/80 hover:bg-rose-500/15' : 'text-slate-400 hover:bg-white/10',
      )}
    >
      {label}
    </button>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <p className="mb-2 rounded-lg border border-rose-400/20 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200/90">
      {message}
    </p>
  );
}
