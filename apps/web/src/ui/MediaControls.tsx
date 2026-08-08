/**
 * Microphone, camera and screen share — the bottom of the centre control dock.
 *
 * specs/ux/phase-01-screens.md left this slot open for phase 2 and said not to
 * stub it. This is the thing it was left open for.
 *
 * It does not position itself: `Hud` stacks it under the emote bar in the
 * bottom-centre dock. Pinning it to `bottom-4` on its own put it in the exact
 * spot the closed chat button also claimed, and left the emote bar guessing at
 * this bar's height — a guess the fault notice broke by growing upwards into it.
 *
 * FR-2.3 requires immediate local feedback, so every toggle updates its own
 * state optimistically and the media client reverts it if the device refuses.
 * That means a button is never waiting on the SFU to look pressed.
 */

import { useEffect, useState } from 'react';
import { Panel, cn } from '@hubitat/ui';
import { media } from '../media/mediaClient.js';
import { useMediaStore, type MediaFault } from '../state/mediaStore.js';
import { useStore } from '../state/store.js';

export function MediaControls() {
  const status = useMediaStore((state) => state.status);
  const micEnabled = useMediaStore((state) => state.micEnabled);
  const cameraEnabled = useMediaStore((state) => state.cameraEnabled);
  const screenShareEnabled = useMediaStore((state) => state.screenShareEnabled);
  /**
   * Phase 7, `FR-7.5` / `FR-7.6` — what a moderator has taken away.
   *
   * The buttons are **disabled**, not hidden. A control that vanishes reads as a
   * bug in the interface; one that is present, dark and explains itself reads as
   * what actually happened. `FR-7.5` requires the target to be notified, and this
   * is the part of that notification that is still there five minutes later.
   */
  const forced = useMediaStore((state) => state.forcedMute);

  if (status === 'unavailable') return null;

  const busy = status === 'connecting';

  return (
    // `z-10` so a device menu, which opens upwards out of this panel, draws
    // over the emote bar sitting directly above it rather than under it.
    <div className="pointer-events-auto z-10 flex flex-col items-center">
      <MediaFaultNotice />
      <ForcedMuteNotice />
      <Panel className="flex items-center gap-1 p-1.5">
        <Toggle
          label="Microphone"
          on={micEnabled && !forced.micMuted}
          disabled={busy || forced.micMuted}
          reason={forced.micMuted ? 'A moderator has muted you' : undefined}
          onClick={() => void media.setMicrophoneEnabled(!micEnabled)}
          icon={micEnabled && !forced.micMuted ? <MicIcon /> : <MicOffIcon />}
        />
        <DevicePicker kind="audioinput" disabled={busy} />

        <span className="mx-1 h-6 w-px bg-white/10" />

        <Toggle
          label="Camera"
          on={cameraEnabled && !forced.cameraDisabled}
          disabled={busy || forced.cameraDisabled}
          reason={forced.cameraDisabled ? 'A moderator has turned off your video' : undefined}
          onClick={() => void media.setCameraEnabled(!cameraEnabled)}
          icon={cameraEnabled && !forced.cameraDisabled ? <CameraIcon /> : <CameraOffIcon />}
        />
        <DevicePicker kind="videoinput" disabled={busy} />

        <span className="mx-1 h-6 w-px bg-white/10" />

        <Toggle
          label="Share screen"
          on={screenShareEnabled && !forced.cameraDisabled}
          disabled={busy || forced.cameraDisabled}
          reason={forced.cameraDisabled ? 'A moderator has turned off your video' : undefined}
          onClick={() => void media.setScreenShareEnabled(!screenShareEnabled)}
          icon={<ScreenIcon />}
        />
      </Panel>
    </div>
  );
}

/**
 * `FR-7.5` — why the buttons are dark.
 *
 * Above the controls, in the same slot as the device-fault notice and styled
 * like it, because to the person reading it the two are the same question:
 * "why can nobody hear me". The answers differ entirely, and so does what they
 * can do about it — which is why this is not folded into `MediaFault`.
 *
 * Not dismissible, unlike a fault. A device problem is over once you have read
 * it; this is a state that lasts until somebody else ends it.
 */
function ForcedMuteNotice() {
  const moderation = useStore((state) => state.moderation);
  if (!moderation?.micMuted && !moderation?.cameraDisabled) return null;

  const what =
    moderation.micMuted && moderation.cameraDisabled
      ? 'Your microphone and video are'
      : moderation.micMuted
        ? 'Your microphone is'
        : 'Your video is';

  return (
    <Panel
      role="status"
      className="mb-2 max-w-md border-amber-400/30 bg-amber-950/80 px-4 py-2 text-xs text-amber-100"
    >
      {what} turned off{moderation.byName ? ` by ${moderation.byName}` : ' by a moderator'}.
      {moderation.reason ? ` ${moderation.reason}` : ''} You cannot turn it back on yourself.
    </Panel>
  );
}

