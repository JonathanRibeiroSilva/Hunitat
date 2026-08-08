/**
 * ChatService — phase 5.
 *
 * Everything about who receives a message, in what order, and whether it is
 * remembered. Four scopes, one delivery path.
 *
 * ── The rule that shapes this file ──────────────────────────────────────────
 *
 *   > Proximity/zone recipient resolution must match the same ranges/zones used
 *   > by media so behavior is consistent.
 *
 * So there is **no distance check in this file**. `nearby` recipients come from
 * `resolveNearbyRecipients`, which delegates to the same `resolveAudience` that
 * decides who can hear whom, and `zone` recipients come from the occupancy the
 * tick already computed. Chat cannot drift from media because chat does not know
 * how to measure a distance.
 *
 * ── Four things that are easy to get subtly wrong ───────────────────────────
 *
 * 1. **Recipients are resolved once, at send time** (`FR-5.9`). Delivery is a
 *    snapshot, never a subscription: walking away afterwards does not retract a
 *    message that has already arrived.
 * 2. **Mentions are resolved after scoping, not before** (`FR-5.15` + Rules).
 *    Resolving first and filtering after is how an `@name` tells somebody out of
 *    range that a message about them exists.
 * 3. **Ephemeral means ephemeral** (`FR-5.13`). `nearby` and `zone` never reach
 *    the history store, and are not logged either — a log file is persistence.
 * 4. **Ordering is the server's**, per channel, under concurrent sends
 *    (`FR-5.7`). Sends are serialised per channel below, so the order messages
 *    are numbered in is the order they go out in.
 */

import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  NEARBY_CHANNEL_ID,
  Op,
  ROOM_CHANNEL_ID,
  directChannelId,
  directConversationKey,
  parseChannelId,
  resolveMentions,
  roomChannelKey,
  scopePersists,
  zoneChannelId,
  type ChatChannelDto,
  type ChatHistoryRequestPayload,
  type ChatMentionDto,
  type ChatMessagePayload,
  type ChatReadPayload,
  type ChatScope,
  type ChatSendPayload,
  type TypingPayload,
  type Zone,
} from '@hubitat/protocol';
import {
  resolveNearbyRecipients,
  symmetricBlocks,
  type ChatAudienceConfig,
} from '@hubitat/world-core';
import type { RuntimeConfig } from '../config/tuning.config.js';
import { BlockService } from '../moderation/block.service.js';
import { WorldInstanceService } from '../world/world-instance.service.js';
import { identityOf, type Participant } from '../world/participant.js';
import { CHAT_HISTORY_STORE, type ChatHistoryStore } from './chat-history.store.js';

/** How often the retention window is swept (`FR-5.11`). Hourly: the window is
 *  measured in days, and a sweep that runs on the tick would be absurd. */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Repeated identical typing frames closer together than this are dropped.
 *
 * A courtesy throttle, not a security boundary — `MAX_INBOUND_MSGS_PER_SEC`
 * already protects the socket. This protects the *room*: a client that reports
 * on every keystroke would otherwise fan a frame out to every neighbour sixty
 * times a second to say something that has not changed.
 */
const TYPING_MIN_INTERVAL_MS = 1_000;

interface Resolution {
  scope: ChatScope;
  /** The wire channel id from the **sender's** point of view. */
  channelId: string;
  /** Storage key, for persistent scopes only. */
  channelKey?: string;
  recipients: Participant[];
  zoneId?: string;
  /** `direct` only. */
  peer?: Participant;
  /**
   * `FR-7.16` — a direct message between two people where one has blocked the
   * other.
   *
   * Not a refusal, and that is the design. The Phase 7 Rules require a block to
   * stop harassment "while not falsely implying the blocker is offline", and
   * `recipient-gone` would imply exactly that — as would any refusal, since a
   * refusal that only happens for blocked senders *is* a disclosure. So the send
   * succeeds from the sender's side, reaches nobody, and is never written down.
   *
   * The storage part matters as much as the delivery part: a stored message
   * would arrive the next time the blocked party scrolled their history, which
   * is the block failing on a delay.
   */
  suppressed?: true;
}

type RejectCode = 'rate-limited' | 'channel-unavailable' | 'recipient-gone' | 'bad-frame';

class ChatRefusal extends Error {
  constructor(
    readonly code: RejectCode,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class ChatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatService.name);
  private readonly config: RuntimeConfig;
  private readonly audienceConfig: ChatAudienceConfig;

