/**
 * `DC-8.5 Space Directory` — `FR-8.12`, `FR-8.13`, `FR-8.14`.
 *
 * Which rooms exist, how busy each one is, who is where, and one click to go
 * there. Three requirements in one panel because they are one question — "where
 * is everybody and how do I get to them" — and splitting it into a map list and
 * a people list would make somebody read both to answer it.
 *
 * ── This panel is also how `FR-8.10` stops being baffling ───────────────────
 *
 * Two people in different copies of the same room, unable to see or hear each
 * other, is the phase's sharpest user-interface problem: nothing about the world
 * itself says why. So a Map running more than one instance is drawn as its
 * copies, each with its own headcount, with the one you are in marked — and a
 * person in another copy has "join" beside their name rather than only a
 * location. The server names the copies (`instanceLabel`), so every client says
 * the same thing.
 *
 * ── Counts for everybody, names for members ─────────────────────────────────
 *
 * `FR-8.12` says "subject to permissions" and leaves the line unspecified. The
 * server draws it at membership and sends a guest no `people` at all, so this
 * panel simply renders what it was given: a guest sees rooms and headcounts, a
 * member sees colleagues. Nothing here decides that, which is the point — a
 * client-side filter over a list it had already received would be a disclosure
 * with a checkbox in front of it.
 */

import { useEffect, useState } from 'react';
import { Panel, cn } from '@hubitat/ui';
import type { MapDirectoryEntryDto } from '@hubitat/protocol';
import { net } from '../net/client.js';
import { useStore } from '../state/store.js';
import { RoomManager } from './RoomManager.jsx';

