/**
 * A headless participant.
 *
 * Speaks the real protocol through @hubitat/protocol — the same encoders the
 * browser and the server use. That is what makes these scenarios cover the
 * codec end to end: a byte-layout regression fails here rather than showing up
 * later as avatars in the wrong place.
 */

import { WebSocket } from 'ws';
import {
  Op,
  PROTOCOL_VERSION,
  decodeJsonFrame,
  decodeTransformBatch,
  encodeJsonFrame,
  encodeTransform,
  isJsonOpcode,
  readOpcode,
  type AudienceEntryPayload,
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
  type ModerationAction,
  type ModerationStatePayload,
  type ParticipantDto,
  type ParticipantIdentity,
  type ParticipantModeration,
  type PresenceStatus,
  type Role,
  type SpaceDirectoryDto,
  type Transform,
  type TypingStatePayload,
  type ZoneEventPayload,
} from '@hubitat/protocol';

export interface RemoteView {
  localId: number;
  sessionId: string;
  displayName: string;
  transform: Transform;
  lastBatchAt: number;
  /** Phase 4. Updated from SNAPSHOT, PARTICIPANT_ADD and PARTICIPANT_UPDATE —
   *  the three paths FR-4.6 and the late-arrival rule run through. */
  appearance: AvatarAppearance;
  status: PresenceStatus;
  activity: 'active' | 'idle';
  /** Phase 6, `FR-6.13` — guest or account, and whether they belong here. */
  identity: ParticipantIdentity;
  /** Phase 7, `FR-7.1`. */
  role: Role;
  /** Phase 7, `FR-7.5` / `FR-7.6` — the fact, as observers are told it. */
  moderation: ParticipantModeration;
  /** Phase 7, `FR-7.16` — whether *this bot* has blocked them. Per observer,
   *  which is why it is on the remote view rather than in a set of its own. */
  blocked: boolean;
}

export interface BotEvents {
  adds: number;
  removes: number;
  batches: number;
  errors: { code: string; message: string }[];
}

/**
 * Every live bot, so the runner can guarantee a clean slate between scenarios.
 *
 * Without this, one failing scenario leaves its bots connected and every later
 * scenario inherits a stranger standing in the world — which shows up as an
 * "extra" participant in a strict interest-set assertion and looks like a
 * server bug. Cleanup belongs to the runner, not to each scenario's `finally`.
 */
const ACTIVE_BOTS = new Set<Bot>();

export function closeAllBots(): void {
  for (const bot of ACTIVE_BOTS) bot.terminate();
  ACTIVE_BOTS.clear();
}

export class Bot {
  readonly name: string;
  private socket: WebSocket | null = null;

  joined: JoinedPayload | null = null;
  snapshot: ParticipantDto[] = [];
  transform: Transform = { x: 0, y: 0, z: 0, yaw: 0 };

  /** Everyone this bot currently sees, keyed by instance-local id. */
  readonly remotes = new Map<number, RemoteView>();
  readonly events: BotEvents = { adds: 0, removes: 0, batches: 0, errors: [] };

  /** Every transform observed for a given remote, for the wire round-trip check. */
  readonly observed = new Map<number, Transform[]>();

  /** Zone transitions, in order (FR-3.17). Kept as a list rather than counters
   *  because AC-3.5 is about the *sequence* — one enter, then one exit. */
  readonly zoneEvents: ZoneEventPayload[] = [];

  /** Every EMOTE_PLAY seen, in order. A list rather than a counter because the
   *  throttle assertion is about *how many of a burst survived*, and a counter
   *  cannot tell one emote sent five times from five different ones. */
  readonly emotes: EmotePlayPayload[] = [];

  /** PARTICIPANT_UPDATE frames, in order, including ones about self. FR-4.6 and
   *  FR-4.11 are both "the change reached the observer", which is a frame
   *  arriving, not a field eventually holding the right value. */
  readonly updates: { id: number; [key: string]: unknown }[] = [];

  /** The latest AUDIENCE frame, and how many have arrived. The count is what
   *  proves the server is not re-sending an unchanged set every tick. */
  audience: AudienceEntryPayload[] = [];
  audienceUpdates = 0;

  /** Server-issued position overrides (spawn, portal, moderation). */
  readonly forced: ForceTransformPayload[] = [];