  /**
   * Sequence counters for ephemeral channels (`nearby`, `zone`).
   *
   * In memory, per channel, and never written anywhere — the ordering guarantee
   * of `FR-5.7` applies to channels that keep nothing just as much as to ones
   * that do. Persistent channels get theirs from the store instead.
   */
  private readonly ephemeralSeq = new Map<string, number>();

  /**
   * One promise chain per channel, so concurrent sends are numbered and
   * delivered in the same order.
   *
   * Without it, two sends to `room` would both await the store and could be
   * written out in the opposite order to the sequence numbers they were given —
   * a client sorting by `seq` would still be right, and a client appending as
   * frames arrive would show them swapped. Serialising here means both clients
   * are right.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribeZones: (() => void) | null = null;

  /**
   * `FR-7.16` — the symmetric block rule, in session-id terms.
   *
   * Built once and handed to `resolveNearbyRecipients`, which passes it straight
   * into `resolveAudience`. The same helper the world tick uses, so a block
   * silences a voice and a `nearby` message at exactly the same threshold — the
   * Phase 5 consistency rule, extended to a Phase 7 input without either side
   * knowing about the other.
   */
  private readonly blockLookup = symmetricBlocks((sessionId) => {
    const participant = this.world.getParticipant(sessionId);
    return participant ? this.blocks.blockedBy(identityOf(participant)) : undefined;
  });

  constructor(
    private readonly world: WorldInstanceService,
    @Inject(CHAT_HISTORY_STORE) private readonly history: ChatHistoryStore,
    /** Phase 7, `FR-7.16` — chat is half of what a block stops. */
    private readonly blocks: BlockService,
  ) {
    this.config = this.world.runtimeConfig;
    this.audienceConfig = {
      nearbyRadiusM: this.config.chatNearbyRadiusM,
      refDistanceM: this.config.audioRefDistanceM,
      rolloffFactor: this.config.audioRolloffFactor,
      spotlightGain: this.config.spotlightGain,
      privateZoneGain: this.config.privateZoneGain,
    };
  }

