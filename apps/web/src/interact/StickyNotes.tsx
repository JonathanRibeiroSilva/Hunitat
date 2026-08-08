/**
 * `FR-10.11` — sticky notes, as a `Y.Map`.
 *
 * A map keyed by note id rather than an array, because the operations people
 * perform on sticky notes are "move this one" and "edit this one", and both are
 * a write to one key. In an array they would be a splice, and two people moving
 * two different notes at once would be two splices racing over one index space.
 */

import { useState } from 'react';
import { YJS_KEYS } from '@hubitat/protocol';
import type { CollabSession } from './collabClient.js';
import { useCollab } from './useCollab.js';

interface Note {
  /** 0..1 board space, so the wall is the same wall on every screen size. */
  x: number;
  y: number;
  text: string;
  color: string;
}

const COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff'];

export function StickyNotes({ session }: { session: CollabSession }) {
  const { status } = useCollab(session);
  const [dragging, setDragging] = useState<string | null>(null);

  const notes = session.doc.getMap<Note>(YJS_KEYS.notes);

  if (status !== 'ready') {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {status === 'refused'
          ? (session.refusal ?? 'You cannot open this from here.')
          : 'Loading what is on this wall…'}
      </p>
    );
  }

  const add = (): void => {
    const id = `note-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    session.mutate(() =>
      notes.set(id, {
        // Placed near the middle with a little scatter, so two people adding at
        // once do not stack exactly.
        x: 0.35 + Math.random() * 0.3,
        y: 0.3 + Math.random() * 0.3,
        text: '',
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      }),
    );
  };

  const entries = [...notes.entries()] as [string, Note][];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={add}
          className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-100 hover:bg-sky-500/30"
        >
          + Note
        </button>
        <span className="text-[11px] text-slate-500">
          Drag to move. Everybody here sees the same wall.
        </span>
      </div>

      <div
        className="relative h-[55vh] w-full overflow-hidden rounded-lg bg-slate-900"
        onPointerMove={(event) => {
          if (!dragging) return;
          const note = notes.get(dragging);
          if (!note) return;
          const rect = event.currentTarget.getBoundingClientRect();
          session.mutate(() =>
            notes.set(dragging, {
              ...note,
              // Clamped, so a note dragged off the edge is not lost somewhere
              // nobody can reach it.
              x: Math.min(0.95, Math.max(0, (event.clientX - rect.left) / rect.width)),
              y: Math.min(0.9, Math.max(0, (event.clientY - rect.top) / rect.height)),
            }),
          );
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {entries.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-600">
            Nothing here yet.
          </p>
        )}

        {entries.map(([id, note]) => (
          <div
            key={id}
            style={{
              left: `${note.x * 100}%`,
              top: `${note.y * 100}%`,
              backgroundColor: note.color,
            }}
            className="absolute w-40 rounded-md p-2 shadow-lg"
          >
            <div
              onPointerDown={() => setDragging(id)}
              className="mb-1 h-3 cursor-grab rounded-sm bg-black/10"
              aria-label="Drag this note"
            />
            <textarea
              value={note.text}
              placeholder="…"
              onChange={(event) =>
                session.mutate(() => notes.set(id, { ...note, text: event.target.value }))
              }
              className="h-20 w-full resize-none border-0 bg-transparent text-xs text-slate-900 placeholder:text-slate-500 focus-visible:outline-none"
            />
            <button
              type="button"
              onClick={() => session.mutate(() => notes.delete(id))}
              aria-label="Remove this note"
              className="absolute right-1 top-1 rounded px-1 text-[10px] text-slate-700/60 hover:text-slate-900"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
