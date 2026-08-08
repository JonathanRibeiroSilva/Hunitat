/**
 * The chat panel — phase 5.
 *
 * One surface for four scopes, because they are four *audiences* for the same
 * act, not four features. A channel strip picks who hears you; everything below
 * it is identical whichever is selected. The alternative — a room log, a
 * proximity bubble and a DM window — is three interfaces to learn and three
 * places to miss a message.
 *
 * The panel is deliberately the only part of the HUD that takes focus. `Enter`
 * opens it and `Escape` returns to the world, because a 3D client where typing
 * "swimming" walks you into a wall is a client people stop typing in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Panel, cn } from '@hubitat/ui';
import { parseChannelId, type ChatChannelDto } from '@hubitat/protocol';
import { net } from '../net/client.js';
import {
  channelState,
  totalUnread,
  useChatStore,
  visibleChannels,
  type ChatEntry,
} from '../state/chatStore.js';
import { useStore } from '../state/store.js';
import { ChatBody } from './chatMarkdown.jsx';
import { isActivatable, isTextEntry } from './keyboard.js';

/** How often stale typing indicators are swept. Well under the 5 s TTL, so an
 *  indicator never lingers visibly past it. */
const TYPING_SWEEP_MS = 1_000;

/** How long after the last keystroke the "still typing" frame is repeated. Below
 *  `TYPING_INDICATOR_TTL_MS`, or the indicator would blink out mid-sentence. */
const TYPING_REPEAT_MS = 3_000;

export function ChatPanel() {
  const open = useChatStore((state) => state.open);
  const setOpen = useChatStore((state) => state.setOpen);
  // `useShallow`, because these selectors build a value rather than returning a
  // stored one. zustand v5 compares with `Object.is`, so a fresh object every
  // call would re-render on every store write, forever.
  const unread = useChatStore(useShallow(totalUnread));

  // FR-5.10 — indicators clear on their own even when the "stopped" frame never
  // arrives, which is what happens when somebody closes the tab mid-sentence.
  useEffect(() => {
    const timer = window.setInterval(() => useChatStore.getState().expireTyping(), TYPING_SWEEP_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Enter opens the composer from anywhere in the world; the panel handles
  // Escape itself. Ignored while something else already has focus, so typing an
  // "e" into the name field does not toggle chat.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat) return;
      // Enter already means something in a text field, and it already activates
      // a focused button — claiming it there would open chat *and* press the
      // button.
      if (isTextEntry(event.target) || isActivatable(event.target)) return;
      event.preventDefault();
      useChatStore.getState().setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!open) {
    return (
      // Bottom of the left rail — the same corner the panel opens into, so the
      // pill visibly becomes the panel. It used to sit at the bottom centre,
      // directly on top of the media controls: two live controls, one anchor.
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'pointer-events-auto shrink-0 rounded-xl border px-4 py-2',
          'text-sm backdrop-blur transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
          unread.mentioned
            ? 'border-amber-400/40 bg-amber-950/70 text-amber-100'
            : 'border-white/10 bg-slate-900/70 text-slate-300 hover:bg-slate-900/90',
        )}
      >
        Chat
        <span className="ml-2 text-xs text-slate-500">Enter</span>
        {unread.count > 0 && (
          <span
            aria-label={`${unread.count} unread`}
            className={cn(
              'ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              unread.mentioned ? 'bg-amber-400 text-amber-950' : 'bg-sky-400 text-sky-950',
            )}
          >
            {unread.count > 99 ? '99+' : unread.count}
          </span>
        )}
      </button>
    );
  }

  return <OpenPanel />;
}

