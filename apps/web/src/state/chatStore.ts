/**
 * Chat state — phase 5.
 *
 * Its own store rather than a slice of `store.ts`, for the reason that file
 * opens with: React state here holds only things that change rarely. Chat
 * changes when somebody types, which is rare on the scale that matters
 * (transforms change twenty times a second) and frequent enough that a message
 * arriving must not re-render the presence list or the video tiles.
 *
 * ── What the server owns, and what this file may decide ─────────────────────
 *
 * Owned by the server and merely stored here: which channels exist (`FR-5.5`),
 * who received a message (`FR-5.9`), message order (`FR-5.7`), and who was
 * mentioned (`FR-5.15`). This file never recomputes any of them.
 *
 * Decided here: which channel is on screen, and therefore what counts as unread.
 */

import { create } from 'zustand';
import {
  ROOM_CHANNEL_ID,
  directChannelId,
  parseChannelId,
  type ChatChannelDto,
  type ChatMessagePayload,
  type ChatRejectPayload,
  type TypingStatePayload,
} from '@hubitat/protocol';

/**
 * A message as the interface holds it.
 *
 * `pending` and `failed` are the two states a server message can never be in:
 * they belong to the optimistic copy the sender drew before the echo arrived
 * (`FR-5.8`). Everything else is the server's word.
 */
export interface ChatEntry extends ChatMessagePayload {
  /** Drawn locally, not yet acknowledged. */
  pending?: boolean;
  /** `CHAT_REJECT` arrived: this will never be delivered. */
  failed?: string;
}

export interface TypingEntry {
  sessionId: string;
  displayName: string;
  /** `Date.now()` past which the indicator is stale and must clear, even if the
   *  "stopped" frame never arrives (`FR-5.10`). */
  expiresAt: number;
}

export interface ChannelState {
  messages: ChatEntry[];
  typing: Map<number, TypingEntry>;
  /** `FR-5.16` — how many have arrived since this channel was last on screen. */
  unread: number;
  /** True when at least one of those unread messages named you (`FR-5.15`). */
  mentioned: boolean;
  /** The highest `seq` seen, for the read marker sent back to the server. */
  lastSeq: number;
  /** History has been requested at least once, so opening a channel twice does
   *  not fetch the same page twice. */
  historyLoaded: boolean;
  /** False while older messages remain beyond what is retained. */
  historyComplete: boolean;
}

interface ChatStore {
  open: boolean;
  /** The channel on screen. Never null while the panel is open. */
  activeId: string;
  /** From the server: room, nearby, and any chat-enabled zone occupied. */
  advertised: ChatChannelDto[];
  /**
   * Direct threads, opened locally.
   *
   * Not advertised by the server, and correctly so: the available set describes
   * the participant's *situation* (`FR-5.5`), while a direct channel exists the
   * moment either side decides to use it. Seeded from the roster, and from any
   * direct message or typing frame that arrives.
   */
  directs: Map<string, ChatChannelDto>;
  channels: Map<string, ChannelState>;

  setOpen: (open: boolean) => void;
  setActive: (channelId: string) => void;
  setAdvertised: (channels: ChatChannelDto[]) => void;
  openDirect: (sessionId: string, displayName: string) => string;
  markHistoryRequested: (channelId: string) => void;
  invalidateHistory: () => void;

  receive: (message: ChatMessagePayload) => void;
  receiveHistory: (
    channelId: string,
    messages: ChatMessagePayload[],
    complete: boolean,
    lastReadSeq: number,
  ) => void;
  addPending: (entry: ChatEntry) => void;
  reject: (payload: ChatRejectPayload) => void;
  applyTyping: (frame: TypingStatePayload) => void;
  expireTyping: () => void;
  reset: () => void;
}

const emptyChannel = (): ChannelState => ({
  messages: [],
  typing: new Map(),
  unread: 0,
  mentioned: false,
  lastSeq: 0,
  historyLoaded: false,
  historyComplete: false,
});

/**
 * The value `channelState` returns for a channel nobody has spoken in.
 *
 * A shared constant, not a fresh `emptyChannel()`, because zustand v5 compares
 * selector results with `Object.is`: a selector that allocates on every call
 * never compares equal, and the component re-renders forever. Frozen so the
 * accident of mutating it in place fails loudly rather than corrupting every
 * empty channel at once.
 */
const EMPTY_CHANNEL: ChannelState = Object.freeze(emptyChannel());

/**
 * The local participant's session id, for "was I mentioned".
 *
 * Injected rather than read from the world store, which would make one store
 * depend on another at module load. Re-read on every message rather than
 * captured, because it changes on every join — and a stale copy would miss a
 * mention, which is invisible in a way a spurious one is not.
 */
let readSelfSessionId: () => string = () => '';

export function bindSelfSessionId(read: () => string): void {
  readSelfSessionId = read;
}