  /**
   * Every CHAT_MESSAGE seen, in arrival order (phase 5).
   *
   * Arrival order rather than `seq` order on purpose: `FR-5.7` is a claim about
   * the order messages are *delivered* in, and a list the bot has already sorted
   * could not tell a violation from a correct run.
   */
  readonly chat: ChatMessagePayload[] = [];
  readonly typingFrames: TypingStatePayload[] = [];
  readonly histories: ChatHistoryResultPayload[] = [];
  /** `FR-5.8` — sends the server refused. */
  readonly chatRejects: ChatRejectPayload[] = [];
  /** `FR-5.5` — the latest advertised channel set. */
  chatChannels: ChatChannelDto[] = [];

  /**
   * Phase 6 — the access token this bot presents on `JOIN` (`FR-6.18`).
   *
   * Set by `Accounts.signIn` in `accounts.ts`, or left null to be a guest. Held
   * in memory only, exactly as the browser client holds it (ADR 0011).
   */
  accessToken: string | null = null;

  /** `0x9e IDENTITY` frames, in order. A list rather than a latest-value because
   *  `FR-6.7` is about a *transition* arriving on a socket that never dropped —
   *  a field holding the right value cannot tell that from a reconnect. */
  readonly identities: IdentityStatePayload[] = [];

  /**
   * Phase 7, `FR-7.5` — every `MODERATION_STATE` frame, in order.
   *
   * A list rather than a latest-value for the reason `identities` is one: `AC-7.2`
   * is about the target being *informed*, which is a frame arriving. A field
   * holding `micMuted: true` cannot tell "they were told" from "they joined
   * already muted", and the second is exactly what a rejoin looks like.
   */
  readonly moderationStates: ModerationStatePayload[] = [];

  /** Phase 7 — this bot's own role and capability list, from `JOINED` and any
   *  later `IDENTITY`. `FR-7.2`, as the client is told it. */
  role: Role = 'guest';
  capabilities: string[] = [];

  /**
   * Phase 7 — the fingerprint this bot presents on `JOIN` (`FR-7.8`).
   *
   * Distinct per bot by default, so one scenario's guest ban does not lock every
   * other scenario's guest out of the world. A scenario that wants two sockets
   * to look like the same browser sets them to the same string, which is the
   * only way to exercise a guest ban at all.
   */
  fingerprint: string = `harness-${Math.random().toString(36).slice(2, 10)}`;

  /** Phase 7, `FR-7.12` — presented on `JOIN` when the space asks for one. */
  spacePassword: string | null = null;

  /**
   * Phase 8, `FR-8.6` — every `MAP_TRANSFER`, in order.
   *
   * A list rather than a latest-value, for the reason `identities` is one:
   * `AC-8.1` is about a *move happening*, and a field holding the destination
   * cannot tell "walked through the portal" from "landed there in the first
   * place". A portal that fired twice is also a list of two, which is exactly
   * what the re-trigger rule forbids.
   */
  readonly transfers: MapTransferPayload[] = [];

  /** Phase 8, `FR-8.12` — the latest directory, and how many arrived. The count
   *  is what proves the server is not re-sending an unchanged document. */
  directory: SpaceDirectoryDto | null = null;
  directoryUpdates = 0;

  private sendTimer: NodeJS.Timeout | null = null;
  private chatCounter = 0;
  private readonly url: string;

