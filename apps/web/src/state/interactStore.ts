/**
 * `DC-10.4 Interaction Session` — which object is in reach, and which one is
 * open.
 *
 * ── One prompt at a time ────────────────────────────────────────────────────
 *
 * The Phase 10 Rules are explicit: "interact prompts must not clutter: show for
 * the nearest/targeted object, not every object at once". So this holds exactly
 * one `nearest`, chosen by distance, and a room of posters produces one prompt
 * rather than nine.
 *
 * ── Proximity is computed, not pushed ───────────────────────────────────────
 *
 * The server does not send a "you are near an object" frame, and deliberately.
 * The client already knows where it is — it is authoritative over its own
 * position (ADR 0004) — and the objects are in the Map Document it has loaded.
 * A server-side proximity test would be a tick-rate answer to a frame-rate
 * question, and it would arrive 50 ms late for a prompt that appears as you
 * walk.
 *
 * What the *server* does enforce is the thing that matters: `FR-10.14` refuses
 * a shared object's channel to somebody who is not actually in range. The prompt
 * is a courtesy, the check is a control, and they are in the right places.
 */

import { create } from 'zustand';
import type { PlacedObject } from '@hubitat/protocol';
import type { CollabSession } from '../interact/collabClient.js';

/** The nearest interactive object, with the distance that made it nearest. */
export interface NearbyObject {
  object: PlacedObject;
  distanceM: number;
}

interface InteractStore {
  /** `FR-10.2` — what the prompt is for, or null. One at a time. */
  nearest: NearbyObject | null;
  /** `FR-10.3` — the object whose content is on screen, or null. */
  open: PlacedObject | null;
  /** `FR-10.11` — the CRDT session for an open shared object. Null for a
   *  per-participant one, which has no shared state and needs no socket. */
  session: CollabSession | null;

  setNearest: (nearest: NearbyObject | null) => void;
  openObject: (object: PlacedObject, session: CollabSession | null) => void;
  closeObject: () => void;
}

export const useInteractStore = create<InteractStore>((set, get) => ({
  nearest: null,
  open: null,
  session: null,

  setNearest: (nearest) =>
    set((state) => {
      // Compared by id rather than by object identity: the document is
      // re-created on every draft edit in the editor, and re-rendering the
      // prompt on every frame because the reference changed would make it flicker.
      if (state.nearest?.object.id === nearest?.object.id) {
        // Still the same object — only update if the distance moved enough to
        // matter to anything reading it. Nothing does yet; the guard is here so
        // that when something does, it does not get a new object per frame.
        if (
          state.nearest &&
          nearest &&
          Math.abs(state.nearest.distanceM - nearest.distanceM) < 0.1
        ) {
          return state;
        }
      }
      return { nearest };
    }),

  openObject: (object, session) => {
    // Never two at once. Opening a second panel while the first has a live
    // socket would leave that socket open with nothing reading it.
    const previous = get().session;
    if (previous) previous.close();
    set({ open: object, session });
  },

  closeObject: () => {
    const session = get().session;
    // `FR-10.17` — closing is safe at any moment: a CRDT has no per-connection
    // state, so there is nothing here to unwind for the people still drawing.
    if (session) session.close();
    set({ open: null, session: null });
  },
}));
