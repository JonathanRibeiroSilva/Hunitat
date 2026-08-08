/**
 * The in-world HUD — specs/ux/phase-01-screens.md
 *
 * Four docks, not eleven independently pinned panels:
 *
 *     ┌──────────────────────────────────────────────────────────┐
 *     │ video strip     reconnecting / notice          presence   │
 *     │                 shared screen                             │
 *     │                                                           │
 *     │                                               avatar      │
 *     │ controls hint                                             │
 *     │ chat            emotes / media            you  ·  status  │
 *     └──────────────────────────────────────────────────────────┘
 *
 * Each dock is a flex column, so its contents queue and the browser keeps them
 * apart. Every panel used to anchor itself to a corner with its own offset, and
 * anything that picked the same corner drew straight through its neighbour —
 * the chat button sat on the media bar, the open chat panel sat on the controls
 * hint, a shared screen sat on the reconnect banner, and the emote bar's
 * `bottom-20` was a guess at the media bar's height that the fault notice broke.
 *
 * The rails clamp against `--hud-rail` (index.css) so they shrink on a narrow
 * window rather than reaching under the centre dock. Positioning lives here;
 * the panels themselves only decide how big they are.
 */

import { useCallback, useEffect, useState } from 'react';
import { Panel, PresenceDot, StatusDot, cn, type Presence } from '@hubitat/ui';
import { net } from '../net/client.js';
import { useChatStore } from '../state/chatStore.js';
import { useMediaStore } from '../state/mediaStore.js';
import { inPrivateZone, inSpotlight, useStore, type RosterEntry } from '../state/store.js';
import { AccountPanel } from './AccountPanel.jsx';
import { AvatarCustomizer } from './AvatarCustomizer.jsx';
import { ChatPanel } from './ChatPanel.jsx';
import { EmoteBar } from './EmoteBar.jsx';
import { MediaControls } from './MediaControls.jsx';
import { ModerationPanel } from './ModerationPanel.jsx';
import { ParticipantActions } from './ParticipantActions.jsx';
import { PlacesPanel } from './PlacesPanel.jsx';
import { ScreenShareTiles, VideoTiles } from './VideoTiles.jsx';
import { InteractPrompt } from '../interact/InteractPrompt.jsx';
import { InteractionPanel } from '../interact/InteractionPanel.jsx';

const HINT_DISMISSED_KEY = 'hubitat.hintDismissed';