  constructor(url: string, name: string) {
    this.url = url;
    this.name = name;
    ACTIVE_BOTS.add(this);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection
  // ───────────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, [PROTOCOL_VERSION]);
      socket.binaryType = 'nodebuffer';
      this.socket = socket;

      const onError = (error: Error) => reject(error);
      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        socket.on('error', () => {
          /* post-open errors surface as a close */
        });
        socket.on('message', (data) => this.onMessage(data as Buffer));
        resolve();
      });
    });
  }

  /** FR-1.1 / FR-1.5. Pass a resume token to rebind an existing participant. */
  async join(resumeToken?: string, appearance?: AvatarAppearance): Promise<JoinedPayload> {
    this.sendJson(Op.JOIN, {
      displayName: this.name,
      worldId: 'default',
      ...(appearance ? { appearance } : {}),
      ...(resumeToken ? { resumeToken } : {}),
      // Phase 6, FR-6.18. Only when this bot has signed in; a guest sends none,
      // which is the phase 1 path unchanged.
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
      // Phase 7, FR-7.8 and FR-7.12.
      clientFingerprint: this.fingerprint,
      ...(this.spacePassword ? { spacePassword: this.spacePassword } : {}),
    });

    const joined = await this.waitFor(() => this.joined, 5000, `${this.name}: JOINED`);
    this.transform = { ...joined.spawn };
    return joined;
  }

  /**
   * Send `JOIN` and wait for whichever answer comes — phase 6.
   *
   * `join` above waits for `JOINED` and times out on anything else, which is the
   * right shape for every scenario before this phase. `FR-6.8` and `FR-6.18`
   * introduce joins that are *supposed* to be refused, and a five-second timeout
   * is a poor way to assert a refusal that arrives in two milliseconds. Returns
   * the error instead, so a scenario can assert on its code.
   */
  async tryJoin(
    resumeToken?: string,
  ): Promise<{ joined?: JoinedPayload; error?: { code: string; message: string } }> {
    const errorsBefore = this.events.errors.length;
    this.sendJson(Op.JOIN, {
      displayName: this.name,
      worldId: 'default',
      ...(resumeToken ? { resumeToken } : {}),
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
      clientFingerprint: this.fingerprint,
      ...(this.spacePassword ? { spacePassword: this.spacePassword } : {}),
    });

    const deadline = Date.now() + 5000;
    for (;;) {
      if (this.joined) {
        this.transform = { ...this.joined.spawn };
        return { joined: this.joined };
      }
      const error = this.events.errors[errorsBefore];
      if (error) return { error };
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.name}: JOIN answer`);
      await sleep(20);
    }
  }

  /**
   * Deliberate departure. Sends LEAVE before closing, so the server removes the
   * participant outright instead of retaining them for the resume window — a
   * bare socket close means "I might be back" (FR-1.5), not "I'm done".
   */
  close(): void {
    this.stopSending();
    ACTIVE_BOTS.delete(this);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendJson(Op.LEAVE, {});
    }
    this.socket?.close(1000, 'bye');
  }

  /** Abrupt disconnect with no close frame — a crashed tab, not a clean exit. */
  terminate(): void {
    this.stopSending();
    ACTIVE_BOTS.delete(this);
    this.socket?.terminate();
  }

  /**
   * Stop reading from the underlying TCP socket without closing it.
   *
   * `ws` answers pings automatically, so this is the only way to simulate a
   * half-open connection: the TCP session stays up, but pings are never
   * processed and pongs never sent — which is exactly what FR-1.6's stale
   * detection exists to catch.
   */
  goSilent(): void {
    this.stopSending();
    const raw = (this.socket as unknown as { _socket?: { pause(): void } })?._socket;
    raw?.pause();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4 actions
  // ───────────────────────────────────────────────────────────────────────────

  /** FR-4.11. `idle` is unsettable by design (FR-1.22) and the type says so. */
  setStatus(status: PresenceStatus): void {
    this.sendJson(Op.SET_STATUS, { status });
  }

  /** FR-4.5, FR-4.7 — a live customization change. */
  setAppearance(appearance: AvatarAppearance): void {
    this.sendJson(Op.SET_APPEARANCE, { appearance });
  }

  /** FR-4.14. Whether it is broadcast is the server's decision (FR-4.16), which
   *  is the point of sending more of them than the interval allows. */
  emote(emote: string): void {
    this.sendJson(Op.EMOTE, { emote });
  }

  /** Every emote this bot saw from one participant. */
  emotesFrom(localId: number): EmotePlayPayload[] {
    return this.emotes.filter((emote) => emote.id === localId);
  }

  /** Every PARTICIPANT_UPDATE about one participant that carried a given field. */
  updatesFor(localId: number, field: string): { id: number; [key: string]: unknown }[] {
    return this.updates.filter((update) => update.id === localId && field in update);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 5 actions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-5.1`–`FR-5.4`. Returns the `tempId`, so a scenario can find the sender's
   * own echo and tell it apart from a recipient's copy (`FR-5.8`).
   */
  chatSend(scope: ChatScope, body: string, targetId?: string): string {
    const tempId = `${this.name}-${++this.chatCounter}`;
    this.sendJson(Op.CHAT_SEND, {
      scope,
      body,
      tempId,
      ...(targetId ? { targetId } : {}),
    });
    return tempId;
  }

  /** `FR-5.10`. */
  chatTyping(scope: ChatScope, typing: boolean, targetId?: string): void {
    this.sendJson(Op.TYPING, {
      scope,
      typing,
      ...(targetId ? { targetId } : {}),
    });
  }

  /** `FR-5.12`. */
  chatHistory(channelId: string, beforeSeq?: number): void {
    this.sendJson(Op.CHAT_HISTORY, {
      channelId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
  }

  /** `FR-5.16`. */
  chatRead(channelId: string, seq: number): void {
    this.sendJson(Op.CHAT_READ, { channelId, seq });
  }

  /** Messages this bot received in one channel, in arrival order. */
  chatIn(channelId: string): ChatMessagePayload[] {
    return this.chat.filter((message) => message.channelId === channelId);
  }

  /** Whether this bot ever received a message with a given body — the assertion
   *  every scoping scenario is built from. */
  received(body: string): boolean {
    return this.chat.some((message) => message.body === body);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 7 actions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-7.5`–`FR-7.9`. Whether it is *allowed* is the server's decision, which
   * is the point of sending them from bots that should not be permitted to.
   */
  moderate(
    action: ModerationAction,
    targetSessionId: string,
    options: { reason?: string; durationMinutes?: number } = {},
  ): void {
    this.sendJson(Op.MODERATE, {
      action,
      targetSessionId,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.durationMinutes ? { durationMinutes: options.durationMinutes } : {}),
    });
  }

  /** `FR-7.16`, `FR-7.18`. */
  setBlocked(targetSessionId: string, blocked: boolean): void {
    this.sendJson(Op.BLOCK, { targetSessionId, blocked });
  }

  /** `FR-7.17`. */
  report(targetSessionId: string, reason?: string): void {
    this.sendJson(Op.REPORT, { targetSessionId, ...(reason ? { reason } : {}) });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 8 actions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-8.13`, `FR-8.14` — go somewhere else in this Space.
   *
   * Whether it is *permitted*, and which instance it lands in, is the server's
   * decision — which is the point of sending a `followSessionId` into a Map that
   * is full and asserting on where the bot ends up.
   */
  navigate(target: { mapId?: string; instanceId?: string; followSessionId?: string }): void {
    this.sendJson(Op.NAVIGATE, {
      ...(target.mapId ? { mapId: target.mapId } : {}),
      ...(target.instanceId ? { instanceId: target.instanceId } : {}),
      ...(target.followSessionId ? { followSessionId: target.followSessionId } : {}),
    });
  }

  /** `FR-8.12` — ask for the directory now rather than waiting for a push. */
  requestDirectory(): void {
    this.sendJson(Op.DIRECTORY, {});
  }

  /** Where this bot is, from the last `JOINED` or `MAP_TRANSFER`. Undefined
   *  before the handshake. */
  get place(): { mapId: string; mapSlug: string; instanceId: string } | undefined {
    const last = this.transfers.at(-1);
    if (last) {
      return { mapId: last.mapId, mapSlug: last.mapSlug, instanceId: last.instanceId };
    }
    if (!this.joined) return undefined;
    return {
      mapId: this.joined.mapId,
      // `JOINED` names the Map but not its slug separately; the directory is
      // where a slug comes from, and every scenario that needs one has it.
      mapSlug:
        this.directory?.maps.find((map) => map.mapId === this.joined?.mapId)?.slug ??
        this.joined.mapId,
      instanceId: this.joined.instanceId,
    };
  }

  /** The remote view for one session id, which is how a scenario finds somebody
   *  it only knows by session — the moderation frames address sessions. */
  remoteBySession(sessionId: string): RemoteView | undefined {
    for (const remote of this.remotes.values()) {
      if (remote.sessionId === sessionId) return remote;
    }
    return undefined;
  }

  /** Errors this bot received with a given code, in order. `FR-7.4` refusals
   *  arrive as `forbidden`, and asserting on the code is what distinguishes
   *  "refused" from "silently ignored". */
  errorsWithCode(code: string): { code: string; message: string }[] {
    return this.events.errors.filter((error) => error.code === code);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Movement
  // ───────────────────────────────────────────────────────────────────────────

  moveTo(x: number, z: number, y = 0, yaw = 0): void {
    this.transform = { x, y, z, yaw };
    this.sendTransform();
  }

  sendTransform(flags = 1): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeTransform(this.transform, flags));
  }

  startSending(hz = 20): void {
    this.stopSending();
    this.sendTimer = setInterval(() => this.sendTransform(), Math.round(1000 / hz));
  }

  stopSending(): void {
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.sendTimer = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Receiving
  // ───────────────────────────────────────────────────────────────────────────

  private onMessage(data: Buffer): void {
    const opcode = readOpcode(data);
    if (opcode === null) return;

    if (!isJsonOpcode(opcode)) {
      if (opcode === Op.TRANSFORM_BATCH) this.onBatch(data);
      return;
    }

    const payload = decodeJsonFrame(data) as Record<string, unknown> | null;
    if (!payload) return;

    switch (opcode) {
      case Op.JOINED:
        this.joined = payload as unknown as JoinedPayload;
        this.chatChannels = this.joined.chatChannels ?? [];
        // Phase 7, `FR-7.2` — stated on the handshake.
        this.role = this.joined.identity?.role ?? 'guest';
        this.capabilities = [...(this.joined.identity?.capabilities ?? [])];
        break;

      case Op.SNAPSHOT: {
        const snap = payload as unknown as { participants: ParticipantDto[] };
        this.snapshot = snap.participants;
        for (const participant of snap.participants) this.addRemote(participant);
        break;
      }

      case Op.PARTICIPANT_ADD:
        this.addRemote(payload as unknown as ParticipantDto);
        this.events.adds++;
        break;

      case Op.PARTICIPANT_REMOVE: {
        const { id } = payload as unknown as { id: number };
        if (this.remotes.delete(id)) this.events.removes++;
        break;
      }

      case Op.PARTICIPANT_UPDATE: {
        const update = payload as unknown as {
          id: number;
          displayName?: string;
          status?: PresenceStatus;
          activity?: 'active' | 'idle';
          appearance?: AvatarAppearance;
          chatChannels?: ChatChannelDto[];
          identity?: ParticipantIdentity;
          role?: Role;
          moderation?: ParticipantModeration;
          blocked?: boolean;
        };
        this.updates.push(update as { id: number; [key: string]: unknown });

        // FR-5.5 — only ever present on frames about self, which is what the
        // channel-scoping scenario asserts.
        if (update.chatChannels) this.chatChannels = update.chatChannels;

        const remote = this.remotes.get(update.id);
        if (!remote) break;
        if (update.displayName) remote.displayName = update.displayName;
        if (update.status) remote.status = update.status;
        if (update.activity) remote.activity = update.activity;
        if (update.appearance) remote.appearance = update.appearance;
        // FR-6.13 — a guest who upgraded mid-session stops being marked as one.
        if (update.identity) remote.identity = update.identity;
        // Phase 7.
        if (update.role) remote.role = update.role;
        if (update.moderation) remote.moderation = update.moderation;
        if (update.blocked !== undefined) remote.blocked = update.blocked;
        break;
      }

      case Op.EMOTE_PLAY:
        this.emotes.push(payload as unknown as EmotePlayPayload);
        break;

      case Op.FORCE_TRANSFORM: {
        const forced = payload as unknown as ForceTransformPayload;
        this.forced.push(forced);
        // Applied, not merely recorded. A real client is authoritative over its
        // own position and would start reporting from the new one; a bot that
        // kept sending the old position would walk back into the portal it just
        // came out of and turn a passing test into a loop.
        this.transform = { ...forced.transform };
        break;
      }

      case Op.AUDIENCE: {
        const frame = payload as unknown as { targets: AudienceEntryPayload[] };
        this.audience = frame.targets;
        this.audienceUpdates++;
        break;
      }

      case Op.ZONE_EVENT:
        this.zoneEvents.push(payload as unknown as ZoneEventPayload);
        break;

      case Op.CHAT_MESSAGE:
        this.chat.push(payload as unknown as ChatMessagePayload);
        break;

      case Op.TYPING_STATE:
        this.typingFrames.push(payload as unknown as TypingStatePayload);
        break;

      case Op.CHAT_HISTORY_RESULT:
        this.histories.push(payload as unknown as ChatHistoryResultPayload);
        break;

      case Op.CHAT_REJECT:
        this.chatRejects.push(payload as unknown as ChatRejectPayload);
        break;

      // Phase 6, FR-6.7 — the identity of this connection changed without the
      // connection changing.
      case Op.IDENTITY: {
        const identity = payload as unknown as IdentityStatePayload;
        this.identities.push(identity);
        // Phase 7, `FR-7.10` — a role change reaching a live session.
        this.role = identity.role ?? this.role;
        this.capabilities = [...(identity.capabilities ?? [])];
        break;
      }

      // Phase 7, FR-7.5 — what a moderated participant is told about themself.
      case Op.MODERATION_STATE:
        this.moderationStates.push(payload as unknown as ModerationStatePayload);
        break;

      /**
       * Phase 8, `FR-8.6` — a whole new world on a socket that never dropped.
       *
       * The roster is cleared here, not merely recorded. A real client drops
       * everyone in the map it is leaving — they are announced as removed on the
       * way out — and a bot that kept them would assert against a room full of
       * people who are somewhere else. The transform is applied for the same
       * reason `FORCE_TRANSFORM` is: a bot still reporting its old position would
       * be standing at the previous map's coordinates in this one.
       */
      case Op.MAP_TRANSFER: {
        const transfer = payload as unknown as MapTransferPayload;
        this.transfers.push(transfer);
        this.transform = { ...transfer.spawn };
        this.remotes.clear();
        this.chatChannels = transfer.chatChannels ?? [];
        break;
      }

      case Op.SPACE_DIRECTORY:
        this.directory = payload as unknown as SpaceDirectoryDto;
        this.directoryUpdates++;
        break;

      case Op.ERROR:
        this.events.errors.push(payload as unknown as { code: string; message: string });
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3 queries
  // ───────────────────────────────────────────────────────────────────────────

  /** Zone transitions for one zone, in order. */
  zoneEventsFor(zoneId: string): ZoneEventPayload[] {
    return this.zoneEvents.filter((event) => event.zoneId === zoneId);
  }

  /** This bot's entry in someone's audience, or undefined if inaudible. */
  hears(localId: number): AudienceEntryPayload | undefined {
    return this.audience.find((entry) => entry.id === localId);
  }

  private onBatch(data: Buffer): void {
    const entries = decodeTransformBatch(data);
    if (!entries) return;

    this.events.batches++;
    const now = Date.now();

    for (const entry of entries) {
      const remote = this.remotes.get(entry.id);
      if (remote) {
        remote.transform = entry.transform;
        remote.lastBatchAt = now;
      }
      const history = this.observed.get(entry.id);
      if (history) history.push(entry.transform);
      else this.observed.set(entry.id, [entry.transform]);
    }
  }

  private addRemote(participant: ParticipantDto): void {
    this.remotes.set(participant.id, {
      localId: participant.id,
      sessionId: participant.sessionId,
      displayName: participant.displayName,
      transform: participant.transform,
      lastBatchAt: 0,
      appearance: participant.appearance,
      status: participant.status,
      activity: participant.activity,
      identity: participant.identity ?? { kind: 'guest', member: false },
      role: participant.role ?? 'guest',
      moderation: participant.moderation ?? { micMuted: false, cameraDisabled: false },
      blocked: participant.blocked ?? false,
    });
  }

  private sendJson(opcode: number, payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeJsonFrame(opcode, payload));
  }

  // ───────────────────────────────────────────────────────────────────────────

  get localId(): number {
    if (!this.joined) throw new Error(`${this.name} has not joined`);
    return this.joined.localId;
  }

  /** Reset event counters so a scenario can assert only on the phase it cares
   *  about, ignoring the churn of getting into position. */
  resetEvents(): void {
    this.events.adds = 0;
    this.events.removes = 0;
    this.events.batches = 0;
    this.observed.clear();
    this.zoneEvents.length = 0;
    this.forced.length = 0;
    this.audienceUpdates = 0;
    this.emotes.length = 0;
    this.updates.length = 0;
    this.chat.length = 0;
    this.typingFrames.length = 0;
    this.histories.length = 0;
    this.chatRejects.length = 0;
    this.moderationStates.length = 0;
    this.transfers.length = 0;
    this.directoryUpdates = 0;
    this.events.errors.length = 0;
  }

  /** Wait for a frame this bot may never receive — which is the assertion in
   *  every scoping scenario, so the timeout is the *expected* path there. */
  async waitForChat(body: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.received(body)) {
      if (Date.now() > deadline) return false;
      await sleep(25);
    }
    return true;
  }

  private async waitFor<T>(
    read: () => T | null | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== null && value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await sleep(20);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}