export const useChatStore = create<ChatStore>((set) => ({
  open: false,
  activeId: ROOM_CHANNEL_ID,
  advertised: [],
  directs: new Map(),
  channels: new Map(),

  setOpen: (open) =>
    set((state) => {
      if (!open) return { open };
      // Opening the panel puts you back in a channel, which is the same act as
      // reading it.
      const channels = new Map(state.channels);
      const channel = channels.get(state.activeId) ?? emptyChannel();
      channels.set(state.activeId, { ...channel, unread: 0, mentioned: false });
      return { open, channels };
    }),

  setActive: (activeId) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(activeId) ?? emptyChannel();
      // Looking at a channel is what marks it read. The server is told
      // separately, by the panel, so this store stays free of I/O.
      channels.set(activeId, { ...channel, unread: 0, mentioned: false });
      return { activeId, channels };
    }),

  setAdvertised: (advertised) =>
    set((state) => {
      // A zone channel that has gone away must not stay selected, or the
      // composer would send to a scope the server will refuse (`FR-5.5`).
      const stillThere =
        advertised.some((channel) => channel.id === state.activeId) ||
        state.directs.has(state.activeId);
      return {
        advertised,
        activeId: stillThere ? state.activeId : ROOM_CHANNEL_ID,
      };
    }),

  openDirect: (sessionId, displayName) => {
    const id = directChannelId(sessionId);
    set((state) => {
      if (state.directs.has(id)) return state;
      const directs = new Map(state.directs);
      directs.set(id, {
        id,
        scope: 'direct',
        label: displayName,
        persistent: true,
      });
      return { directs };
    });
    return id;
  },

  markHistoryRequested: (channelId) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(channelId) ?? emptyChannel();
      if (channel.historyLoaded) return state;
      channels.set(channelId, { ...channel, historyLoaded: true });
      return { channels };
    }),

  /**
   * Mark every channel's history as needing a refetch — run on reconnect.
   *
   * A persistent channel carried on receiving messages while this client was
   * disconnected, and nothing on the socket announces what was missed. The
   * refetch merges by message id rather than replacing, so the gap fills in and
   * nothing already on screen moves.
   */
  invalidateHistory: () =>
    set((state) => {
      if (state.channels.size === 0) return state;
      const channels = new Map(state.channels);
      for (const [channelId, channel] of channels) {
        channels.set(channelId, { ...channel, historyLoaded: false });
      }
      return { channels };
    }),

  /**
   * A message from the server.
   *
   * Two jobs beyond appending: reconcile the optimistic copy by `tempId`
   * (`FR-5.8` — matching, not duplicating), and insert by `seq` rather than by
   * arrival, since `seq` is the only ordering the server guarantees.
   */
  receive: (message) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(message.channelId) ?? emptyChannel();

      const withoutDuplicate = channel.messages.filter((entry) =>
        message.tempId ? entry.tempId !== message.tempId : entry.id !== message.id,
      );

      const isActive = state.open && state.activeId === message.channelId;
      const self = readSelfSessionId();
      const mentionsMe =
        self.length > 0 && message.mentions.some((mention) => mention.sessionId === self);
      const isOwn = message.senderSessionId === self;

      channels.set(message.channelId, {
        ...channel,
        messages: insertBySeq(withoutDuplicate, message),
        lastSeq: Math.max(channel.lastSeq, message.seq),
        // Your own message is never unread, even with the panel closed — you
        // were looking at it when you sent it.
        unread: isActive ? 0 : isOwn ? channel.unread : channel.unread + 1,
        mentioned: isActive ? false : channel.mentioned || mentionsMe,
      });

      return { channels, directs: ensureDirect(state.directs, message, isOwn) };
    }),

  receiveHistory: (channelId, messages, complete, lastReadSeq) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(channelId) ?? emptyChannel();

      // Merged rather than replaced: history arrives asynchronously, and a live
      // message that landed while the page was in flight must not be dropped.
      let merged = channel.messages;
      for (const message of messages) {
        if (merged.some((entry) => entry.id === message.id)) continue;
        merged = insertBySeq(merged, message);
      }

      const highest = merged.reduce((max, entry) => Math.max(max, entry.seq), 0);
      const isActive = state.open && state.activeId === channelId;

      channels.set(channelId, {
        ...channel,
        messages: merged,
        lastSeq: Math.max(channel.lastSeq, highest),
        historyLoaded: true,
        historyComplete: complete,
        // `FR-5.16` — the marker is the server's, so a conversation that arrived
        // while you were away is still unread when you come back.
        unread: isActive ? 0 : merged.filter((entry) => entry.seq > lastReadSeq).length,
      });

      return { channels };
    }),

  addPending: (entry) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(entry.channelId) ?? emptyChannel();
      channels.set(entry.channelId, {
        ...channel,
        messages: [...channel.messages, entry],
      });
      return { channels };
    }),

  /** `FR-5.8` — a send that will never be delivered, marked rather than removed.
   *  Deleting it would leave somebody who typed a paragraph with nothing to
   *  copy out of. */
  reject: (payload) =>
    set((state) => {
      if (!payload.tempId) return state;
      const channels = new Map(state.channels);

      for (const [channelId, channel] of channels) {
        if (!channel.messages.some((entry) => entry.tempId === payload.tempId)) continue;
        channels.set(channelId, {
          ...channel,
          messages: channel.messages.map((entry) =>
            entry.tempId === payload.tempId
              ? { ...entry, pending: false, failed: payload.message }
              : entry,
          ),
        });
        return { channels };
      }
      return state;
    }),

  applyTyping: (frame) =>
    set((state) => {
      const channels = new Map(state.channels);
      const channel = channels.get(frame.channelId) ?? emptyChannel();
      const typing = new Map(channel.typing);

      if (frame.typing) {
        typing.set(frame.id, {
          sessionId: frame.sessionId,
          displayName: frame.displayName,
          expiresAt: Date.now() + frame.expiresInMs,
        });
      } else {
        typing.delete(frame.id);
      }

      channels.set(frame.channelId, { ...channel, typing });
      return {
        channels,
        directs: ensureDirectFromTyping(state.directs, frame),
      };
    }),

  /**
   * Drop indicators whose TTL has passed.
   *
   * Driven by a timer rather than by the arrival of the next frame, because the
   * case that matters is the one where no next frame comes: the sender closed
   * the tab mid-sentence. `FR-5.10` says the indicator clears when typing stops,
   * and a crashed client stops typing.
   */
  expireTyping: () =>
    set((state) => {
      const now = Date.now();
      let touched = false;
      const channels = new Map(state.channels);

      for (const [channelId, channel] of channels) {
        if (channel.typing.size === 0) continue;
        const typing = new Map([...channel.typing].filter(([, entry]) => entry.expiresAt > now));
        if (typing.size === channel.typing.size) continue;
        channels.set(channelId, { ...channel, typing });
        touched = true;
      }

      return touched ? { channels } : state;
    }),

  reset: () =>
    set({
      open: false,
      activeId: ROOM_CHANNEL_ID,
      advertised: [],
      directs: new Map(),
      channels: new Map(),
    }),
}));

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered by the server's `seq`, which is the only ordering `FR-5.7`
 * guarantees.
 *
 * Appending is the common case, so the scan starts at the end. Pending messages
 * carry no server sequence yet and always sort last: they are, by definition,
 * the newest thing their sender knows about.
 */