export function Hud({
  /** Phase 9 — open the map editor. Passed down rather than dispatched, because
   *  the editor replaces the whole screen and `App` is what owns which screen is
   *  showing. */
  onEdit,
}: {
  onEdit: (mapId: string, spaceSlug: string) => void;
}) {
  // Held here rather than inside SelfStatus so the customizer can render as a
  // sibling of the panel that opens it, instead of inside a flex row it would
  // have to escape from.
  const [customizing, setCustomizing] = useState(false);

  /** Phase 6 — the account panel, held here for the same reason: it renders as a
   *  sibling of the status panel that opens it rather than inside the flex row it
   *  would otherwise have to escape from. */
  const [accountOpen, setAccountOpen] = useState(false);

  /** Phase 7 — the moderation panel, held here for the same reason as the two
   *  above. It is a third "panel about the space" and the three are mutually
   *  exclusive in practice. */
  const [moderationOpen, setModerationOpen] = useState(false);

  /** Phase 8 — the Space directory (`DC-8.5`). A fourth "panel about the space",
   *  held here for the same reason as the three above and mutually exclusive
   *  with them in practice. */
  const [placesOpen, setPlacesOpen] = useState(false);

  // Lifted out of ControlsHint so the status panel can offer it again.
  // Dismissing it was previously irreversible: nothing anywhere in the client
  // could bring the key bindings back, which is a poor trade for one panel of
  // screen space. It still only *opens itself* on a first visit.
  const [hintOpen, setHintOpen] = useState(() => localStorage.getItem(HINT_DISMISSED_KEY) !== '1');

  const dismissHint = useCallback(() => {
    setHintOpen(false);
    localStorage.setItem(HINT_DISMISSED_KEY, '1');
  }, []);

  // Re-opening is for this session only — the stored flag stays set, so the
  // hint does not come back uninvited on the next join.
  const toggleHint = useCallback(() => {
    if (hintOpen) dismissHint();
    else setHintOpen(true);
  }, [hintOpen, dismissHint]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/*
        Left rail — faces at the top, what you are saying at the bottom.

        `justify-between` with two children rather than two separate anchors:
        the strip gives way to the chat panel when the window is short, instead
        of the two of them overlapping in the middle.
      */}
      <div className="absolute inset-y-4 left-4 flex flex-col items-start justify-between gap-3">
        <div className="pointer-events-auto flex min-h-0 shrink flex-col overflow-y-auto">
          <VideoTiles />
        </div>
        <div className="flex shrink-0 flex-col items-start gap-3">
          {hintOpen && <ControlsHint onDismiss={dismissHint} />}
          <ChatPanel />
        </div>
      </div>

      {/*
        Top centre — everything transient, in the order it matters, above the
        presenter's screen. One column, so a screen share pushes the banners
        down instead of appearing underneath them.
      */}
      <div
        className="absolute left-1/2 top-4 flex w-[min(46rem,calc(100vw-34rem))] min-w-64
                   -translate-x-1/2 flex-col items-center gap-2"
      >
        <ConnectionIndicator />
        <Notice />
        <ScreenShareTiles />
      </div>

      {/* Right rail — who is here at the top, who you are at the bottom. */}
      <div className="absolute inset-y-4 right-4 flex flex-col items-end justify-between gap-3">
        <PresenceList />
        <div className="flex shrink-0 flex-col items-end gap-2">
          {/* Phase 6. A sibling of the customizer rather than a third dock: the
              two are both "panels about you", they are mutually exclusive in
              practice, and stacking them would reach up into the presence list. */}
          {accountOpen && <AccountPanel onClose={() => setAccountOpen(false)} />}
          {moderationOpen && <ModerationPanel onClose={() => setModerationOpen(false)} />}
          {placesOpen && <PlacesPanel onClose={() => setPlacesOpen(false)} onEdit={onEdit} />}
          {customizing && <AvatarCustomizer onClose={() => setCustomizing(false)} />}
          <SelfStatus
            customizing={customizing}
            onCustomize={() => {
              setAccountOpen(false);
              setModerationOpen(false);
              setPlacesOpen(false);
              setCustomizing((open) => !open);
            }}
            accountOpen={accountOpen}
            onToggleAccount={() => {
              setCustomizing(false);
              setModerationOpen(false);
              setPlacesOpen(false);
              setAccountOpen((open) => !open);
            }}
            moderationOpen={moderationOpen}
            onToggleModeration={() => {
              setCustomizing(false);
              setAccountOpen(false);
              setPlacesOpen(false);
              setModerationOpen((open) => !open);
            }}
            placesOpen={placesOpen}
            onTogglePlaces={() => {
              setCustomizing(false);
              setAccountOpen(false);
              setModerationOpen(false);
              setPlacesOpen((open) => !open);
            }}
            hintOpen={hintOpen}
            onToggleHint={toggleHint}
          />
        </div>
      </div>

      {/* Bottom centre — the controls that act on the world. */}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {/* Phase 10, `FR-10.2` — above the emote bar rather than beside it: it
            appears and disappears as somebody walks, and a control that moves
            its neighbours would make the whole dock twitch. */}
        <InteractPrompt />
        <EmoteBar />
        <MediaControls />
      </div>

      {/* Phase 10, `FR-10.3` — the content itself, modal over the world.
          Outside every dock, because opening it takes control and closing it
          gives control back, which is the transition the requirement is about. */}
      <InteractionPanel />
    </div>
  );
}

/**
 * Transient, non-fatal messages — currently an unresolvable portal (Phase 3
 * Rules).
 *
 * Below the reconnecting banner rather than in its place: the two can be true at
 * once, and a connection warning is never worth hiding for something smaller.
 */
const NOTICE_TTL_MS = 4000;

function Notice() {
  const notice = useStore((state) => state.notice);
  const dismiss = useStore((state) => state.dismissNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(dismiss, NOTICE_TTL_MS);
    // Keyed on `at`, so a repeat of the same message restarts the timer instead
    // of inheriting the remains of the previous one.
    return () => window.clearTimeout(timer);
  }, [notice?.at, notice, dismiss]);

  if (!notice) return null;

  return (
    <Panel role="status" className="shrink-0 border-sky-400/30 bg-sky-950/70 px-4 py-2 text-center">
      <span className="text-sm text-sky-100">{notice.message}</span>
    </Panel>
  );
}

