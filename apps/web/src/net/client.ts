/**
 * The WebSocket client.
 *
 * Lives outside React entirely. It pushes roster changes into the Zustand store
 * (rare) and transform samples into the interpolation buffers (20 Hz), which is
 * the split that keeps per-frame data out of React's render path.
 *
 * Protocol: specs/protocol/wire-protocol.md
 */

import {
  NEARBY_CHANNEL_ID,
  Op,
  PROTOCOL_VERSION,
  ROOM_CHANNEL_ID,
  decodeJsonFrame,
  decodeTransformBatch,
  directChannelId,
  emoteById,
  encodeJsonFrame,
  encodeTransform,
  isJsonOpcode,
  readOpcode,
  zoneChannelId,
  type AudiencePayload,
  type AvatarAppearance,
  type ChatChannelDto,
  type ChatHistoryResultPayload,
  type ChatMessagePayload,
  type ChatRejectPayload,
  type ChatScope,
  type EmotePlayPayload,
  type ForceTransformPayload,
  type IdentityStatePayload,
  type JoinedPayload,
  type MapTransferPayload,
  type MapUpdatedPayload,
  type ModerationAction,
  type ModerationStatePayload,
  type ParticipantDto,
  type ParticipantIdentity,
  type ParticipantModeration,
  type Role,
  type SnapshotPayload,
  type SpaceDirectoryDto,
  type Transform,
  type TypingStatePayload,
  type ZoneEventPayload,
} from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';
import { media } from '../media/mediaClient.js';
import { useAuthStore } from '../state/authStore.js';
import { useChatStore } from '../state/chatStore.js';
import { ensureBuffer, pushEmote, remoteBuffers, useStore } from '../state/store.js';

/**
 * Absent, the variable keeps its long-standing default. Present but **empty**,
 * the socket is opened against the page's own origin.
 *
 * The distinction exists for tunnel mode: the public domain is not known when
 * the dev server starts, and a hardcoded localhost sends a remote guest's
 * browser to its own machine — where nothing is listening. Empty also picks the
 * right scheme, since an https page may not open a plain ws:// socket.
 */
const WS_URL =
  import.meta.env.VITE_WS_URL === ''
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
    : (import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws');

/** NFR-23 — exponential backoff with jitter, so a server restart does not
 *  produce a synchronised stampede of every client reconnecting at once. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const BACKOFF_JITTER = 0.2;

export type ForceTransformHandler = (payload: ForceTransformPayload) => void;

/**
 * A stable per-browser value, for guest bans only — phase 7, `FR-7.8`.
 *
 * Generated once and kept in `localStorage`, beside the display name and the
 * remembered appearance. It identifies a *browser*, never a person: nothing
 * reads it to decide who somebody is, it is not sent to any other participant,
 * and on an account it is not matched against at all.
 *
 * Its weaknesses are the point of the Phase 7 note about them rather than a
 * defect to fix here — clearing site data changes it, and a second browser has a
 * different one. The remedy for a guest who will not stop is requiring accounts
 * (`FR-6.8`), which is one checkbox away in the same product.
 */
function clientFingerprint(): string {
  const KEY = 'hubitat.fingerprint';
  const stored = localStorage.getItem(KEY);
  if (stored) return stored;

  const minted =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    localStorage.setItem(KEY, minted);
  } catch {
    // Private browsing, or storage disabled. The value still holds for this page
    // load, which is the best that can be done and is no worse than the guest
    // ban is anyway.
  }
  return minted;
}

class NetClient {
  private socket: WebSocket | null = null;
  private resumeToken: string | null = null;
  private resumeExpiresAt = 0;
  private attempt = 0;
  /**
   * `FR-7.12` — the Space password, held for the life of this connection.
   *
   * Kept here rather than asked for again on every reconnect: a `JOIN` carries
   * it, and reconnects happen on their own without anybody at the keyboard. It
   * lives in memory only, like the access token and for the same reason (ADR
   * 0011), and is dropped by `disconnect`.
   */
  private spacePassword: string | null = null;
  private retryTimer: number | null = null;
  private sendTimer: number | null = null;
  private intentionalClose = false;
  /** Monotonic within a page load; combined with the local id so two tabs of the
   *  same person cannot mint the same optimistic id. */
  private tempCounter = 0;

  /** Mutated by the local player each frame; sampled by the send loop. */
  readonly localTransform: Transform = { x: 0, y: 0, z: 0, yaw: 0 };
  localFlags = 0;

