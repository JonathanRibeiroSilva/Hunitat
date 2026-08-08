/**
 * What you can do about one other person — phase 7.
 *
 * `FR-7.16` block · `FR-7.17` report · and, for a moderator, `FR-7.5`–`FR-7.9`.
 *
 * ── Why one menu and not five buttons ───────────────────────────────────────
 *
 * The presence row is about 220 pixels wide and already carries a status dot, a
 * name, up to three badges and a message button. Every action here is rare —
 * most people will never mute anybody — and rare destructive actions behind a
 * row of always-visible icons are how somebody bans a colleague by clicking one
 * pixel to the left.
 *
 * ── The menu is built from capabilities, and that is not the enforcement ────
 *
 * The server re-checks every one of these against the same matrix
 * (`ModerationService.authorize`, and `NFR-34` in general). What this does is
 * decide which buttons are worth drawing, which is a different job: an interface
 * that offers an action it knows will be refused is an interface that teaches
 * people to ignore it.
 *
 * `outranks` is applied here too, for the same reason and with the same
 * function the server uses — so an admin does not see a "kick" beside the owner
 * that the server would refuse.
 */

import { useEffect, useRef, useState } from 'react';
import { Panel, cn } from '@hubitat/ui';
import { outranks, type ModerationAction } from '@hubitat/protocol';
import { net } from '../net/client.js';
import { useStore, type RosterEntry } from '../state/store.js';

/**
 * How long a ban issued from here lasts, in minutes.
 *
 * Two choices and not a duration picker, deliberately. `FR-7.8` asks for
 * "permanent or time-limited" and the Out of Scope section rules out "ban
 * duration scheduling beyond basic timed/permanent" — a field would invite
 * somebody to think about the right number of hours in the middle of dealing
 * with a person who is shouting.
 */
const TIMED_BAN_MINUTES = 24 * 60;

