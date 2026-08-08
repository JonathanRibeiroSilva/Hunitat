/**
 * `FR-10.7`, `FR-10.10` — watching something together.
 *
 * ── What is actually shared ─────────────────────────────────────────────────
 *
 * Not the video. A `Y.Map` holding `{ state, positionMs, updatedAt }` — the
 * *intent*, stamped with when it was true. Every client plays its own copy and
 * corrects itself against that.
 *
 * Stamping matters more than it looks. A joiner who arrives four minutes after
 * somebody pressed play must seek to where the video is **now**, not to where it
 * was when the button was pressed — so the shared position is always read as
 * "this position, at that moment", and the elapsed time since is added.
 *
 * ── Why there is a tolerance ────────────────────────────────────────────────
 *
 * Correcting is worse than drifting, below a threshold: a seek is an audible and
 * visible jump, and half a second apart in a room watching together is not
 * something anybody notices. `VIDEO_SYNC_DRIFT_TOLERANCE_MS` is where the two
 * costs cross.
 */

import { useEffect, useRef } from 'react';
import {
  VIDEO_SYNC_DRIFT_TOLERANCE_MS,
  YJS_KEYS,
  videoSyncSchema,
  type VideoSyncState,
} from '@hubitat/protocol';
import type { CollabSession } from './collabClient.js';
import { useCollab } from './useCollab.js';

export function SharedVideo({ url, session }: { url: string; session: CollabSession }) {
  const { status } = useCollab(session);
  const video = useRef<HTMLVideoElement>(null);
  /** Set while this client is applying a remote state, so the `play`/`pause`
   *  events that follow are not read as somebody pressing a button. Without it,
   *  two clients bounce a correction back and forth forever. */
  const applying = useRef(false);

  const sync = session.doc.getMap<unknown>(YJS_KEYS.video);
  const parsed = videoSyncSchema.safeParse(Object.fromEntries(sync.entries()));
  const shared: VideoSyncState | null = parsed.success ? parsed.data : null;

  // Apply whatever the room has decided, whenever it changes.
  useEffect(() => {
    const element = video.current;
    if (!element || !shared) return;

    // Where the video is *now*, not where it was when the button was pressed.
    const elapsed = shared.state === 'playing' ? Math.max(0, Date.now() - shared.updatedAt) : 0;
    const target = (shared.positionMs + elapsed) / 1000;
    const drift = Math.abs(element.currentTime - target) * 1000;

    applying.current = true;
    if (drift > VIDEO_SYNC_DRIFT_TOLERANCE_MS) element.currentTime = target;
    if (shared.state === 'playing' && element.paused) {
      // Autoplay can be refused by the browser, and that is a normal outcome
      // rather than a failure: the person can press play, and doing so
      // re-broadcasts the same state the room already holds.
      void element.play().catch(() => undefined);
    }
    if (shared.state === 'paused' && !element.paused) element.pause();

    // Cleared on the next frame rather than immediately: `play()` and `pause()`
    // fire their events asynchronously, and clearing synchronously would let the
    // first one through as if a person had done it.
    const timer = window.setTimeout(() => {
      applying.current = false;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [shared?.state, shared?.positionMs, shared?.updatedAt, shared]);

  const publish = (state: 'playing' | 'paused'): void => {
    if (applying.current) return;
    const element = video.current;
    if (!element) return;
    session.mutate(() => {
      sync.set('state', state);
      sync.set('positionMs', Math.round(element.currentTime * 1000));
      sync.set('updatedAt', Date.now());
    });
  };

  if (status !== 'ready') {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {status === 'refused'
          ? (session.refusal ?? 'You cannot open this from here.')
          : 'Joining the room watching this…'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <video
        ref={video}
        src={url}
        controls
        onPlay={() => publish('playing')}
        onPause={() => publish('paused')}
        // A seek is an intent like any other: somebody dragging the scrubber is
        // moving the whole room, which is what "watching together" means.
        onSeeked={() => publish(video.current?.paused ? 'paused' : 'playing')}
        className="mx-auto max-h-[60vh] w-full rounded-lg bg-black"
      />
      <p className="text-[11px] text-slate-500">
        Watching together — play, pause and seeking are shared with everybody here. Playback
        position is not kept once everybody leaves.
      </p>
    </div>
  );
}