function OpenPanel() {
  const activeId = useChatStore((state) => state.activeId);
  const channels = useChatStore(useShallow(visibleChannels));
  const setActive = useChatStore((state) => state.setActive);
  const setOpen = useChatStore((state) => state.setOpen);

  const active = channels.find((channel) => channel.id === activeId);

  return (
    <Panel
      /*
       * Sized, not positioned — the left rail places it, and the controls hint
       * above it is a sibling rather than something it lands on top of.
       *
       * `--hud-rail` keeps it clear of the bottom-centre dock on a narrow
       * window, and `60vh` keeps a short viewport from pushing the video strip
       * above it off the top of the screen.
       */
      className="pointer-events-auto flex h-[min(26rem,55vh)] w-104 max-w-(--hud-rail)
                 shrink-0 flex-col overflow-hidden"
      /*
       * Every keystroke inside the panel belongs to the panel.
       *
       * `stopPropagation` here rather than on the textarea, and it has to be
       * here: React dispatches synthetic events from the target upward, so a
       * handler on the input that stopped propagation would also stop this one
       * — and Escape would never close the panel from the one place people
       * actually press it. Stopping at the container instead covers the tabs and
       * the buttons as well, which is correct: `w` on a focused tab must not
       * walk the avatar either.
       *
       * The native event is stopped with it, which is what keeps these keys away
       * from the window listeners in `input.ts` and `EmoteBar`.
       */
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Escape') return;
        setOpen(false);
      }}
    >
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-2">
        <div
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Chat channels"
        >
          {channels.map((channel) => (
            <ChannelTab
              key={channel.id}
              channel={channel}
              active={channel.id === activeId}
              onSelect={() => setActive(channel.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          className="shrink-0 rounded px-2 text-slate-500 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          ×
        </button>
      </div>

      {active ? (
        <ChannelView channel={active} />
      ) : (
        <p className="m-auto px-6 text-center text-xs text-slate-500">
          That channel is no longer available.
        </p>
      )}
    </Panel>
  );
}

function ChannelTab({
  channel,
  active,
  onSelect,
}: {
  channel: ChatChannelDto;
  active: boolean;
  onSelect: () => void;
}) {
  const state = useChatStore((store) => channelState(store, channel.id));

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      title={
        channel.persistent
          ? 'Recent messages are kept'
          : 'Nothing here is stored — it is delivered and forgotten'
      }
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        active ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/5',
      )}
    >
      {channel.label}
      {/* FR-5.16 — unread per channel, and a mention reads differently from a
          message, because one of them is addressed to you. */}
      {state.unread > 0 && !active && (
        <span
          className={cn(
            'rounded-full px-1.5 text-[10px] font-medium',
            state.mentioned ? 'bg-amber-400 text-amber-950' : 'bg-sky-400 text-sky-950',
          )}
        >
          {state.unread > 99 ? '99+' : state.unread}
        </span>
      )}
    </button>
  );
}

function ChannelView({ channel }: { channel: ChatChannelDto }) {
  const state = useChatStore((store) => channelState(store, channel.id));
  const selfSessionId = useStore((store) => store.joined?.sessionId ?? '');
  const bottomRef = useRef<HTMLDivElement>(null);

  // FR-5.12 — persistent channels fetch their recent history once, when first
  // opened. Ephemeral ones are asked too, and correctly answer with nothing:
  // AC-5.4 wants "shows none after the fact", not "cannot be asked".
  useEffect(() => {
    if (state.historyLoaded) return;
    useChatStore.getState().markHistoryRequested(channel.id);
    net.requestChatHistory(channel.id);
  }, [channel.id, state.historyLoaded]);

  // FR-5.16 — tell the server what has been seen, so unread survives a reload
  // rather than resetting to whatever this tab remembers.
  useEffect(() => {
    if (state.lastSeq > 0) net.markChatRead(channel.id, state.lastSeq);
  }, [channel.id, state.lastSeq]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length]);

  const typing = [...state.typing.values()].filter((entry) => entry.sessionId !== selfSessionId);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 py-2" role="log" aria-live="polite">
        {!channel.persistent && (
          <p className="pb-2 text-center text-[11px] text-slate-600">
            Nothing in {channel.label} is stored.
          </p>
        )}
        {channel.persistent && state.historyLoaded && !state.historyComplete && (
          <button
            type="button"
            onClick={() => net.requestChatHistory(channel.id, oldestSeq(state.messages))}
            className="mx-auto mb-2 block rounded px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          >
            Load earlier messages
          </button>
        )}
        {state.messages.length === 0 && (
          <p className="pt-6 text-center text-xs text-slate-600">No messages yet.</p>
        )}
        {state.messages.map((entry) => (
          <MessageRow key={entry.tempId ?? entry.id} entry={entry} selfSessionId={selfSessionId} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* FR-5.10 */}
      <div className="h-5 px-3 text-[11px] text-slate-500" aria-live="polite">
        {typing.length > 0 && `${describeTyping(typing.map((entry) => entry.displayName))}…`}
      </div>

      <Composer channel={channel} />
    </>
  );
}

