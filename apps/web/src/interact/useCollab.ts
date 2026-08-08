/**
 * React's view of a CRDT — phase 10.
 *
 * A Yjs document is mutable and observed, and React is neither. `useCollab`
 * bridges them the only way that is correct: it subscribes to the session, bumps
 * a counter on every change, and lets the component re-read the document. There
 * is no derived copy in React state, because a copy is a second source of truth
 * for something whose entire purpose is being the only one.
 */

import { useEffect, useState } from 'react';
import type { CollabSession } from './collabClient.js';

/** Re-render whenever the session's document or status changes. */
export function useCollab(session: CollabSession): { status: CollabSession['status'] } {
  const [, bump] = useState(0);

  useEffect(() => {
    const unsubscribe = session.subscribe(() => bump((value) => value + 1));
    return unsubscribe;
  }, [session]);

  return { status: session.status };
}