/**
 * A toggle whose state is carried by more than colour.
 *
 * The icon changes shape (a struck-through mic when muted) and `aria-pressed`
 * carries it for assistive technology — the UX spec's rule that colour is never
 * the only signal.
 */
function Toggle({
  label,
  on,
  disabled,
  onClick,
  icon,
  reason,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  /** Phase 7 — why this control is dark, when it is dark for a reason somebody
   *  else chose. Carried into the accessible name as well as the tooltip: a
   *  disabled button with no explanation is indistinguishable from a broken one,
   *  and that is truer with a screen reader than without. */
  reason?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={reason ? `${label}: ${reason}` : `${label}: ${on ? 'on' : 'off'}`}
      title={reason ?? `${label} — ${on ? 'on' : 'off'}`}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        'disabled:cursor-not-allowed disabled:opacity-40',
        on
          ? 'bg-sky-500 text-white hover:bg-sky-400'
          : 'bg-white/10 text-slate-300 hover:bg-white/20',
      )}
    >
      {icon}
    </button>
  );
}

/** FR-2.2 — switch input device while connected. */
function DevicePicker({ kind, disabled }: { kind: MediaDeviceKind; disabled: boolean }) {
  const devices = useMediaStore((state) =>
    kind === 'audioinput' ? state.microphones : state.cameras,
  );
  const active = useMediaStore((state) =>
    kind === 'audioinput' ? state.activeMicrophoneId : state.activeCameraId,
  );
  const [open, setOpen] = useState(false);

  // Nothing to choose between is not a menu, it is a dead arrow.
  if (devices.length < 2) return null;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={kind === 'audioinput' ? 'Choose microphone' : 'Choose camera'}
        className="flex h-10 w-5 items-center justify-center rounded-lg text-slate-400
                   hover:bg-white/10 hover:text-slate-100 focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-40"
      >
        <svg viewBox="0 0 8 8" className="h-2 w-2 fill-current" aria-hidden="true">
          <path d="M0 2h8L4 7z" />
        </svg>
      </button>

      {open && (
        <Panel className="absolute bottom-12 left-1/2 max-h-56 w-64 -translate-x-1/2 overflow-y-auto p-1">
          {devices.map((device) => (
            <button
              key={device.deviceId}
              type="button"
              onClick={() => {
                void media.switchDevice(kind, device.deviceId);
                setOpen(false);
              }}
              className={cn(
                'block w-full truncate rounded-md px-3 py-2 text-left text-xs',
                'hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
                device.deviceId === active && 'text-sky-300',
              )}
            >
              {/* Blank until a permission has been granted once — a browser
                  privacy rule, not a bug. */}
              {device.label ||
                `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${device.deviceId.slice(0, 6)}`}
            </button>
          ))}
        </Panel>
      )}
    </div>
  );
}

/**
 * FR-2.5 — a clear state when a device is denied or missing.
 *
 * Above the controls rather than replacing them: presence and the world are
 * unaffected by a media failure, and hiding the buttons would suggest otherwise.
 */
const FAULT_TEXT: Record<MediaFault, string> = {
  'permission-denied':
    'Microphone and camera are blocked. Allow them in your browser’s site settings, then try again.',
  'no-device': 'No microphone or camera was found.',
  'insecure-context': 'Voice and video need a secure connection (HTTPS, or localhost).',
  'connect-failed': 'Could not reach the voice server. You can still move and see everyone.',
  'audio-blocked': 'Click anywhere to let this page play audio.',
};

function MediaFaultNotice() {
  const fault = useMediaStore((state) => state.fault);
  const detail = useMediaStore((state) => state.faultDetail);
  const [dismissed, setDismissed] = useState<MediaFault | null>(null);

  useEffect(() => {
    // A new fault always speaks, even if the previous one was dismissed.
    if (fault && fault !== dismissed) setDismissed(null);
  }, [fault, dismissed]);

  if (!fault || fault === dismissed) return null;

  return (
    <Panel
      role="status"
      className="mb-2 flex max-w-md items-start gap-3 border-amber-400/30 bg-amber-950/80 px-4 py-2"
    >
      <div className="flex-1 text-xs text-amber-100">
        {FAULT_TEXT[fault]}
        {detail && <span className="mt-0.5 block text-amber-300/60">{detail}</span>}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(fault)}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 text-amber-300/70 hover:text-amber-100
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
      >
        ×
      </button>
    </Panel>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────
// Inline rather than an icon dependency: five shapes do not justify a package,
// and these inherit `currentColor` so the toggle states style them for free.

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 11l7-4v10l-7-4z" strokeLinejoin="round" />
    </svg>
  );
}

function CameraOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 11l7-4v10l-7-4zM4 4l16 16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" strokeLinecap="round" />
    </svg>
  );
}