  onForceTransform: ForceTransformHandler | null = null;

  // ───────────────────────────────────────────────────────────────────────────

  connect(displayName: string, options: { spacePassword?: string } = {}): void {
    this.intentionalClose = false;
    // `FR-7.12`. Only overwritten when one is offered, so a reconnect triggered
    // from somewhere that has no password to hand does not clear the one that
    // got this connection in.
    if (options.spacePassword !== undefined) this.spacePassword = options.spacePassword || null;
    this.open(displayName);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopSending();
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.resumeToken = null;
    this.spacePassword = null;
    this.socket?.close(1000, 'leaving');
    this.socket = null;
    // Leaving the room releases the tracks, the audio graph and its off-screen
    // elements. Three.js is not the only thing here that frees nothing on
    // garbage collection (NFR-14).
    void media.disconnect();
  }

  /** FR-1.4 — a prompt, deliberate departure rather than waiting for the
   *  stale-session sweep. */
  leave(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeJsonFrame(Op.LEAVE, {}));
    }
    this.disconnect();
  }

  /** FR-4.11. `idle` is absent by design — it is server-derived (FR-1.22). */
  setStatus(status: 'available' | 'away' | 'do-not-disturb'): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(Op.SET_STATUS, { status }));
  }

  /** FR-4.5, FR-4.7 — the whole appearance, applied without leaving the world. */
  setAppearance(appearance: AvatarAppearance): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(Op.SET_APPEARANCE, { appearance }));
  }

  /**
   * FR-4.14 — request an emote.
   *
   * Deliberately fire-and-forget with no local preview. The server throttles
   * (`EMOTE_MIN_INTERVAL_MS`) and answers with `EMOTE_PLAY`, so playing it
   * locally first would show the author a gesture that was dropped for everyone
   * else — the one viewer who must not be lied to about it.
   */
  emote(emote: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(Op.EMOTE, { emote }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Chat — phase 5
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-5.8` — draw it immediately, reconcile on the server's echo.
   *
   * The opposite of `emote`, which deliberately has no local preview. The
   * difference is what a failure costs: a dropped emote is a gesture nobody saw,
   * while a message that waited a round trip before appearing makes the whole
   * interface feel broken. So chat is optimistic — and every failure path
   * answers with `CHAT_REJECT` naming this `tempId`, so an undelivered message
   * is never left on screen looking sent.
   */
  sendChat(scope: ChatScope, body: string, targetId?: string): void {
    const store = useStore.getState();
    const chat = useChatStore.getState();
    const self = store.joined;
    if (!self) return;

    const tempId = `t${++this.tempCounter}-${self.localId}`;
    chat.addPending({
      id: tempId,
      tempId,
      channelId: localChannelId(scope, targetId),
      scope,
      // No server sequence yet. `insertBySeq` sorts pending messages last, so
      // this number is never compared against a real one.
      seq: Number.MAX_SAFE_INTEGER,
      senderId: self.localId,
      senderSessionId: self.sessionId,
      senderName: self.displayName,
      body,
      at: Date.now(),
      mentions: [],
      pending: true,
    });

    if (this.socket?.readyState !== WebSocket.OPEN) {
      // Never silently dropped: the message is already on screen.
      chat.reject({
        tempId,
        code: 'bad-frame',
        message: 'You are not connected.',
      });
      return;
    }
    this.socket.send(
      encodeJsonFrame(Op.CHAT_SEND, {
        scope,
        body,
        tempId,
        ...(targetId ? { targetId } : {}),
      }),
    );
    // Sending is the clearest possible signal that typing stopped (`FR-5.10`).
    this.setTyping(scope, false, targetId);
  }

  setTyping(scope: ChatScope, typing: boolean, targetId?: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      encodeJsonFrame(Op.TYPING, {
        scope,
        typing,
        ...(targetId ? { targetId } : {}),
      }),
    );
  }

  /** `FR-5.12`. `beforeSeq` pages backwards; omitted, it asks for the newest. */
  requestChatHistory(channelId: string, beforeSeq?: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      encodeJsonFrame(Op.CHAT_HISTORY, {
        channelId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      }),
    );
  }

  /** `FR-5.16` — move the server's last-seen marker, so unread survives a
   *  reconnect rather than resetting to whatever this tab happens to remember. */
  markChatRead(channelId: string, seq: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || seq <= 0) return;
    this.socket.send(encodeJsonFrame(Op.CHAT_READ, { channelId, seq }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Moderation — phase 7
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-7.5`–`FR-7.9` — one moderation act on one live participant.
   *
   * Fire-and-forget, like `emote` and for the same reason: the server decides,
   * and the visible result of a successful action is the participant changing or
   * disappearing. A refusal comes back as `ERROR forbidden` and is surfaced as a
   * notice, which is `FR-7.4`'s "attempts are refused" — the one thing that must
   * never happen is a button that quietly does nothing.
   *
   * No local preview at all. Showing somebody a mute badge that the server then
   * refused would be worse than a moment's delay: a moderator has to be able to
   * trust that what they see happened.
   */
  moderate(
    action: ModerationAction,
    targetSessionId: string,
    options: { reason?: string; durationMinutes?: number } = {},
  ): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      encodeJsonFrame(Op.MODERATE, {
        action,
        targetSessionId,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.durationMinutes ? { durationMinutes: options.durationMinutes } : {}),
      }),
    );
  }

  /** `FR-7.16`, `FR-7.18`. The server answers with a `PARTICIPANT_UPDATE`
   *  carrying `blocked`, sent only to this connection. */
  setBlocked(targetSessionId: string, blocked: boolean): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(Op.BLOCK, { targetSessionId, blocked }));
  }

  /** `FR-7.17`. Only who and why: where it happened is captured on the server,
   *  because a position supplied by the reporter is a fact about the accused
   *  supplied by the accuser. */
  report(targetSessionId: string, reason?: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      encodeJsonFrame(Op.REPORT, {
        targetSessionId,
        ...(reason ? { reason } : {}),
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Spaces and maps — phase 8
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-8.13`, `FR-8.14` — ask to be somewhere else in this Space.
   *
   * The client names a *destination*, never an instance it has chosen for
   * itself: capacity and grouping (`FR-8.8`, `FR-8.9`) are the server's decision,
   * and a client that could pick would be a client that could defeat a capacity
   * limit by asking. `instanceId` is a preference — "join their copy of the
   * room" — and is still subject to the same rules.
   *
   * Fire-and-forget, like `moderate`. A success arrives as `MAP_TRANSFER`, which
   * is a whole world; a refusal arrives as `map-full` or `map-unavailable` and is
   * surfaced as a notice, because a "go to" that quietly did nothing is
   * indistinguishable from one that worked.
   */
  navigate(target: { mapId?: string; instanceId?: string; followSessionId?: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      encodeJsonFrame(Op.NAVIGATE, {
        ...(target.mapId ? { mapId: target.mapId } : {}),
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        ...(target.followSessionId ? { followSessionId: target.followSessionId } : {}),
      }),
    );
  }

  /** `FR-8.12` — ask for the directory now. The server pushes it on change
   *  anyway; this is for a panel that has just been opened and should not show
   *  a second of nothing. */
  requestDirectory(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(Op.DIRECTORY, {}));
  }

  /**
   * Phase 9 — stop reporting a position, without leaving the world.
   *
   * The map editor drives the same character controller participants use
   * (`FR-9.3`), so an author walking a *draft* would otherwise be steering their
   * real avatar around the live map at the same time. The socket stays up —
   * chat, presence and moderation keep working, and being asked a question
   * mid-edit is ordinary — but the send loop stops, so they stand still where
   * they were.
   */
  pauseSending(): void {
    this.stopSending();
  }

  resumeSending(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.startSending();
  }

  // ───────────────────────────────────────────────────────────────────────────

  private open(displayName: string): void {
    const store = useStore.getState();
    store.setLoadStep('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL, [PROTOCOL_VERSION]);
    } catch (error) {
      this.scheduleRetry(displayName, error);
      return;
    }

    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      /**
       * Phase 6 — the WebSocket half of refresh-and-retry (`FR-6.17`).
       *
       * `ensureFresh` is awaited *before* `JOIN` rather than the token being
       * read straight out of the client, because this path runs on every
       * reconnect and a reconnect after a long pause is exactly when the
       * fifteen-minute token has expired. Presenting the stale one would be
       * refused with `auth-required` and the user would be signed out by a
       * network blip.
       *
       * Guests resolve to null here and send no token, which is the phase 1 path
       * unchanged.
       */
      void auth.ensureFresh().then((accessToken) => {
        if (socket.readyState !== WebSocket.OPEN) return;

        const canResume = this.resumeToken !== null && Date.now() < this.resumeExpiresAt;
        const store = useStore.getState();
        socket.send(
          encodeJsonFrame(Op.JOIN, {
            displayName: displayName || undefined,
            worldId: 'default',
            // FR-4.8 — what this guest was last wearing, and ONLY when there is
            // something to say. Sending the default reads to the server as a
            // request, which suppresses `appearanceForSeed` and makes every
            // first-time guest identical. Omitted, the server picks a distinct
            // one. An account ignores it: the profile is authoritative
            // (`FR-6.9`), so a stale copy in this browser cannot overwrite what
            // the person set from another device.
            //
            // A successful resume ignores it either way: the retained
            // participant carries its own appearance, and re-asserting a
            // remembered one would undo a change made from another tab.
            ...(store.appearanceRemembered ? { appearance: store.appearance } : {}),
            ...(canResume ? { resumeToken: this.resumeToken } : {}),
            ...(accessToken ? { accessToken } : {}),
            // Phase 7. The password gates entry to the world, so it travels on
            // the frame that enters it (`FR-7.12`); the fingerprint is the one
            // signal a guest ban can key on (`FR-7.8`) and is sent on every
            // join, including account ones, where it is recorded and never
            // matched.
            ...(this.spacePassword ? { spacePassword: this.spacePassword } : {}),
            clientFingerprint: clientFingerprint(),
          }),
        );
      });
    };

    socket.onmessage = (event) => this.onMessage(event.data as ArrayBuffer);

    socket.onclose = () => {
      this.stopSending();
      if (this.intentionalClose) return;

      const state = useStore.getState();
      if (state.appState === 'in-world' || state.appState === 'reconnecting') {
        state.setAppState('reconnecting');
        this.scheduleRetry(displayName);
      } else {
        state.fail({
          title: "Can't reach the server.",
          detail: 'The connection closed before the world could be joined.',
          retryable: true,
        });
      }
    };

    socket.onerror = () => {
      // `close` always follows, and carries the actionable state transition.
    };
  }

  private scheduleRetry(displayName: string, error?: unknown): void {
    // FR-1.5 — beyond the resume window there is nothing to restore, so this
    // becomes a failure the user has to acknowledge rather than an endless
    // silent retry.
    if (this.resumeToken !== null && Date.now() >= this.resumeExpiresAt) {
      useStore.getState().fail({
        title: 'You were disconnected for too long.',
        detail: 'The session could not be restored. Rejoin to continue.',
        retryable: true,
        technical: error ? String(error) : undefined,
      });
      return;
    }

    this.attempt++;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);

    useStore.getState().setReconnect(this.attempt, delay);
    this.retryTimer = window.setTimeout(() => this.open(displayName), delay);
  }

  // ───────────────────────────────────────────────────────────────────────────

  private onMessage(data: ArrayBuffer): void {
    const opcode = readOpcode(data);
    if (opcode === null) return;

    if (!isJsonOpcode(opcode)) {
      if (opcode === Op.TRANSFORM_BATCH) this.onBatch(data);
      return;
    }

    const payload = decodeJsonFrame(data);
    if (payload === null) return;
    const store = useStore.getState();

    switch (opcode) {
      case Op.JOINED: {
        const joined = payload as JoinedPayload;
        this.resumeToken = joined.resumeToken;
        this.resumeExpiresAt = Date.now() + joined.resumeTokenTtlMs;
        store.setJoined(joined);
        // FR-5.5 — the channels available on arrival. Revised by every
        // PARTICIPANT_UPDATE that carries a set.
        useChatStore.getState().setAdvertised(joined.chatChannels ?? []);
        // A persistent channel carried on while this client was away, and
        // nothing on the socket says what was missed. The refetch merges by
        // message id, so the gap fills in and nothing on screen moves.
        if (joined.resumed) useChatStore.getState().invalidateHistory();

        // A resume rejoins an existing world; a fresh join has to load one.
        if (joined.resumed && store.appState === 'reconnecting') {
          store.clearRoster();
          store.setAppState('in-world');
        }
        this.startSending();

        // Phase 2. Joined in parallel with loading the world rather than after
        // it: the SFU handshake and the GLB download are independent, and
        // serialising them would add seconds to the first moment anyone can
        // speak. A null grant means the server has no SFU — presence is
        // unaffected, which is what FR-2.5 asks for.
        void media.connect(joined.media, joined.tuning);
        break;
      }

      case Op.SNAPSHOT: {
        const snapshot = payload as SnapshotPayload;
        store.applySnapshot(snapshot.participants, snapshot.totalInInstance);
        break;
      }

      case Op.PARTICIPANT_ADD:
        store.addParticipant(payload as ParticipantDto);
        break;

      case Op.PARTICIPANT_REMOVE: {
        const { id } = payload as { id: number };
        store.removeParticipant(id);
        break;
      }

      case Op.PARTICIPANT_UPDATE: {
        const update = payload as {
          id: number;
          displayName?: string;
          status?: RosterStatus;
          activity?: 'active' | 'idle';
          totalInInstance?: number;
          appearance?: AvatarAppearance;
          chatChannels?: ChatChannelDto[];
          identity?: ParticipantIdentity;
          role?: Role;
          moderation?: ParticipantModeration;
          blocked?: boolean;
        };
        // FR-5.5 — the zone channel appears and disappears as the participant
        // crosses a chat-enabled zone. Only ever present on frames about self;
        // the server does not broadcast somebody else's channel set.
        if (update.chatChannels) useChatStore.getState().setAdvertised(update.chatChannels);
        store.updateParticipant({
          localId: update.id,
          ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(update.activity !== undefined ? { activity: update.activity } : {}),
          ...(update.totalInInstance !== undefined ? { total: update.totalInInstance } : {}),
          // FR-4.6 — a customization someone else made, live.
          ...(update.appearance !== undefined ? { appearance: update.appearance } : {}),
          // FR-6.13 — somebody stopped being a guest without going anywhere.
          ...(update.identity !== undefined ? { identity: update.identity } : {}),
          // FR-7.1 — a role change, live.
          ...(update.role !== undefined ? { role: update.role } : {}),
          // FR-7.5 / FR-7.6 — the fact that somebody was muted. The presence
          // list shows it so a room where one person has gone quiet can tell
          // "moderated" from "microphone broken".
          ...(update.moderation !== undefined ? { moderation: update.moderation } : {}),
          // FR-7.16 — arrives only on the blocker's own copy.
          ...(update.blocked !== undefined ? { blocked: update.blocked } : {}),
        });
        break;
      }

      /**
       * FR-4.15 — someone emoted, and the server allowed it.
       *
       * Pushed to a plain Map rather than into React state: the avatar that owns
       * it reads it inside `useFrame`, and re-rendering the tree to start a
       * two-second gesture is the per-frame-data mistake this client is built to
       * avoid. Unknown emote ids are dropped — a newer server naming a gesture
       * this build has no clip for is the versioning rule, not an error.
       */
      case Op.EMOTE_PLAY: {
        const play = payload as EmotePlayPayload;
        const definition = emoteById(play.emote);
        if (!definition) break;
        pushEmote(play.id, {
          clip: definition.clip,
          glyph: definition.glyph,
          durationMs: play.durationMs,
          at: performance.now(),
        });
        break;
      }

      case Op.FORCE_TRANSFORM:
        this.onForceTransform?.(payload as ForceTransformPayload);
        break;

      // ── Chat (phase 5) ───────────────────────────────────────────────────
      //
      // Into React state, unlike emotes and transforms: a message is read, not
      // animated, and there is no per-frame cost to keeping it in the store the
      // panel renders from.

      case Op.CHAT_MESSAGE:
        useChatStore.getState().receive(payload as ChatMessagePayload);
        break;

      case Op.TYPING_STATE:
        useChatStore.getState().applyTyping(payload as TypingStatePayload);
        break;

      case Op.CHAT_HISTORY_RESULT: {
        const result = payload as ChatHistoryResultPayload;
        useChatStore
          .getState()
          .receiveHistory(result.channelId, result.messages, result.complete, result.lastReadSeq);
        break;
      }

      /**
       * Phase 6, `FR-6.7` — this session is now somebody else.
       *
       * Arrives unprompted on a socket that never dropped, exactly once: a guest
       * upgraded to an account over HTTP while standing in the world. The name
       * and appearance are applied here rather than waiting for the
       * `PARTICIPANT_UPDATE` that observers get, so the person who just signed up
       * sees their own nameplate change at the same moment everybody else does.
       */
      case Op.IDENTITY: {
        const identity = payload as IdentityStatePayload;
        store.applyIdentity(identity);
        // The account itself is fetched rather than assembled from this frame:
        // the frame carries what the *world* needs, and the panel needs
        // memberships and an email that have no business on a world frame.
        if (identity.kind === 'account') {
          void auth
            .me()
            .then((account) => useAuthStore.getState().setAccount(account))
            .catch(() => {
              /* The socket already said what happened; a failed fetch here just
                 leaves the panel to catch up on the next open. */
            });
        }
        break;
      }

      /**
       * Phase 7, `FR-7.5` — you have been muted, or unmuted, and by whom.
       *
       * Sent only to the person it describes, which is why it is its own frame
       * and why the notice can name a moderator. Arrives again after a resume
       * with the same `at`, so the state is restored without re-announcing an
       * event that already happened — a client that told you twice would be
       * indistinguishable from a moderator doing it twice.
       */
      case Op.MODERATION_STATE: {
        const moderation = payload as ModerationStatePayload;
        const previous = store.moderation;
        store.applyModeration(moderation);

        // The media layer stops publishing straight away rather than waiting for
        // the SFU to refuse it. The permission is revoked server-side either way
        // (`FR-7.5` is not enforced here) — this is so the microphone light on
        // the person's machine goes out at the same moment everybody else stops
        // hearing them.
        void media.applyModeration(moderation);

        if (moderation.at === previous?.at) break;
        if (moderation.micMuted || moderation.cameraDisabled) {
          const what = moderation.micMuted
            ? moderation.cameraDisabled
              ? 'Your microphone and camera have been turned off'
              : 'Your microphone has been muted'
            : 'Your camera has been turned off';
          store.notify(
            `${what}${moderation.byName ? ` by ${moderation.byName}` : ''}.` +
              `${moderation.reason ? ` ${moderation.reason}` : ''}`,
          );
        } else if (previous && (previous.micMuted || previous.cameraDisabled)) {
          store.notify('A moderator has restored your microphone and camera.');
        }
        break;
      }

      /**
       * Phase 8, `FR-8.6` — a whole new world, on a socket that never dropped.
       *
       * Four things have already changed on the server by the time this arrives
       * — instance membership, the LiveKit room, the transform and the area of
       * interest — and this frame is the single announcement of all four. So the
       * order here matters and mirrors it:
       *
       *   1. **Media first.** The grant names the destination room, and a
       *      LiveKit token is per-room: staying connected to the old one would
       *      leave the participant publishing into a room nobody in their new
       *      map is subscribed to, which presents as "my microphone stopped
       *      working" rather than as a transfer bug.
       *   2. **Chat.** A zone channel belongs to the Map that authored the zone,
       *      so none of the old ones survive; the frame carries the new set.
       *   3. **World state**, which is where the roster is dropped and — when
       *      the Map itself changed — a reload is requested.
       */
      case Op.MAP_TRANSFER: {
        const transfer = payload as MapTransferPayload;
        const sameMap = store.world?.mapId === transfer.mapId;

        // `tuning` is set by the first `JOINED` and never changes afterwards —
        // it describes the server, not the Map — so it is always present by the
        // time a transfer can happen. The guard is for the impossible case
        // rather than a real one, and skipping media is the right answer to it.
        if (store.tuning) void media.connect(transfer.media, store.tuning);

        const chat = useChatStore.getState();
        // A conversation belongs to the room it happened in. `nearby` and `zone`
        // were never stored at all (`FR-5.13`) and the persistent channels are
        // re-fetched for the Map arrived in — the room channel is a different
        // set of rows on the other side of a door.
        if (!sameMap) chat.reset();
        chat.setAdvertised(transfer.chatChannels ?? []);

        store.applyMapTransfer(transfer);

        // Same Map, different copy of it: nothing reloads, so nothing else would
        // move the character. The reload path passes the spawn into
        // `buildPhysics`, which is why this is only needed here.
        if (sameMap) {
          this.resetBuffers();
          this.onForceTransform?.({ transform: transfer.spawn, reason: 'transfer' });
        }
        break;
      }

      /** Phase 8, `FR-8.12` — where everybody is. Whole documents, so a dropped
       *  frame costs one refresh rather than corrupting an accumulated view. */
      case Op.SPACE_DIRECTORY:
        store.setDirectory(payload as SpaceDirectoryDto);
        break;

      /**
       * Phase 9, `FR-9.20` — somebody republished the room you are standing in.
       *
       * A notice and an offer, never a reload. The requirement is explicit that
       * publishing must not hard-break the people inside, and a client that tore
       * the world down mid-sentence would be exactly that. The instance they are
       * in keeps the document it was allocated with; walking out and back in —
       * or taking this offer — is what picks up the new one.
       */
      case Op.MAP_UPDATED: {
        const update = payload as MapUpdatedPayload;
        store.setMapUpdate(update);
        store.notify(
          `${update.by ?? 'Somebody'} published a new version of ${update.mapName}` +
            `${update.notes ? `: ${update.notes}` : '.'}`,
        );
        break;
      }

      case Op.CHAT_REJECT: {
        const reject = payload as ChatRejectPayload;
        useChatStore.getState().reject(reject);
        // The failed message is marked in place, which is the durable signal.
        // The notice is for the case where the panel is closed or the message
        // has scrolled away — a rate limit is worth saying out loud once.
        if (reject.code === 'rate-limited') store.notify(reject.message);
        break;
      }

      /**
       * FR-2.6, FR-2.11, FR-2.16 — the server's decision about who this
       * participant may hear and see.
       *
       * One handler, deliberately. The media layer turns it into LiveKit
       * subscriptions and Web Audio gain; a second reader anywhere would be a
       * second opinion about a decision the server owns.
       */
      case Op.AUDIENCE:
        media.applyAudience((payload as AudiencePayload).targets);
        break;

      case Op.ZONE_EVENT: {
        const event = payload as ZoneEventPayload;
        store.applyZoneEvent(event);
        // The badge shows the state; this is the transition, which is the part
        // you can be looking away for. Someone whose audio has just become
        // private has to be told, not left to notice.
        if (event.zoneType === 'private') {
          store.notify(
            event.kind === 'enter'
              ? 'Your audio is private to this zone.'
              : 'Your audio is no longer private.',
          );
        }
        break;
      }

      case Op.ERROR: {
        const error = payload as {
          code: string;
          message: string;
          fatal: boolean;
        };
        console.warn(`[net] server error: ${error.code} — ${error.message}`);
        if (!error.fatal && error.code === 'portal-unresolved') {
          // Phase 3 Rules: the participant stays put "and is informed". They are
          // standing on a doorway that did nothing, which without this reads as
          // the world being broken rather than the destination being missing.
          store.notify('That doorway leads nowhere right now.');
        }
        /**
         * Phase 6 — two refusals that are about *who you are*, not about the
         * connection, and each needs its own answer.
         *
         * `guests-not-allowed` (`AC-6.5`) is not retryable: trying again as the
         * same nobody produces the same refusal. The way through is to sign in
         * or open an invite, which is where the entry screen sends them.
         *
         * `auth-required` means the token did not resolve. The client is
         * *already* signed out by the time it gets here — the refresh that ran
         * before `JOIN` would have fixed a merely-expired token, so reaching this
         * point means the session is genuinely over. Dropping the account is
         * what stops the entry screen offering to rejoin with a credential that
         * no longer works.
         */
        if (error.code === 'guests-not-allowed' || error.code === 'auth-required') {
          this.intentionalClose = true;
          this.resumeToken = null;
          if (error.code === 'auth-required') useAuthStore.getState().signOut();
          store.fail({
            title:
              error.code === 'guests-not-allowed'
                ? 'This space requires an account.'
                : 'Your session has ended.',
            detail: error.message,
            retryable: false,
            technical: error.code,
          });
          break;
        }

        /**
         * Phase 7 — a refusal that is about *policy*, not about the connection.
         *
         * `AC-7.4` requires a clear reason, and each of these needs a different
         * next step from the person reading it: type a password, wait, ask an
         * admin, or accept that they cannot come in. Retrying is offered only
         * where retrying can plausibly work, which is the Phase 1 rule about
         * error states and is why a ban and a full room are not the same button.
         *
         * A wrong password sends them back to the entry screen rather than
         * retrying, because a retry would present the same wrong password.
         */
        if (POLICY_REFUSALS.has(error.code)) {
          this.intentionalClose = true;
          this.resumeToken = null;
          if (error.code === 'password-incorrect' || error.code === 'password-required') {
            this.spacePassword = null;
          }
          store.fail({
            title: POLICY_TITLE[error.code] ?? 'You cannot enter this space.',
            detail: error.message,
            // A full room empties and a lock is lifted; a ban and an allowlist
            // are somebody else's decision and a retry only produces the same
            // sentence again.
            retryable: error.code === 'world-full' || error.code === 'space-locked',
            technical: error.code,
          });
          break;
        }

        // `FR-7.4` — a moderation action that was refused. Non-fatal: the
        // connection is fine, the request was not, and the requirement is that
        // the attempt is *refused* rather than silently doing nothing.
        //
        // Phase 8 adds the two room-level refusals to the same treatment, and
        // they are non-fatal for a stronger reason: the participant is still
        // standing exactly where they were. A full Map (`FR-8.8`) and one that
        // has been archived (`FR-8.17`) are both "you cannot go there", never
        // "you are nowhere".
        if (
          !error.fatal &&
          (error.code === 'forbidden' ||
            error.code === 'map-full' ||
            error.code === 'map-unavailable')
        ) {
          store.notify(error.message);
          break;
        }

        if (error.fatal) {
          store.fail({
            title: 'The server rejected the connection.',
            detail: error.message,
            retryable: error.code !== 'banned',
            technical: error.code,
          });
        }
        break;
      }
    }
  }

  private onBatch(data: ArrayBuffer): void {
    const entries = decodeTransformBatch(data);
    if (!entries) return;

    const tuning = useStore.getState().tuning;
    const bufferMs = tuning?.interpolationBufferMs ?? 100;
    // One batch per world tick, so the tick period is the cadence these arrive
    // on — which is what lets the buffer tell the sender's timing apart from the
    // network's. See `TransformBuffer.schedule`.
    const periodMs = 1000 / (tuning?.tickRateHz || 20);
    // Monotonic, never wall-clock: clients are not assumed to agree on time and
    // a clock jump would tear the motion apart.
    const now = performance.now();

    for (const entry of entries) {
      ensureBuffer(entry.id, bufferMs, periodMs).push({
        t: now,
        x: entry.transform.x,
        y: entry.transform.y,
        z: entry.transform.z,
        yaw: entry.transform.yaw,
        // Buffered with the position rather than read live, so the animation
        // state matches the moment being drawn (FR-4.2).
        flags: entry.flags,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  private startSending(): void {
    this.stopSending();
    const hz = useStore.getState().tuning?.clientSendRateHz ?? 20;
    this.sendTimer = window.setInterval(
      () => {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        this.socket.send(encodeTransform(this.localTransform, this.localFlags));
      },
      Math.round(1000 / hz),
    );
  }

  private stopSending(): void {
    if (this.sendTimer !== null) window.clearInterval(this.sendTimer);
    this.sendTimer = null;
  }

  /** Interpolation history for everyone, dropped on a hard resync. */
  resetBuffers(): void {
    remoteBuffers.clear();
  }
}

type RosterStatus = 'available' | 'away' | 'do-not-disturb';

/**
 * Phase 7 — the refusals that are about the Space's policy rather than the
 * connection (`FR-7.8`, `FR-7.11`–`FR-7.14`).
 *
 * A set and a lookup table rather than a switch, so adding a code without
 * writing the sentence somebody reads is a compile-time gap rather than a
 * generic message in production.
 */
const POLICY_TITLE: Record<string, string> = {
  banned: 'You have been banned from this space.',
  'space-locked': 'This space is closed right now.',
  'password-required': 'This space needs a password.',
  'password-incorrect': 'That password is not right.',
  'not-allowlisted': 'You are not on the list for this space.',
  'world-full': 'This space is full.',
};

const POLICY_REFUSALS = new Set(Object.keys(POLICY_TITLE));

/**
 * The channel a send goes into from the **sender's** point of view.
 *
 * Only the direct case differs from what the server will echo back, and it
 * differs deliberately: a direct channel is named from the reader's side, so the
 * sender's copy lives under `direct:<them>` while the recipient's lives under
 * `direct:<me>`. Deriving it locally is what lets the optimistic message appear
 * in the right thread before any reply exists.
 */
function localChannelId(scope: ChatScope, targetId?: string): string {
  switch (scope) {
    case 'room':
      return ROOM_CHANNEL_ID;
    case 'nearby':
      return NEARBY_CHANNEL_ID;
    case 'zone':
      return zoneChannelId(targetId ?? '');
    case 'direct':
      return directChannelId(targetId ?? '');
  }
}

export const net = new NetClient();