export function PlacesPanel({
  onClose,
  /** Phase 9 — open a Map in the editor. Threaded through rather than dispatched
   *  because the editor replaces the whole screen, and `App` owns which screen
   *  is showing. */
  onEdit,
}: {
  onClose: () => void;
  onEdit: (mapId: string, spaceSlug: string) => void;
}) {
  const directory = useStore((state) => state.directory);
  const place = useStore((state) => state.place);
  const selfSessionId = useStore((state) => state.joined?.sessionId);
  /**
   * `FR-8.15`, `FR-8.16` — whether to offer the management section at all.
   *
   * From the capability list the server issued on `JOINED` / `IDENTITY`, so it
   * disappears the moment somebody is demoted rather than at their next reload.
   * Advisory in one direction only: the section re-checks with the server before
   * it draws anything, and every endpoint behind it is guarded (`NFR-34`).
   */
  const canManageMaps = useStore((state) => state.capabilities.includes('manage-maps'));

  // Pushed on change anyway; asked for here so a panel that has just been opened
  // does not show a second of nothing while the next push is due.
  useEffect(() => {
    net.requestDirectory();
  }, []);

  const [filter, setFilter] = useState('');

  if (!directory) {
    return (
      <Panel className="pointer-events-auto w-80 max-w-(--hud-rail) shrink-0 p-4 text-sm">
        <Header onClose={onClose} title="Places" />
        <p className="mt-3 text-xs text-slate-500">Asking the server what is here…</p>
      </Panel>
    );
  }

  const query = filter.trim().toLowerCase();
  const people = directory.people.filter(
    (person) =>
      person.sessionId !== selfSessionId &&
      (query === '' || person.displayName.toLowerCase().includes(query)),
  );

  return (
    <Panel className="pointer-events-auto flex max-h-112 w-80 max-w-(--hud-rail) shrink-0 flex-col p-4 text-sm">
      <Header onClose={onClose} title={directory.spaceName} />

      <p className="mt-1 shrink-0 text-xs text-slate-500">
        You are in <span className="text-slate-300">{place?.instanceLabel ?? '…'}</span>
        {place && place.instanceCount > 1 && (
          <>
            {' '}
            — one of {place.instanceCount} copies of this room. People in the others cannot see or
            hear you.
          </>
        )}
      </p>

      <div className="mt-3 min-h-0 shrink space-y-4 overflow-y-auto pr-1">
        <section>
          <h3 className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Rooms</h3>
          <ul className="space-y-1">
            {directory.maps.map((map) => (
              <MapRow
                key={map.mapId}
                map={map}
                hereMapId={directory.hereMapId}
                hereInstanceId={directory.hereInstanceId}
              />
            ))}
          </ul>
        </section>

        {/* `FR-8.14` — "go to a member". Absent entirely for a guest, because
            the server sent no names; an empty list with a search box would
            suggest the feature was broken rather than not theirs. */}
        {directory.people.length > 0 && (
          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">People</h3>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find somebody"
              aria-label="Find somebody"
              className="mb-2 w-full rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1
                         text-xs text-slate-200 placeholder:text-slate-600
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            />
            <ul className="space-y-1">
              {people.length === 0 && (
                <li className="px-1 py-2 text-xs text-slate-600">Nobody else is in this space.</li>
              )}
              {people.map((person) => {
                const map = directory.maps.find((entry) => entry.mapId === person.mapId);
                return (
                  <li key={person.sessionId} className="flex items-center gap-2 px-1 py-1">
                    <span className="min-w-0 flex-1 truncate text-slate-200">
                      {person.displayName}
                    </span>
                    <span className="shrink-0 truncate text-[11px] text-slate-500">
                      {map?.name ?? 'elsewhere'}
                    </span>
                    {person.here ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-600">
                        here
                      </span>
                    ) : (
                      <button
                        type="button"
                        // The *person*, not their instance id: `FR-8.14` says
                        // "go to a member" reuses the assignment rules, so the
                        // server resolves where they are and applies capacity —
                        // naming their instance from here would go stale between
                        // the push and the click.
                        onClick={() => net.navigate({ followSessionId: person.sessionId })}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase
                                   tracking-wide text-sky-400 hover:bg-sky-500/15
                                   focus-visible:outline-none focus-visible:ring-2
                                   focus-visible:ring-sky-300"
                      >
                        go to
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {canManageMaps && <RoomManager slug={directory.spaceSlug} onEdit={onEdit} />}
      </div>
    </Panel>
  );
}

/**
 * One Map, with its copies underneath when there is more than one.
 *
 * The copies are only drawn when they exist, which is the same restraint the
 * label itself uses: in the ordinary case there is one instance and listing it
 * would invent a distinction nobody needs.
 */
function MapRow({
  map,
  hereMapId,
  hereInstanceId,
}: {
  map: MapDirectoryEntryDto;
  hereMapId: string;
  hereInstanceId: string;
}) {
  const here = map.mapId === hereMapId;
  const full = map.instances.length > 0 && map.instances.every((instance) => instance.full);

  return (
    <li>
      <button
        type="button"
        disabled={!map.reachable}
        onClick={() => net.navigate({ mapId: map.mapId })}
        title={map.reachable ? `Go to ${map.name}` : (map.reason ?? 'You cannot go there')}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          map.reachable ? 'hover:bg-white/5' : 'cursor-not-allowed opacity-50',
          here && 'bg-sky-500/10',
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {map.name}
          {map.isDefault && (
            <span
              title="Where people land when they arrive"
              className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-600"
            >
              landing
            </span>
          )}
        </span>
        {here && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-sky-400/80">here</span>
        )}
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            full ? 'text-amber-400' : 'text-slate-500',
          )}
          title={`${map.occupancy} of ${map.capacity} per copy`}
        >
          {map.occupancy}
        </span>
      </button>

      {/* `FR-8.10` made visible. Only when a Map has actually spilled: one copy
          is the ordinary case and a list of one would be noise. */}
      {map.instances.length > 1 && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-white/10 pl-2">
          {map.instances.map((instance) => (
            <li key={instance.instanceId}>
              <button
                type="button"
                onClick={() => net.navigate({ instanceId: instance.instanceId })}
                disabled={instance.instanceId === hereInstanceId}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
                  instance.instanceId === hereInstanceId
                    ? 'text-sky-300'
                    : 'text-slate-400 hover:bg-white/5',
                )}
                title={
                  instance.full
                    ? `${instance.label} is full — you would be put in another copy`
                    : `Join ${instance.label}`
                }
              >
                <span className="min-w-0 flex-1 truncate">{instance.label}</span>
                {instance.full && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-400/80">
                    full
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-slate-500">{instance.occupancy}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4">
      <h2 className="text-sm font-medium text-slate-100">{title}</h2>
      <button
        onClick={onClose}
        aria-label="Close places"
        className="shrink-0 rounded px-1.5 text-slate-500 hover:text-slate-200
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      >
        ×
      </button>
    </div>
  );
}