function insertBySeq(messages: ChatEntry[], message: ChatEntry): ChatEntry[] {
  const next = [...messages];
  let index = next.length;
  while (index > 0) {
    const previous = next[index - 1]!;
    if (!previous.pending && previous.seq <= message.seq) break;
    index--;
  }
  next.splice(index, 0, message);
  return next;
}

/**
 * A direct message from somebody you have no thread with opens one.
 *
 * Skipped for your own echo: that copy is addressed to `direct:<them>`, a tab
 * you already have, and its `senderName` is *you* — using it as a label would
 * name the thread after yourself.
 */
function ensureDirect(
  directs: Map<string, ChatChannelDto>,
  message: ChatMessagePayload,
  isOwn: boolean,
): Map<string, ChatChannelDto> {
  if (message.scope !== 'direct' || isOwn || directs.has(message.channelId)) return directs;
  if (!parseChannelId(message.channelId)?.targetId) return directs;

  const next = new Map(directs);
  next.set(message.channelId, {
    id: message.channelId,
    scope: 'direct',
    label: message.senderName,
    persistent: true,
  });
  return next;
}

/** Someone starting to type at you opens the thread too — the indicator has to
 *  have somewhere to appear. */
function ensureDirectFromTyping(
  directs: Map<string, ChatChannelDto>,
  frame: TypingStatePayload,
): Map<string, ChatChannelDto> {
  if (frame.scope !== 'direct' || !frame.typing || directs.has(frame.channelId)) return directs;
  const next = new Map(directs);
  next.set(frame.channelId, {
    id: frame.channelId,
    scope: 'direct',
    label: frame.displayName,
    persistent: true,
  });
  return next;
}

/** Every channel the participant can currently select: advertised first, in the
 *  order the server listed them, then direct threads alphabetically. */
export function visibleChannels(state: ChatStore): ChatChannelDto[] {
  return [
    ...state.advertised,
    ...[...state.directs.values()].sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

export function channelState(state: ChatStore, channelId: string): ChannelState {
  return state.channels.get(channelId) ?? EMPTY_CHANNEL;
}

/** Total unread across every channel, for the closed panel's badge. */
export function totalUnread(state: ChatStore): {
  count: number;
  mentioned: boolean;
} {
  let count = 0;
  let mentioned = false;
  for (const channel of state.channels.values()) {
    count += channel.unread;
    mentioned = mentioned || channel.mentioned;
  }
  return { count, mentioned };
}
