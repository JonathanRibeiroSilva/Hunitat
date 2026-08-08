/**
 * The emote bar — FR-4.14.
 *
 * Six reactions, clickable and bound to the number keys. Digits are free: the
 * movement bindings in specs/conventions/coordinates-and-units.md use WASD, the
 * arrows, Shift, Space and Q/E, so nothing here has to be taken away from
 * walking.
 *
 * The countdown is a **courtesy**. `EMOTE_MIN_INTERVAL_MS` is enforced on the
 * server (Phase 4 Rules) and a dropped emote is silently dropped; this exists so
 * a leaned-on key looks unavailable rather than broken. It is deliberately not
 * the mechanism — an anti-spam rule that lives in the client is not a rule.
 */

import { useEffect, useState } from 'react';
import { EMOTES } from '@hubitat/protocol';
import { Panel, cn } from '@hubitat/ui';
import { net } from '../net/client.js';
import { useStore } from '../state/store.js';
import { isTextEntry } from './keyboard.js';

export function EmoteBar() {
  const intervalMs = useStore((state) => state.tuning?.emoteMinIntervalMs ?? 0);
  const connected = useStore((state) => state.appState === 'in-world');

  /** When the local courtesy throttle lifts. Epoch ms, 0 when ready. */
  const [readyAt, setReadyAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Ticks only while cooling down. A permanent interval would re-render the HUD
  // several times a second for the entire session to animate nothing.
  useEffect(() => {
    if (readyAt <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [readyAt, now]);

  const cooling = readyAt > now;

  const send = (id: string): void => {
    if (!connected || cooling) return;
    net.emote(id);
    setNow(Date.now());
    setReadyAt(Date.now() + intervalMs);
  };

  // Bound on `window` rather than on the canvas, so an emote works whether the
  // pointer is over the scene or the HUD. Ignored while a text field has focus,
  // which is what stops "1" typing a digit and waving at the same time once
  // phase 5 adds a chat box.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntry(event.target)) return;

      const index = Number(event.key) - 1;
      const emote = EMOTES[index];
      if (!Number.isInteger(index) || !emote) return;

      event.preventDefault();
      send(emote.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const remaining = cooling ? Math.ceil((readyAt - now) / 100) / 10 : 0;

  return (
    // Above the media controls rather than beside them. Beside would have to
    // know how wide that bar is, and it is not always there at all — it renders
    // nothing when no SFU is configured, which would leave the emotes visibly
    // off-centre in exactly the setup phase 1 development runs in.
    //
    // "Above" is now the dock's business rather than this bar's: it used to be
    // `bottom-20`, a hard-coded guess at the height of the media panel that the
    // fault notice invalidated the moment it appeared.
    <Panel className="pointer-events-auto flex shrink-0 items-center gap-1 p-1.5">
      {EMOTES.map((emote, index) => (
        <button
          key={emote.id}
          type="button"
          onClick={() => send(emote.id)}
          disabled={!connected || cooling}
          // The number is in the label, not only in the corner glyph: a
          // keyboard user has to be able to discover the binding.
          title={`${emote.label} (${index + 1})`}
          aria-label={`${emote.label}, shortcut ${index + 1}`}
          aria-keyshortcuts={String(index + 1)}
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-lg text-lg',
            'transition-colors duration-150',
            'hover:bg-white/15 active:bg-white/5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          <span aria-hidden>{emote.glyph}</span>
          <span
            aria-hidden
            className="absolute bottom-0 right-1 text-[9px] font-medium text-slate-500"
          >
            {index + 1}
          </span>
        </button>
      ))}

      {cooling && (
        <span
          className="ml-1 w-8 shrink-0 text-right text-[10px] tabular-nums text-slate-500"
          role="status"
        >
          {remaining.toFixed(1)}s
        </span>
      )}
    </Panel>
  );
}