/** FR-1.21 — who is present. */
function PresenceList() {
  const roster = useStore((state) => state.roster);
  const selfId = useStore((state) => state.joined?.localId);
  const total = useStore((state) => state.totalInInstance);
  const [collapsed, setCollapsed] = useState(false);

  // Yourself first, then alphabetical. Stable ordering matters: a list that
  // reshuffles as people walk around is unreadable.
  const entries = [...roster.values()].sort((a, b) => {
    if (a.localId === selfId) return -1;
    if (b.localId === selfId) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const visible = entries.length;
  // Self is in the roster now, so "nothing here" is one entry, not zero.
  const others = selfId !== undefined && roster.has(selfId) ? visible - 1 : visible;

  return (
    // A flex column that can be squeezed: on a short window the roster gives
    // ground to the status cluster below it rather than the two overlapping.
    <Panel
      className="pointer-events-auto flex min-h-0 w-60 max-w-(--hud-rail) shrink flex-col
                 overflow-hidden"
    >
      <button
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full shrink-0 items-center justify-between px-4 py-3 text-left text-sm
                   font-medium hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-sky-300"
        aria-expanded={!collapsed}
      >
        <span>Nearby</span>
        <span className="text-xs font-normal text-slate-400">
          {visible}
          {total > visible && <span className="text-slate-500"> / {total} in world</span>}
        </span>
      </button>

      {!collapsed && (
        <ul className="min-h-0 max-h-64 shrink overflow-y-auto border-t border-white/10 px-2 py-2">
          {others === 0 && (
            <li className="px-2 py-3 text-xs text-slate-500">Nobody else nearby.</li>
          )}
          {entries.map((entry) => (
            <PresenceRow key={entry.localId} entry={entry} isSelf={entry.localId === selfId} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * One person in the presence list.
 *
 * Carries three separate facts, and they are separate on purpose: presence
 * status is chosen (`FR-4.11`), activity is derived from input (`FR-1.22`), and
 * speaking comes from the media layer (`FR-4.12`). Somebody can be available,
 * idle and silent all at once, and collapsing any two of them into one dot loses
 * information the list exists to carry.
 */
function PresenceRow({ entry, isSelf }: { entry: RosterEntry; isSelf: boolean }) {
  // The one place the media store is read from the HUD per participant. It
  // changes a few times a second while someone talks, and the subscription is
  // scoped to this row so a conversation does not re-render the whole list.
  const speaking = useMediaStore((state) =>
    // FR-4.13 — muting must clear it. For self that is knowable for certain;
    // for everyone else it rests on the SFU dropping muted publishers from the
    // active-speaker set.
    isSelf ? state.micEnabled && state.localSpeaking : state.speaking.has(entry.sessionId),
  );

  return (
    <li className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
      <PresenceDot status={entry.status} />
      <span
        className={cn(
          'min-w-0 truncate',
          entry.activity === 'idle' && 'text-slate-400',
          // `FR-7.16` — a blocked participant stays visible, and the Rules
          // require that: a block must not falsely imply the blocker is offline.
          // They are dimmed and struck through, which says "silenced by you"
          // rather than "gone".
          entry.blocked && 'text-slate-600 line-through',
        )}
      >
        {entry.displayName}
      </span>
      {speaking && !entry.blocked && (
        <span
          role="img"
          aria-label="speaking"
          title="Speaking"
          className="shrink-0 text-[10px] text-emerald-300"
        >
          ▮▮▮
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* `FR-7.5` / `FR-7.6` — a room where one person has gone quiet needs to
            be able to tell "muted by a moderator" from "microphone broken", and
            only the server knows which. Who did it and why is told to the muted
            person alone. */}
        {(entry.moderation.micMuted || entry.moderation.cameraDisabled) && (
          <span
            title={
              entry.moderation.micMuted && entry.moderation.cameraDisabled
                ? 'A moderator has turned off their microphone and camera'
                : entry.moderation.micMuted
                  ? 'A moderator has muted them'
                  : 'A moderator has turned off their camera'
            }
            className="text-[10px] uppercase tracking-wide text-amber-400/80"
          >
            muted
          </span>
        )}
        {/* `FR-7.1` — so "ask an admin" is advice somebody can act on. Shown for
            the roles that can do something about a problem, and not for
            `member`: a badge on nearly every row is a badge nobody reads, which
            is the same reasoning the guest marker uses from the other end. */}
        {(entry.role === 'owner' || entry.role === 'admin') && (
          <span
            title={entry.role === 'owner' ? 'Owner of this space' : 'Admin — can moderate'}
            className="text-[10px] uppercase tracking-wide text-sky-400/80"
          >
            {entry.role}
          </span>
        )}
        {/* FR-6.13 — "the system distinguishes members from guests". Shown for
            guests rather than for members: in a Space that mostly consists of
            members, the exception is the useful thing to mark, and a badge on
            every row is a badge nobody reads. */}
        {entry.identity.kind === 'guest' && (
          <span
            title="A guest — nothing about their session is saved"
            className="text-[10px] uppercase tracking-wide text-slate-600"
          >
            guest
          </span>
        )}
        {entry.activity === 'idle' && (
          <span className="text-[10px] uppercase tracking-wide text-slate-500">idle</span>
        )}
        {isSelf ? (
          <span className="text-[10px] uppercase tracking-wide text-slate-500">you</span>
        ) : (
          <>
            <DirectMessageButton entry={entry} />
            {/* Phase 7 — block, report, and the moderation actions the viewer's
                role permits. One menu rather than five icons: a presence row is
                60 pixels wide and most of these are rare. */}
            <ParticipantActions entry={entry} />
          </>
        )}
      </span>
    </li>
  );
}

/**
 * `FR-5.4` — start a direct conversation with one person.
 *
 * It lives in the presence list because that is the only place a *person* is
 * named. A separate "new message" dialogue would ask somebody to pick from a
 * list that is already on screen.
 *
 * Visible on hover and on keyboard focus, never on hover alone: a control that
 * only exists for a mouse is a control keyboard users do not have.
 */
function DirectMessageButton({ entry }: { entry: RosterEntry }) {
  return (
    <button
      type="button"
      title={`Message ${entry.displayName}`}
      aria-label={`Message ${entry.displayName}`}
      onClick={() => {
        const chat = useChatStore.getState();
        chat.setActive(chat.openDirect(entry.sessionId, entry.displayName));
        chat.setOpen(true);
      }}
      className="rounded px-1 text-[10px] uppercase tracking-wide text-slate-500 opacity-0
                 transition-opacity duration-150 hover:text-sky-300 focus-visible:opacity-100
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300
                 group-hover:opacity-100"
    >
      msg
    </button>
  );
}

/** Silence when healthy is the correct default; this only appears when it has
 *  something to say. */
function ConnectionIndicator() {
  const appState = useStore((state) => state.appState);
  const attempt = useStore((state) => state.reconnectAttempt);
  if (appState !== 'reconnecting') return null;

  return (
    <Panel className="shrink-0 border-amber-400/30 bg-amber-950/70 px-4 py-2">
      <span className="text-sm text-amber-100">
        Reconnecting… <span className="text-amber-300/70">attempt {attempt}</span>
      </span>
    </Panel>
  );
}

/**
 * The key bindings — bottom left, above chat rather than underneath it.
 *
 * Open and dismissal are `Hud`'s, so the "?" in the status panel can bring it
 * back. It shares the left rail with the chat panel as a sibling: the two used
 * to share the *same* anchor, which meant opening chat simply covered it.
 */
function ControlsHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Panel className="pointer-events-auto w-72 max-w-(--hud-rail) shrink-0 p-4 text-xs">
      <div className="flex items-start justify-between gap-4">
        <dl className="space-y-1 text-slate-300">
          <Row keys="W A S D" action="Move" />
          <Row keys="Shift" action="Run" />
          <Row keys="Space" action="Jump" />
          <Row keys="Drag" action="Look around" />
          <Row keys="Q / E" action="Turn camera" />
          <Row keys="Wheel" action="Zoom" />
          <Row keys="1 – 6" action="React" />
          <Row keys="Enter" action="Chat" />
        </dl>
        <button
          onClick={onDismiss}
          aria-label="Dismiss controls"
          className="shrink-0 rounded px-1.5 text-slate-500 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          ×
        </button>
      </div>
    </Panel>
  );
}

function Row({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-16 shrink-0 font-mono text-[11px] text-slate-400">{keys}</dt>
      <dd>{action}</dd>
    </div>
  );
}

/**
 * FR-1.22 — idle appears automatically and clears on input.
 *
 * Also where the participant learns their audio has changed scope, sets their
 * presence status (`FR-4.11`) and opens the customizer (`FR-4.5`). All three are
 * facts about *them*, so they belong beside their own name rather than in
 * banners of their own — the HUD is deliberately sparse and one surface per
 * feature would be several too many.
 */
function SelfStatus({
  customizing,
  onCustomize,
  accountOpen,
  onToggleAccount,
  moderationOpen,
  onToggleModeration,
  placesOpen,
  onTogglePlaces,
  hintOpen,
  onToggleHint,
}: {
  customizing: boolean;
  onCustomize: () => void;
  accountOpen: boolean;
  onToggleAccount: () => void;
  moderationOpen: boolean;
  onToggleModeration: () => void;
  placesOpen: boolean;
  onTogglePlaces: () => void;
  hintOpen: boolean;
  onToggleHint: () => void;
}) {
  const displayName = useStore((state) => state.displayName);
  const self = useStore((state) => state.roster.get(state.joined?.localId ?? -1));
  const isPrivate = useStore(inPrivateZone);
  const isSpotlit = useStore(inSpotlight);
  // Phase 6, `FR-6.11` — from the world's own view of this connection, not from
  // the auth store. The two agree, and this is the one the server decided during
  // the handshake, so it cannot show an account while the socket is a guest.
  const identity = useStore((state) => state.joined?.identity);
  // Phase 7 — from `JOINED` / `IDENTITY`, which is the one answer the server
  // decided. The button below is hidden without it; every action behind it is
  // re-checked server-side regardless (`NFR-34`).
  const canReview = useStore((state) => state.capabilities.includes('review'));
  const moderation = useStore((state) => state.moderation);
  // Phase 8 — which room, and which copy of it (`FR-8.4`, `FR-8.10`).
  const place = useStore((state) => state.place);

  return (
    <Panel
      className="pointer-events-auto flex max-w-(--hud-rail) shrink-0 items-center gap-2 px-3 py-2
                 text-sm"
    >
      <StatusPicker status={self?.status ?? 'available'} />

      {/* `min-w-0` is what makes `truncate` do anything here: a flex item will
          not shrink below its content without it, so a long name would push the
          panel past the width the rail allows instead of ending in an ellipsis. */}
      <span className="min-w-0 truncate">{displayName || 'You'}</span>
      {self?.activity === 'idle' && <span className="shrink-0 text-xs text-slate-500">idle</span>}

      {/* `FR-8.10` — which copy of the room you are in, when there is more than
          one. Absent otherwise, and that restraint is the point: numbering a
          room that has only one copy invents a distinction nobody needs, and a
          badge that is always there is a badge nobody reads. When it *does*
          appear, it is the only thing on screen that explains why a colleague in
          the same room cannot hear you. */}
      {place && place.instanceCount > 1 && (
        <ZoneBadge
          label={place.instanceLabel}
          title={
            `${place.instanceCount} copies of ${place.mapName} are running and each one is ` +
            `separate. People in the others cannot see or hear you — open Places to join theirs.`
          }
          className="border-sky-400/40 bg-sky-500/20 text-sky-200"
        />
      )}

      {isPrivate && (
        <ZoneBadge
          label="private"
          title="Your audio and video are shared only inside this zone"
          className="border-violet-400/40 bg-violet-500/20 text-violet-200"
        />
      )}
      {isSpotlit && (
        <ZoneBadge
          label="on stage"
          title="Everyone in the map can hear and see you"
          className="border-amber-400/40 bg-amber-500/20 text-amber-200"
        />
      )}

      {/* FR-6.13 — a guest is marked as one, next to their own name. Not a
          warning: it is a true and useful thing to know, and the account panel
          one button along is what to do about it. */}
      {identity?.kind === 'guest' && (
        <ZoneBadge
          label="guest"
          title="Nothing about this session is saved. Open Account to keep it."
          className="border-white/15 bg-white/5 text-slate-400"
        />
      )}

      {/* `FR-7.5` — the target "is notified". Beside their own name rather than
          in a banner, because it is a fact about them that stays true until it
          is lifted; the transient notice when it happens is the other half.
          Named, because "you were muted" and "you were muted by Ana, for
          shouting" are different amounts of use to the person reading it. */}
      {(moderation?.micMuted || moderation?.cameraDisabled) && (
        <ZoneBadge
          label={moderation.micMuted ? 'muted' : 'camera off'}
          title={
            `A moderator has turned off your ` +
            `${moderation.micMuted ? 'microphone' : ''}` +
            `${moderation.micMuted && moderation.cameraDisabled ? ' and ' : ''}` +
            `${moderation.cameraDisabled ? 'camera' : ''}` +
            `${moderation.byName ? `. ${moderation.byName} did it` : ''}` +
            `${moderation.reason ? `: ${moderation.reason}` : ''}. ` +
            `You cannot turn it back on yourself.`
          }
          className="border-amber-400/40 bg-amber-500/20 text-amber-200"
        />
      )}

      {/* Who you are, then what you can do about it — the rule separating the
          identity half of this panel from its actions. Phase 6's account control
          sits on this side of the divider, as phase 4 anticipated. */}
      <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" />

      {/* Phase 8, `FR-8.12`/`FR-8.13` — where else there is to be, and one click
          to get there. Offered to everybody, including guests: the directory the
          server sends them has rooms and headcounts in it and no names, so the
          panel is useful and truthful either way. */}
      <button
        type="button"
        onClick={onTogglePlaces}
        aria-expanded={placesOpen}
        aria-label="Places in this space"
        title="Rooms in this space, and who is in them"
        className={cn(
          'shrink-0 rounded-lg px-2 py-1 text-xs transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          placesOpen ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
        )}
      >
        Places
      </button>

      <button
        type="button"
        onClick={onToggleAccount}
        aria-expanded={accountOpen}
        aria-label={identity?.kind === 'account' ? 'Your account' : 'Create an account'}
        title={identity?.kind === 'account' ? 'Your account' : 'Create an account'}
        className={cn(
          'shrink-0 rounded-lg px-2 py-1 text-xs transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          accountOpen ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
        )}
      >
        Account
      </button>

      {/* Phase 7 — only for somebody who can review. A moderation panel offered
          to everybody and refused on open would be a button that lies, which is
          the same rule the retry button follows on the error screen. */}
      {canReview && (
        <button
          type="button"
          onClick={onToggleModeration}
          aria-expanded={moderationOpen}
          aria-label="Moderation"
          title="Roles, access, reports and the audit log"
          className={cn(
            'shrink-0 rounded-lg px-2 py-1 text-xs transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
            moderationOpen ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
          )}
        >
          Moderate
        </button>
      )}

      <button
        type="button"
        onClick={onCustomize}
        aria-expanded={customizing}
        aria-label="Customize your avatar"
        title="Customize your avatar"
        className={cn(
          'shrink-0 rounded-lg px-2 py-1 text-xs transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          customizing ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
        )}
      >
        Avatar
      </button>

      {/* The only route back to the controls hint once it has been dismissed. */}
      <button
        type="button"
        onClick={onToggleHint}
        aria-expanded={hintOpen}
        aria-label="Keyboard controls"
        title="Keyboard controls"
        className={cn(
          'h-6 w-6 shrink-0 rounded-lg text-xs transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          hintOpen ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
        )}
      >
        ?
      </button>
    </Panel>
  );
}

/**
 * FR-4.11 — available / away / do-not-disturb.
 *
 * `idle` is absent, and that is the requirement rather than an omission: it is
 * derived from input activity on the server (`FR-1.22`) and a client that could
 * claim it could lie about being at its desk.
 *
 * A native `<select>`, not a bespoke menu. It is three options, it is keyboard
 * and screen-reader correct for free, and the alternative is a popover with its
 * own focus trap for no gain.
 */
const STATUS_OPTIONS: { value: Presence; label: string }[] = [
  { value: 'available', label: 'Available' },
  { value: 'away', label: 'Away' },
  { value: 'do-not-disturb', label: 'Do not disturb' },
];

function StatusPicker({ status }: { status: Presence }) {
  return (
    <label className="flex shrink-0 items-center gap-2">
      <PresenceDot status={status} />
      <span className="sr-only">Your status</span>
      <select
        value={status}
        onChange={(event) => net.setStatus(event.target.value as Presence)}
        className="cursor-pointer appearance-none bg-transparent text-xs text-slate-400
                   hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-sky-300"
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} className="bg-slate-900 text-slate-100">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Text and a tooltip, not just a tint — colour is never the only signal. */
function ZoneBadge({
  label,
  title,
  className,
}: {
  label: string;
  title: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
        className,
      )}
    >
      {label}
    </span>
  );
}