function MessageRow({ entry, selfSessionId }: { entry: ChatEntry; selfSessionId: string }) {
  const isSelf = entry.senderSessionId === selfSessionId;
  const mentionsMe = entry.mentions.some((mention) => mention.sessionId === selfSessionId);

  return (
    <div
      className={cn(
        'rounded-lg px-2 py-1 text-sm',
        // FR-5.15 — a message that names you is distinguished by more than
        // colour: it is the only one with a border.
        mentionsMe && 'border-l-2 border-amber-400/60 bg-amber-400/5',
        entry.failed && 'opacity-70',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn('truncate text-xs font-medium', isSelf ? 'text-sky-300' : 'text-slate-300')}
        >
          {entry.senderName}
        </span>
        {/* FR-5.7 — the server's timestamp. The client's own clock is never used
            for anything a second person will read. */}
        <time dateTime={new Date(entry.at).toISOString()} className="text-[10px] text-slate-600">
          {new Date(entry.at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
        {entry.pending && <span className="text-[10px] text-slate-600">sending…</span>}
      </div>

      <div className="whitespace-pre-wrap wrap-break-word text-slate-200">
        <ChatBody body={entry.body} mentions={entry.mentions} selfSessionId={selfSessionId} />
      </div>

      {/* FR-5.8 — a clear indication of failure, kept beside the text so the
          message can still be copied out and re-sent. */}
      {entry.failed && (
        <p className="mt-0.5 text-[11px] text-rose-300">Not delivered — {entry.failed}</p>
      )}
    </div>
  );
}

function Composer({ channel }: { channel: ChatChannelDto }) {
  const [draft, setDraft] = useState('');
  const maxChars = useStore((state) => state.tuning?.chatMaxMessageChars ?? 2000);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingSentAt = useRef(0);

  const target = useMemo(() => targetFor(channel), [channel]);

  // Focus follows the selected channel, so switching tabs leaves the cursor
  // where the next keystroke is going.
  useEffect(() => {
    inputRef.current?.focus();
  }, [channel.id]);

  const submit = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0) return;
    net.sendChat(channel.scope, body.slice(0, maxChars), target);
    setDraft('');
    typingSentAt.current = 0;
  }, [draft, channel.scope, target, maxChars]);

  // FR-5.10 — repeated at an interval rather than on every keystroke. The server
  // drops duplicates inside a second anyway; this keeps the frames off the wire
  // in the first place.
  const onChange = useCallback(
    (value: string) => {
      setDraft(value);
      const now = Date.now();
      if (value.length === 0 || now - typingSentAt.current < TYPING_REPEAT_MS) return;
      typingSentAt.current = now;
      net.setTyping(channel.scope, true, target);
    },
    [channel.scope, target],
  );

  return (
    <div className="border-t border-white/10 p-2">
      <textarea
        ref={inputRef}
        value={draft}
        rows={2}
        maxLength={maxChars}
        placeholder={`Message ${channel.label}…`}
        aria-label={`Message ${channel.label}`}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          if (typingSentAt.current === 0) return;
          typingSentAt.current = 0;
          net.setTyping(channel.scope, false, target);
        }}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is the line break `FR-5.14` asks for.
          // Propagation is stopped by the panel, not here — see the note on it.
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          submit();
        }}
        className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm
                   text-slate-100 placeholder:text-slate-600 focus-visible:outline-none
                   focus-visible:ring-2 focus-visible:ring-sky-300"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** What `CHAT_SEND.targetId` means for this channel: a zone id, a session id,
 *  or nothing. The one overload in the protocol, resolved in one place. */
function targetFor(channel: ChatChannelDto): string | undefined {
  if (channel.scope === 'zone') return channel.zoneId;
  if (channel.scope === 'direct') return parseChannelId(channel.id)?.targetId;
  return undefined;
}

function oldestSeq(messages: ChatEntry[]): number | undefined {
  for (const entry of messages) {
    if (!entry.pending) return entry.seq;
  }
  return undefined;
}

function describeTyping(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}