  onApplicationBootstrap(): void {
    this.logger.log(
      `Chat ready — nearby radius ${this.config.chatNearbyRadiusM} m, history ${this.history.kind}`,
    );

    // FR-5.5, through the FR-3.17 bus rather than through a per-tick comparison.
    // Zone enter/exit is *exactly* when the available channel set changes, and
    // that stream exists precisely so other systems can consume it — this is the
    // second subscriber, after the ZONE_EVENT frame itself.
    this.unsubscribeZones = this.world.onZoneEvent((event) => {
      const participant = this.world.getParticipant(event.sessionId);
      if (!participant) return;
      if (!this.chatEnabledZones(participant).some((zone) => zone.id === event.zoneId)) return;
      this.advertiseChannels(event.sessionId);
    });

    /**
     * Phase 8, `FR-8.6` — `MAP_TRANSFER` carries the destination's channels.
     *
     * Registered rather than imported, like `IdentityBridge` and
     * `WorldModerationBridge`: this service depends on the world, so the world
     * cannot depend on it. A zone channel belongs to the Map that authored the
     * zone, so none of the old ones survive a move, and computing the new set in
     * the world service would be a second implementation of `channelsFor`.
     */
    this.world.provideChatChannels((participant) => this.channelsFor(participant));

    this.sweepTimer = setInterval(() => void this.sweep(), RETENTION_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    void this.sweep();
  }

  onApplicationShutdown(): void {
    this.unsubscribeZones?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    void this.history.close();
  }

  /**
   * Tell one participant which channels they now have — `FR-5.5`.
   *
   * Sent **only to them**, unlike every other `PARTICIPANT_UPDATE` field. The
   * set names the chat-enabled zone somebody is standing in, and broadcasting
   * that to observers would publish a position the area of interest exists to
   * keep private. Same restriction, and the same reason, as `ZONE_EVENT`.
   */
  advertiseChannels(sessionId: string): void {
    const participant = this.world.getParticipant(sessionId);
    const connection = this.world.getConnection(sessionId);
    if (!participant || !connection) return;

    this.world.send(connection, Op.PARTICIPANT_UPDATE, {
      id: participant.localId,
      chatChannels: this.channelsFor(participant),
    });
  }

  /** Surfaced on `/health`: "where did my history go" is one request to answer
   *  rather than a guess about how the server was configured. */
  get historyKind(): string {
    return this.history.kind;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-5.5 — which channels a participant currently has
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The channel set for one participant, right now.
   *
   * `room` and `nearby` always; a `zone` channel for every chat-enabled zone
   * they are standing in. Computed from the occupancy the tick already settled,
   * so the channel a person can type in and the people who can hear them speak
   * are decided by one number.
   */
  channelsFor(participant: Participant): ChatChannelDto[] {
    const channels: ChatChannelDto[] = [
      { id: ROOM_CHANNEL_ID, scope: 'room', label: 'Room', persistent: true },
      {
        id: NEARBY_CHANNEL_ID,
        scope: 'nearby',
        label: 'Nearby',
        persistent: false,
      },
    ];

    for (const zone of this.chatEnabledZones(participant)) {
      if (!participant.zones.has(zone.id)) continue;
      channels.push({
        id: zoneChannelId(zone.id),
        scope: 'zone',
        label: zoneLabel(zone),
        persistent: false,
        zoneId: zone.id,
      });
    }

    return channels;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-5.1 – FR-5.9 — sending
  // ───────────────────────────────────────────────────────────────────────────

  send(sessionId: string, payload: ChatSendPayload): void {
    const sender = this.world.getParticipant(sessionId);
    if (!sender) return;

    let resolution: Resolution;
    try {
      this.enforceRateLimit(sender);
      resolution = this.resolve(sender, payload.scope, payload.targetId);
    } catch (error) {
      this.reject(sender, payload, error);
      return;
    }

    // Serialised per channel: numbering and delivery share one order (FR-5.7).
    this.enqueue(resolution.channelKey ?? resolution.channelId, () =>
      this.deliver(sender, payload, resolution),
    );
  }

  private async deliver(
    sender: Participant,
    payload: ChatSendPayload,
    resolution: Resolution,
  ): Promise<void> {
    const at = Date.now();

    // FR-5.15 and the Rules: resolved against the ALREADY-RESOLVED recipient
    // set. Never the roster — that ordering is how a mention leaks the existence
    // of a message to somebody out of range.
    const mentions: ChatMentionDto[] = resolveMentions(
      payload.body,
      resolution.recipients.map((recipient) => ({
        id: recipient.localId,
        sessionId: recipient.sessionId,
        name: recipient.displayName,
      })),
    ).map((mention) => ({
      id: mention.id,
      sessionId: mention.sessionId,
      name: mention.name,
    }));

    const id = randomUUID();
    let seq: number;

    // `!resolution.suppressed` is `FR-7.16`, and the storage half matters as
    // much as the delivery half: a suppressed direct message that was still
    // written down would arrive the next time the blocked party scrolled their
    // history, which is the block failing on a delay.
    if (resolution.channelKey && !resolution.suppressed) {
      // FR-5.11 — room and direct are retained, and the store assigns the order.
      //
      // FR-6.11 — the authorship column holds the *durable* identity from phase
      // 6: `acct:<id>` for a signed-in sender, `guest:<session>` otherwise. The
      // column did not change shape, as the Phase 5 note promised; what goes in
      // it did. That is what makes yesterday's room history still attributable
      // to a person who has reconnected under three session ids since.
      seq = await this.history.append({
        id,
        channelKey: resolution.channelKey,
        scope: resolution.scope,
        senderSessionId: this.world.identityOf(sender),
        senderName: sender.displayName,
        body: payload.body,
        at,
        mentions,
      });
    } else {
      // FR-5.13 — nearby and zone are delivered and forgotten. Nothing below
      // this line writes them anywhere, including the log.
      seq = (this.ephemeralSeq.get(resolution.channelId) ?? 0) + 1;
      this.ephemeralSeq.set(resolution.channelId, seq);
    }

    const base = {
      id,
      scope: resolution.scope,
      seq,
      senderId: sender.localId,
      senderSessionId: sender.sessionId,
      senderName: sender.displayName,
      body: payload.body,
      at,
      mentions,
      ...(resolution.zoneId ? { zoneId: resolution.zoneId } : {}),
    };

    for (const recipient of resolution.recipients) {
      const connection = this.world.getConnection(recipient.sessionId);
      if (!connection) continue;
      const message: ChatMessagePayload = {
        ...base,
        // A direct channel is named from the reader's side, so each participant
        // files the thread under the person they are talking to rather than
        // under themselves.
        channelId:
          resolution.scope === 'direct' ? directChannelId(sender.sessionId) : resolution.channelId,
      };
      this.world.send(connection, Op.CHAT_MESSAGE, message);
    }

    // FR-5.8 — the sender's own copy, carrying the temporary id so the client
    // reconciles the message it already drew instead of drawing a second one.
    // Sent unconditionally: an author is not a recipient (a room of one still
    // sees what they said), and for `nearby` they might not be able to hear
    // themselves at all.
    const own = this.world.getConnection(sender.sessionId);
    if (own) {
      this.world.send(own, Op.CHAT_MESSAGE, {
        ...base,
        channelId: resolution.channelId,
        ...(payload.tempId ? { tempId: payload.tempId } : {}),
      } satisfies ChatMessagePayload);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-5.10 — typing
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Forwarded, never stored — at any layer, including this one.
   *
   * The server holds no typing state at all. The receiving client expires the
   * indicator from `expiresInMs`, which is `TYPING_INDICATOR_TTL_MS` as the
   * server knows it: the indicator has to clear even when the "stopped" frame is
   * lost, and a client timing it from its own stale constant leaves somebody
   * shown as typing forever.
   */
  typing(sessionId: string, payload: TypingPayload): void {
    const sender = this.world.getParticipant(sessionId);
    if (!sender) return;

    const now = Date.now();
    const key = `${payload.scope}:${payload.targetId ?? ''}:${payload.typing ? 1 : 0}`;
    if (sender.lastTypingKey === key && now - sender.lastTypingAt < TYPING_MIN_INTERVAL_MS) {
      return;
    }
    sender.lastTypingKey = key;
    sender.lastTypingAt = now;

    let resolution: Resolution;
    try {
      resolution = this.resolve(sender, payload.scope, payload.targetId);
    } catch {
      // A typing frame for a channel that is no longer available is not worth an
      // error: the participant has walked out of a zone mid-sentence, which is
      // ordinary, and the indicator times out on its own.
      return;
    }

    for (const recipient of resolution.recipients) {
      const connection = this.world.getConnection(recipient.sessionId);
      if (!connection) continue;
      this.world.send(connection, Op.TYPING_STATE, {
        channelId:
          resolution.scope === 'direct' ? directChannelId(sender.sessionId) : resolution.channelId,
        scope: resolution.scope,
        id: sender.localId,
        sessionId: sender.sessionId,
        displayName: sender.displayName,
        typing: payload.typing,
        expiresInMs: this.config.typingIndicatorTtlMs,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-5.12, FR-5.16 — history and read state
  // ───────────────────────────────────────────────────────────────────────────

  requestHistory(sessionId: string, payload: ChatHistoryRequestPayload): void {
    const reader = this.world.getParticipant(sessionId);
    const connection = this.world.getConnection(sessionId);
    if (!reader || !connection) return;

    const parsed = parseChannelId(payload.channelId);
    if (!parsed) {
      this.world.send(connection, Op.ERROR, {
        code: 'bad-frame',
        message: `unknown channel "${payload.channelId}"`,
        fatal: false,
      });
      return;
    }

    const channelKey = this.storageKeyFor(reader, parsed.scope, parsed.targetId);

    // AC-5.4 — an ephemeral channel shows none after the fact. Empty and
    // complete is the honest answer, not an error: the channel exists, it simply
    // remembers nothing.
    if (!channelKey) {
      this.world.send(connection, Op.CHAT_HISTORY_RESULT, {
        channelId: payload.channelId,
        scope: parsed.scope,
        messages: [],
        complete: true,
        lastReadSeq: 0,
      });
      return;
    }

    const limit = Math.min(
      payload.limit ?? this.config.chatHistoryLimit,
      this.config.chatHistoryLimit,
    );

    void (async () => {
      try {
        const [page, lastReadSeq] = await Promise.all([
          this.history.page(channelKey, {
            limit,
            ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
          }),
          // FR-6.11 — read state keys off the durable identity, so an account's
          // unread markers survive a reconnect instead of resetting with the
          // session id they were written under.
          this.history.lastRead(this.world.identityOf(reader), channelKey),
        ]);

        const live = this.world.getConnection(sessionId);
        if (!live) return;

        this.world.send(live, Op.CHAT_HISTORY_RESULT, {
          channelId: payload.channelId,
          scope: parsed.scope,
          messages: page.messages.map((message) => ({
            id: message.id,
            channelId: payload.channelId,
            scope: message.scope,
            seq: message.seq,
            // A sender who has left has no local id any more. 0 is not a valid
            // participant index (ids are allocated from 1), so it reads as
            // "nobody present" rather than as somebody else.
            //
            // Looked up by durable identity from phase 6, which is what makes an
            // account holder who reconnected under a new session id resolve to
            // the person standing in the room rather than to nobody.
            senderId: this.world.participantByIdentity(message.senderSessionId)?.localId ?? 0,
            senderSessionId: message.senderSessionId,
            senderName: message.senderName,
            body: message.body,
            at: message.at,
            mentions: message.mentions,
          })),
          complete: page.complete,
          lastReadSeq,
        });
      } catch (error) {
        this.logger.error(`History for ${payload.channelId} failed: ${(error as Error).message}`);
      }
    })();
  }

  markRead(sessionId: string, payload: ChatReadPayload): void {
    const reader = this.world.getParticipant(sessionId);
    if (!reader) return;

    const parsed = parseChannelId(payload.channelId);
    if (!parsed) return;

    const channelKey = this.storageKeyFor(reader, parsed.scope, parsed.targetId);
    // Ephemeral channels keep no marker, because there is nothing for one to
    // point into. Unread for those is the client's own count of what arrived
    // while it was looking elsewhere, which is all it can be.
    if (!channelKey) return;

    void this.history
      .markRead(this.world.identityOf(reader), channelKey, payload.seq)
      .catch((error: Error) => this.logger.warn(`markRead failed: ${error.message}`));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Resolution
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Who receives a message in this scope, decided once (`FR-5.9`).
   *
   * Throws `ChatRefusal` rather than returning an empty set: "nobody is in
   * range" and "that channel is not available to you" are different answers, and
   * only the second one is worth telling the sender about.
   */
  private resolve(sender: Participant, scope: ChatScope, targetId?: string): Resolution {
    // `FR-8.10` — the instance the sender is standing in, and the candidate set
    // for every scope below. Phase 5 could ask the world for "everybody",
    // because there was one; a room message that reached every copy of a Map
    // would be the one channel through which two instances could hear each
    // other, and it would be the *retained* one.
    const instance = this.world.instanceOf(sender.sessionId);
    const here = instance
      ? this.world.connectedParticipants(instance).filter((p) => p !== sender)
      : [];

    switch (scope) {
      case 'room':
        // FR-5.1 — everyone in the instance, from the in-memory registry, minus
        // anybody either side has blocked (`FR-7.16`).
        return {
          scope,
          channelId: ROOM_CHANNEL_ID,
          // `FR-8.10` and `FR-5.11` pull in different directions here, and the
          // split is deliberate: delivery is per *instance*, storage is per
          // *Map*. An instance is a capacity mechanism that gets reaped after two
          // minutes of emptiness, and keying retained history to it would mean
          // walking into a busy room and finding it had never been spoken in.
          // See `roomChannelKey`.
          channelKey: roomChannelKey(instance?.mapId ?? 'unknown'),
          recipients: this.unblocked(sender, here),
        };

      case 'nearby': {
        // FR-5.2 — resolveAudience at CHAT_NEARBY_RADIUS_M. No distance maths
        // here, deliberately: see the header.
        //
        // The block lookup goes *into* that call rather than being applied to
        // its result, which is `FR-7.16` implemented the way the Phase 7 notes
        // ask for — one more input to the function phases 2, 3 and 5 already
        // use. It is also why "people my local chat reaches" and "people I can
        // hear" still agree once blocks exist: both answers come from one
        // function with one set of inputs.
        const reached = new Set(
          resolveNearbyRecipients(
            this.world.audienceViewOf(sender),
            here.map((participant) => this.world.audienceViewOf(participant)),
            this.audienceConfig,
            this.blockLookup,
          ),
        );
        return {
          scope,
          channelId: NEARBY_CHANNEL_ID,
          recipients: here.filter((participant) => reached.has(participant.sessionId)),
        };
      }

      case 'zone': {
        // FR-5.3 — co-occupants of a chat-enabled zone, from the occupancy the
        // tick settled. Not a second point-in-volume test.
        const zone = this.chatEnabledZones(sender).find((candidate) => candidate.id === targetId);
        if (!zone || !sender.zones.has(zone.id)) {
          throw new ChatRefusal(
            'channel-unavailable',
            targetId
              ? `You are not in the "${targetId}" zone any more.`
              : 'No zone channel was named.',
          );
        }
        return {
          scope,
          channelId: zoneChannelId(zone.id),
          zoneId: zone.id,
          // From `here`, so two people standing in the same authored zone in two
          // different copies of the same Map are still two conversations. Zone
          // ids are shared by every instance of a Map — they come from one
          // document — so filtering on occupancy alone would join them.
          recipients: this.unblocked(
            sender,
            here.filter((participant) => participant.zones.has(zone.id)),
          ),
        };
      }

      case 'direct': {
        // FR-5.4. Until Phase 6 the target is a session id, which disappears
        // when they leave — durable DMs need a durable identity (Phase 5 Rules).
        //
        // Resolved Space-wide rather than within the instance, and that is the
        // one scope phase 8 deliberately does *not* narrow. A direct message is
        // person-to-person and has never been spatial: `FR-8.12`'s directory
        // shows colleagues in other Maps by name, and a product that lists
        // somebody and then refuses to let you write to them would be answering
        // a question nobody asked. `FR-8.10`'s isolation is about seeing and
        // hearing a room, not about being unreachable.
        const peer = targetId ? this.world.getParticipant(targetId) : undefined;
        if (!peer || !this.world.getConnection(peer.sessionId)) {
          throw new ChatRefusal('recipient-gone', 'That person is no longer in this space.');
        }
        if (peer === sender) {
          throw new ChatRefusal('bad-frame', 'You cannot send a direct message to yourself.');
        }
        const blocked = this.blocks.isBlockedEitherWay(
          this.world.identityOf(sender),
          this.world.identityOf(peer),
        );
        return {
          scope,
          // The wire id still names a *session*: that is what the client has,
          // and delivery is to a live socket either way.
          channelId: directChannelId(peer.sessionId),
          // FR-6.11 — the storage key is built from durable identities, so a
          // conversation between two accounts is one row set no matter how many
          // times either side reconnects. Between guests it is still
          // session-scoped, which is the Phase 5 limitation and is inherent:
          // there is nothing durable to key on.
          channelKey: directConversationKey(
            this.world.identityOf(sender),
            this.world.identityOf(peer),
          ),
          // `FR-7.16` — delivered to nobody and never stored when either side
          // has blocked the other. Deliberately not a `CHAT_REJECT`: a refusal
          // that only happens for blocked senders is a disclosure, and the Rules
          // require a block not to imply the blocker is offline.
          recipients: blocked ? [] : [peer],
          ...(blocked ? { suppressed: true as const } : {}),
          peer,
        };
      }
    }
  }

  /**
   * `FR-7.16` — drop anybody either side has blocked.
   *
   * Symmetric, through the same `world-core` helper the audience path uses, so
   * "who hears my voice" and "who receives my message" cannot disagree about
   * what a block means. Applied to `room`, `zone` and `direct`; `nearby` gets it
   * from inside `resolveAudience` instead, which is one function rather than two
   * answers.
   */
  private unblocked(sender: Participant, recipients: Participant[]): Participant[] {
    const senderIdentity = identityOf(sender);
    return recipients.filter(
      (recipient) => !this.blocks.isBlockedEitherWay(senderIdentity, identityOf(recipient)),
    );
  }

  /**
   * The storage key for a channel, or null when the channel keeps nothing.
   *
   * Null is the single gate every persistence path runs through, which is what
   * makes `FR-5.13` structural: an ephemeral scope has no key, so there is
   * nothing to append to, page from, or mark read.
   */
  private storageKeyFor(reader: Participant, scope: ChatScope, targetId?: string): string | null {
    if (!scopePersists(scope)) return null;
    if (scope === 'room') {
      // Phase 8 — the Map the reader is standing in, which is what `resolve`
      // wrote under. Scrolling back in the atrium must not produce the meeting
      // room's conversation, and there is no id on the wire to key it from: the
      // channel is called `room` from every Map, deliberately, so that a stored
      // read marker survives walking between them.
      const instance = this.world.instanceOf(reader.sessionId);
      return instance ? roomChannelKey(instance.mapId) : null;
    }
    if (scope === 'direct' && targetId) {
      // `targetId` is a session id off the wire. It has to become the peer's
      // durable identity to match what `resolve` wrote (FR-6.11), and a peer who
      // has left cannot be resolved — so their thread reads as empty rather than
      // as somebody else's. That is the honest answer while direct channels are
      // addressed by session; making an offline account addressable is a
      // presence-directory problem, which is Phase 8's `DC-8.5`.
      const peer = this.world.getParticipant(targetId);
      if (!peer) return null;

      // Derived from the reader, so a request can only ever name a conversation
      // the requester is part of. Entitlement by construction rather than by a
      // check somebody could forget to write.
      return directConversationKey(this.world.identityOf(reader), this.world.identityOf(peer));
    }
    return null;
  }

  /**
   * The chat-enabled zones of the Map this participant is standing in.
   *
   * Per participant from phase 8, because "the map" is no longer a thing this
   * service can ask for. Read through the world rather than from a catalogue, so
   * the zones a channel is offered for are the ones the instance was allocated
   * with — an instance keeps the document it started with, and a Map edited
   * while somebody is standing in it must not change the channels under them.
   */
  private chatEnabledZones(participant: Participant): readonly Zone[] {
    return this.world.zonesOf(participant).filter((zone) => zone.properties.chatEnabled === true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Limits
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `CHAT_RATE_LIMIT_PER_MIN`, on the participant rather than the connection.
   *
   * Same placement and the same reason as the emote throttle: a reconnect
   * rebinds the socket and keeps the person, so hanging the window off the
   * connection would hand a flooder a clean slate for the cost of a reload.
   */
  private enforceRateLimit(sender: Participant): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    sender.chatSendTimes = sender.chatSendTimes.filter((time) => time > cutoff);

    if (sender.chatSendTimes.length >= this.config.chatRateLimitPerMin) {
      throw new ChatRefusal(
        'rate-limited',
        `You can send ${this.config.chatRateLimitPerMin} messages a minute. Wait a moment.`,
      );
    }
    sender.chatSendTimes.push(now);
  }

  /**
   * `FR-5.8`, the failure half — never silent.
   *
   * The sender has an optimistic message on screen. Leaving it there looking
   * delivered is the outcome the requirement exists to prevent, so a refusal
   * always names the `tempId` it applies to.
   */
  private reject(sender: Participant, payload: ChatSendPayload, error: unknown): void {
    const connection = this.world.getConnection(sender.sessionId);
    if (!connection) return;

    const refusal =
      error instanceof ChatRefusal
        ? error
        : new ChatRefusal('bad-frame', 'That message could not be sent.');

    if (!(error instanceof ChatRefusal)) {
      this.logger.error(`Chat send failed: ${(error as Error).message}`);
    }

    this.world.send(connection, Op.CHAT_REJECT, {
      ...(payload.tempId ? { tempId: payload.tempId } : {}),
      code: refusal.code,
      message: refusal.message,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Chain onto whatever is already in flight for this channel, and never let a
   *  failed send wedge the channel for everyone after it. */
  private enqueue(channel: string, task: () => Promise<void>): void {
    const previous = this.chains.get(channel) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error: Error) => this.logger.error(`Chat delivery failed: ${error.message}`));

    this.chains.set(channel, next);
    // Drop the entry once it is the last one, so a world with thousands of
    // direct conversations does not accumulate a promise per pair forever.
    void next.then(() => {
      if (this.chains.get(channel) === next) this.chains.delete(channel);
    });
  }

  private async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.chatHistoryRetentionDays * 86_400_000);
    try {
      const removed = await this.history.prune(cutoff);
      if (removed > 0) {
        this.logger.log(
          `Pruned ${removed} message(s) older than ${this.config.chatHistoryRetentionDays} days.`,
        );
      }
    } catch (error) {
      this.logger.warn(`Retention sweep failed: ${(error as Error).message}`);
    }
  }
}

/**
 * A zone id is an authoring handle, not display copy.
 *
 * `huddle-meeting` becomes "Huddle Meeting". Crude, and better than showing a
 * slug on a tab — the Map Document has no name field for zones, and inventing
 * one here would mean editing a schema three phases depend on for a label.
 * Phase 9's editor is where zones get authored names.
 */
function zoneLabel(zone: Zone): string {
  return zone.id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
