/**
 * `FR-10.2`, `FR-10.4` — the interact affordance.
 *
 * One prompt, for the nearest object only, with the same key and the same words
 * whatever the content type is. The Rules ask for consistency and
 * discoverability across types, and the way to fail that is to let each type
 * invent its own verb: "read", "watch", "open", "join". It is always `E`, and it
 * always says what the thing is.
 */

import { useEffect } from 'react';
import { Panel } from '@hubitat/ui';
import type { PlacedObject } from '@hubitat/protocol';
import { useStore } from '../state/store.js';
import { useInteractStore } from '../state/interactStore.js';
import { CollabSession } from './collabClient.js';

export function InteractPrompt() {
  const nearest = useInteractStore((state) => state.nearest);
  const open = useInteractStore((state) => state.open);
  const openObject = useInteractStore((state) => state.openObject);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e') return;
      // Not while typing. The chat composer is one keystroke away at all times,
      // and a prompt that stole `e` from it would make the room unusable.
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.isContentEditable) return;

      const state = useInteractStore.getState();
      if (state.open || !state.nearest) return;
      openInteractive(state.nearest.object, openObject);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openObject]);

  if (!nearest || open) return null;

  return (
    <Panel className="pointer-events-auto shrink-0 border-sky-400/30 bg-sky-950/70 px-4 py-2">
      <button
        type="button"
        onClick={() => openInteractive(nearest.object, openObject)}
        className="text-sm text-sky-100"
      >
        <kbd className="mr-2 rounded border border-sky-300/40 px-1.5 py-0.5 font-mono text-[11px]">
          E
        </kbd>
        {label(nearest.object)}
      </button>
    </Panel>
  );
}

/**
 * Open one object.
 *
 * A shared object gets a CRDT session; a per-participant one gets none — and
 * that absence is the enforcement of the Rules' "per-participant content must
 * not leak", rather than a check somewhere that could be forgotten.
 *
 * The resume token is what proves the session to `/collab` (`FR-10.14`). It is
 * the same secret the guest-upgrade endpoint accepts and for the same reason: a
 * session id is broadcast to everybody in range, and a resume token is not.
 */
function openInteractive(
  object: PlacedObject,
  openObject: (object: PlacedObject, session: CollabSession | null) => void,
): void {
  const interactive = object.interactive;
  const store = useStore.getState();

  if (!interactive?.shared) {
    openObject(object, null);
    return;
  }

  const mapId = store.place?.mapId;
  const resumeToken = store.joined?.resumeToken;
  if (!mapId || !resumeToken) {
    // No session to prove — which can only happen between screens. Opening the
    // content without the shared half is better than refusing: a whiteboard that
    // says "connecting" is more use than a button that does nothing.
    openObject(object, null);
    return;
  }

  openObject(object, new CollabSession(mapId, object.id, resumeToken));
}

/** `FR-10.4` — one verb per *kind of thing*, not per implementation. */
function label(object: PlacedObject): string {
  const interactive = object.interactive;
  const title = (interactive?.content as { title?: string; label?: string } | undefined)?.title;
  const noun =
    interactive?.contentType === 'link'
      ? 'link'
      : interactive?.contentType === 'image'
        ? 'image'
        : interactive?.contentType === 'video'
          ? 'video'
          : interactive?.contentType === 'document'
            ? 'document'
            : interactive?.shared
              ? 'shared board'
              : 'note';
  return title ? `Open ${title}` : `Open this ${noun}`;
}