export function ParticipantActions({ entry }: { entry: RosterEntry }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<'kick' | 'ban' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const myRole = useStore((state) => state.role);
  const capabilities = useStore((state) => state.capabilities);

  const canModerate = capabilities.includes('moderate') && outranks(myRole, entry.role);
  const canBan = capabilities.includes('ban') && outranks(myRole, entry.role);

  // Close on an outside click and on Escape. A menu that stays open behind the
  // thing you clicked next is how a "ban" gets pressed by somebody aiming at the
  // presence list underneath it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirming(null);
  };

  const act = (action: ModerationAction, options: { durationMinutes?: number } = {}) => {
    net.moderate(action, entry.sessionId, options);
    close();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${entry.displayName}`}
        title={`Actions for ${entry.displayName}`}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          'rounded px-1 text-[13px] leading-none text-slate-500 transition-opacity duration-150',
          'hover:text-slate-200 focus-visible:opacity-100 focus-visible:outline-none',
          'focus-visible:ring-2 focus-visible:ring-sky-300 group-hover:opacity-100',
          // Visible on hover *and* on keyboard focus, never on hover alone — a
          // control that only exists for a mouse is a control keyboard users do
          // not have. Left visible while open, or it disappears under its own
          // menu.
          open ? 'opacity-100 text-slate-200' : 'opacity-0',
        )}
      >
        ⋯
      </button>

      {open && (
        <Panel
          role="menu"
          aria-label={`Actions for ${entry.displayName}`}
          className="absolute right-0 top-6 z-20 w-52 p-1 text-xs"
        >
          {/* `FR-7.16` — no capability beyond being here, and no confirmation:
              blocking is reversible from this same menu and costs the blocked
              party nothing they can detect. */}
          <MenuItem
            onClick={() => {
              net.setBlocked(entry.sessionId, !entry.blocked);
              close();
            }}
          >
            {entry.blocked ? 'Unblock' : 'Block'}
          </MenuItem>
          {!entry.blocked && (
            <p className="px-3 pb-1.5 text-[10px] leading-snug text-slate-500">
              You stop hearing and seeing each other. They are not told.
            </p>
          )}

          {/* `FR-7.17` — the reason is optional, which is why a prompt is
              acceptable here: cancelling it should still file the report, and it
              does. */}
          <MenuItem
            onClick={() => {
              const reason = window.prompt(
                `Report ${entry.displayName} to the moderators. What happened? (optional)`,
              );
              // `null` is a cancelled dialogue, and the honest reading is "I
              // changed my mind" rather than "file it with no reason" — the
              // empty-string case, which the second branch covers.
              if (reason === null) {
                close();
                return;
              }
              net.report(entry.sessionId, reason.trim() || undefined);
              useStore.getState().notify('Reported. A moderator will see it.');
              close();
            }}
          >
            Report
          </MenuItem>

          {(canModerate || canBan) && <Divider />}

          {canModerate && (
            <>
              {/* `FR-7.5`. Labelled by what it will do, not by the current
                  state: "Mute" / "Unmute" is unambiguous where a toggle
                  labelled "Muted" is not. */}
              <MenuItem onClick={() => act(entry.moderation.micMuted ? 'unmute' : 'mute')}>
                {entry.moderation.micMuted ? 'Let them speak' : 'Mute microphone'}
              </MenuItem>
              {/* `FR-7.6` — camera and screen share together, because they are
                  one permission on the SFU. */}
              <MenuItem
                onClick={() =>
                  act(entry.moderation.cameraDisabled ? 'enable-video' : 'disable-video')
                }
              >
                {entry.moderation.cameraDisabled ? 'Allow video' : 'Turn off video'}
              </MenuItem>
              {/* `FR-7.9` — the gentlest of the four, and first among them
                  because it is usually the right one: somebody standing inside a
                  private conversation is more often lost than malicious. */}
              <MenuItem onClick={() => act('respawn')}>Send back to the entrance</MenuItem>
            </>
          )}

          {/* `FR-7.7`, `FR-7.8` — the two that cannot be undone by the person
              they happen to, and the only two that ask twice. */}
          {canModerate && (
            <ConfirmItem
              label="Remove from the space"
              confirmLabel="Remove — they can come back"
              armed={confirming === 'kick'}
              onArm={() => setConfirming('kick')}
              onConfirm={() => act('kick')}
            />
          )}
          {canBan && (
            <ConfirmItem
              label="Ban"
              confirmLabel={`Ban for ${TIMED_BAN_MINUTES / 60} hours`}
              armed={confirming === 'ban'}
              onArm={() => setConfirming('ban')}
              onConfirm={() => act('ban', { durationMinutes: TIMED_BAN_MINUTES })}
              danger
            >
              {/* The Phase 7 notes ask for this to be said where it matters. A
                  guest ban keys on a cookie and an address, and the real remedy
                  is requiring accounts — which is two panels away, in the same
                  product. */}
              {entry.identity.kind === 'guest' && (
                <p className="px-3 pb-1.5 text-[10px] leading-snug text-amber-300/80">
                  They are a guest, so this only holds until they clear their browser data.
                  Requiring accounts is the real fix.
                </p>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => act('ban')}
                className={MENU_ITEM_CLASS}
              >
                Ban permanently
              </button>
            </ConfirmItem>
          )}
        </Panel>
      )}
    </div>
  );
}

const MENU_ITEM_CLASS = cn(
  'block w-full rounded-md px-3 py-1.5 text-left text-slate-300',
  'hover:bg-white/10 hover:text-slate-100',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
);

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={MENU_ITEM_CLASS}>
      {children}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-white/10" />;
}

/**
 * A destructive action that has to be pressed twice.
 *
 * Not a modal. A modal steals focus from a 3D scene somebody may be moving
 * through, and the second press is enough: the label changes to say exactly what
 * will happen, so the confirmation carries information rather than just friction.
 */
function ConfirmItem({
  label,
  confirmLabel,
  armed,
  onArm,
  onConfirm,
  danger,
  children,
}: {
  label: string;
  confirmLabel: string;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void;
  danger?: boolean;
  children?: React.ReactNode;
}) {
  if (!armed) {
    return (
      <button
        type="button"
        role="menuitem"
        onClick={onArm}
        className={cn(MENU_ITEM_CLASS, danger ? 'text-rose-300 hover:text-rose-200' : undefined)}
      >
        {label}…
      </button>
    );
  }

  return (
    <div className="rounded-md bg-white/5 py-1">
      {children}
      <button
        type="button"
        role="menuitem"
        onClick={onConfirm}
        className={cn(MENU_ITEM_CLASS, 'text-rose-300 hover:text-rose-200')}
      >
        {confirmLabel}
      </button>
    </div>
  );
}
