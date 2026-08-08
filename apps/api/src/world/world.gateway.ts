/**
 * The WebSocket gateway.
 *
 * A `ws.Server` is attached directly to Nest's HTTP server rather than going
 * through `@nestjs/platform-ws`. The adapter routes only JSON shaped
 * `{event, data}` to `@SubscribeMessage` handlers — binary frames never reach
 * them (ADR 0003). Since the hot path is packed binary and the handshake needs
 * subprotocol validation, owning the message loop is simpler than working around
 * an adapter that cannot see most of our traffic.
 */

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  COLLAB_PATH,
  Op,
  PROTOCOL_VERSION,
  blockSchema,
  chatHistoryRequestSchema,
  chatReadSchema,
  chatSendSchema,
  decodeJsonFrame,
  decodeTransform,
  emoteSchema,
  isJsonOpcode,
  joinSchema,
  moderateSchema,
  navigateSchema,
  readOpcode,
  reportSchema,
  setAppearanceSchema,
  setStatusSchema,
  typingSchema,
} from '@hubitat/protocol';
import { ChatService } from '../chat/chat.service.js';
import { AccountService } from '../auth/account.service.js';
import { IdentityBridge } from '../auth/identity-bridge.js';
import { RolesService } from '../auth/roles.service.js';
import { SpaceService } from '../auth/space.service.js';
import { MediaService } from '../media/media.service.js';
import { AccessPolicyService } from '../moderation/access-policy.service.js';
import { BlockService } from '../moderation/block.service.js';
import { WorldModerationBridge } from '../moderation/world-moderation.bridge.js';
import { ModerationService } from './moderation.service.js';
import { WorldInstanceService, type AuthenticatedIdentity } from './world-instance.service.js';
import { MapRegistry } from './map-registry.service.js';
import { MapService } from './map.service.js';
import { identityOf, type Connection } from './participant.js';

@Injectable()
export class WorldGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorldGateway.name);
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  /**
   * Socket → connection. The session registry in WorldInstanceService is keyed
   * by session id, which a socket does not have until JOIN — so liveness and
   * rate-limit state hang off the socket itself, from the moment it opens.
   */
  private readonly bySocket = new WeakMap<WebSocket, Connection>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly world: WorldInstanceService,
    private readonly maps: MapService,
    /** Phase 8 — where a Map's geometry and document live, and which Map a
     *  connection is being told to load. */
    private readonly registry: MapRegistry,
    private readonly media: MediaService,
    private readonly chat: ChatService,
    private readonly accounts: AccountService,
    private readonly spaces: SpaceService,
    private readonly bridge: IdentityBridge,
    // ── Phase 7 ───────────────────────────────────────────────────────────────
    private readonly roles: RolesService,
    private readonly access: AccessPolicyService,
    private readonly blocks: BlockService,
    private readonly moderation: ModerationService,
    private readonly moderationBridge: WorldModerationBridge,
  ) {}

  onApplicationBootstrap(): void {
    const config = this.world.runtimeConfig;
    const server = this.adapterHost.httpAdapter.getHttpServer();

    /**
     * Phase 6 — the world lends the auth module three operations and nothing
     * else.
     *
     * Registered here rather than imported the other way round, because
     * `WorldModule` already imports `AuthModule` for token resolution and an
     * import back would be a cycle. See `auth/identity-bridge.ts`.
     */
    this.bridge.register({
      readGuestSession: (resumeToken) => this.world.readGuestSession(resumeToken),
      bindSession: (sessionId, identity) => this.world.bindSession(sessionId, identity),
      refreshAccountSessions: (accountId, identity) =>
        this.world.refreshAccountSessions(accountId, identity),
    });

    /**
     * Phase 7 — the same arrangement one phase later, and for the same reason.
     *
     * `ModerationModule` knows nothing about the world; the moderation
     * *controllers* need four things from it, because `FR-7.10` requires a
     * durable change to have an immediate consequence. A ban issued from the
     * panel has to remove somebody who is standing in the room, and a role
     * change has to reach a client that has the moderation controls on screen.
     */
    this.moderationBridge.register({
      sessionsOf: (identity) =>
        this.world.sessionsOf(identity).map((participant) => ({
          sessionId: participant.sessionId,
          displayName: participant.displayName,
          identity: identityOf(participant),
          accountId: participant.identity.accountId,
          fingerprint: participant.fingerprint,
          ip: participant.ip,
        })),
      connected: () =>
        this.world.connectedParticipants().map((participant) => ({
          sessionId: participant.sessionId,
          displayName: participant.displayName,
          identity: identityOf(participant),
          accountId: participant.identity.accountId,
          fingerprint: participant.fingerprint,
          ip: participant.ip,
        })),
      kick: (sessionId, reason, banned) => {
        // The SFU half is fire-and-forget: an HTTP response must not wait on it,
        // and the world-side removal has already happened either way. The room
        // is read *before* the kick, because the kick removes the instance
        // membership it is derived from (phase 8).
        const instance = this.world.instanceOf(sessionId);
        void this.media.removeFromRoom(
          sessionId,
          instance ? instance.mediaRoom(this.media.room) : this.media.room,
        );
        this.world.kick(sessionId, reason, banned);
      },
      refreshRole: (accountId, role) => this.world.setRole(accountId, role),
      occupancy: () => this.world.stats.connected,
    });

    /**
     * `noServer` and an explicit upgrade route — phase 10.
     *
     * Two WebSocket servers now share this HTTP server: the game protocol here
     * and the CRDT channel at `/collab`. Attaching both with `ws`'s `server`
     * option looks like it works and does not: each one installs its own
     * `upgrade` listener, and a listener whose `path` does not match **destroys
     * the socket**. Whichever booted first would silently kill every connection
     * to the other, which presents as "clients cannot join" with nothing in any
     * log.
     *
     * So this owns the routing, because it is the primary and it boots first: it
     * handles `/ws`, leaves `/collab` for the gateway that wants it, and refuses
     * anything else. `CollabGateway` does the mirror of this and destroys
     * nothing, so exactly one listener answers each upgrade.
     */
    this.wss = new WebSocketServer({
      noServer: true,
      // ws closes with 1009 automatically past this, which is the behaviour
      // specs/protocol/wire-protocol.md requires for oversized frames.
      maxPayload: config.maxMessageBytes,
    });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (request.url ?? '').split('?')[0];
      if (path === COLLAB_PATH) return; // `CollabGateway`'s.
      if (path !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(request, socket, head, (client) => {
        this.wss?.emit('connection', client, request);
      });
    });

    // The upgrade request is the only place the client's address is available —
    // `ws` does not keep it on the socket — and `FR-7.8` needs it as one of the
    // two signals a guest ban can key on. Read here and nowhere else.
    this.wss.on('connection', (socket, request) =>
      this.handleConnection(socket, clientAddress(request)),
    );
    this.startHeartbeat();
    this.world.start();

    this.logger.log(`WebSocket listening on /ws (subprotocol ${PROTOCOL_VERSION})`);
  }

  onApplicationShutdown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.world.stop();
    this.wss?.close();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  private handleConnection(socket: WebSocket, ip: string | null): void {
    const config = this.world.runtimeConfig;

    // A client that offers a subprotocol must offer ours. A client that offers
    // none is accepted — refusing them would break trivial tooling for no gain.
    if (socket.protocol && socket.protocol !== PROTOCOL_VERSION) {
      socket.close(1002, `unsupported protocol; expected ${PROTOCOL_VERSION}`);
      return;
    }

    const connection: Connection = {
      socket,
      sessionId: null,
      joined: false,
      isAlive: true,
      aoi: new Set(),
      rateWindowStart: Date.now(),
      rateCount: 0,
      handshakeTimer: null,
      audienceSignature: '',
      audible: new Set(),
      visible: new Set(),
      ip,
    };
    // Registered before JOIN so the heartbeat covers sockets that open and go
    // quiet, not only joined ones.
    this.bySocket.set(socket, connection);

    // Drop connections that open and never JOIN, so they can't accumulate.
    connection.handshakeTimer = setTimeout(() => {
      if (!connection.joined) socket.close(1008, 'handshake timeout');
    }, config.wsHandshakeTimeoutMs);

    socket.on('pong', () => {
      connection.isAlive = true;
    });

    socket.on('message', (data, isBinary) => {
      try {
        this.handleMessage(connection, data as Buffer, isBinary);
      } catch (error) {
        this.logger.error(`Frame handling failed: ${(error as Error).message}`);
        this.sendError(connection, 'internal', 'internal error', false);
      }
    });

    socket.on('close', () => this.handleClose(connection));
    socket.on('error', (error) => {
      this.logger.warn(`Socket error: ${error.message}`);
    });
  }

  private handleClose(connection: Connection): void {
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    if (!connection.sessionId) return;

    // Retain for the resume window rather than removing outright (FR-1.5). The
    // participant disappears from everyone else immediately either way.
    this.world.markDisconnected(connection.sessionId);
  }

  /**
   * FR-1.6 — stale session detection via native ping/pong.
   *
   * A connection that misses two consecutive pings is terminated. Config
   * validation guarantees STALE_SESSION_TIMEOUT_MS exceeds twice the interval,
   * so a single dropped pong never evicts a healthy session.
   */
  private startHeartbeat(): void {
    const config = this.world.runtimeConfig;

    this.pingTimer = setInterval(() => {
      for (const socket of this.wss?.clients ?? []) {
        const connection = this.connectionFor(socket);
        if (!connection) continue;

        if (!connection.isAlive) {
          socket.terminate();
          continue;
        }
        connection.isAlive = false;
        socket.ping();
      }
    }, config.pingIntervalMs);
  }

  private connectionFor(socket: WebSocket): Connection | undefined {
    return this.bySocket.get(socket);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame dispatch
  // ───────────────────────────────────────────────────────────────────────────

  private handleMessage(connection: Connection, data: Buffer, isBinary: boolean): void {
    if (!this.checkRate(connection)) return;

    const opcode = readOpcode(data);
    if (opcode === null) {
      this.sendError(connection, 'bad-frame', 'empty frame', false);
      return;
    }

    // Only JOIN is accepted before the handshake completes.
    if (!connection.joined && opcode !== Op.JOIN) {
      this.sendError(connection, 'not-joined', 'send JOIN first', false);
      return;
    }

    if (isJsonOpcode(opcode)) {
      const payload = decodeJsonFrame(data);
      if (payload === null) {
        this.sendError(connection, 'bad-frame', 'malformed JSON payload', false);
        return;
      }
      this.handleJsonFrame(connection, opcode, payload);
      return;
    }

    if (!isBinary) {
      this.sendError(connection, 'bad-frame', 'binary opcode sent as text', false);
      return;
    }
    this.handleBinaryFrame(connection, opcode, data);
  }

  private handleBinaryFrame(connection: Connection, opcode: number, data: Buffer): void {
    if (opcode !== Op.TRANSFORM || !connection.sessionId) return;

    const frame = decodeTransform(data);
    if (!frame) {
      this.sendError(connection, 'bad-frame', 'malformed transform', false);
      return;
    }
    this.world.applyTransform(connection.sessionId, frame.transform, frame.flags);
  }

  private handleJsonFrame(connection: Connection, opcode: number, payload: unknown): void {
    switch (opcode) {
      case Op.JOIN:
        // Minting a media token is I/O-shaped (a signing call), so the handshake
        // completes asynchronously. Rejections are caught here rather than
        // escaping as an unhandled rejection that takes the process down.
        void this.handleJoin(connection, payload).catch((error: Error) => {
          this.logger.error(`Join failed: ${error.message}`);
          this.sendError(connection, 'internal', 'could not complete the join', true);
          connection.socket.close(1011, 'join failed');
        });
        return;

      case Op.LEAVE:
        if (connection.sessionId) this.world.leave(connection.sessionId, 'left');
        connection.socket.close(1000, 'left');
        return;

      case Op.SET_STATUS: {
        const parsed = setStatusSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid status', false);
          return;
        }
        this.world.setStatus(connection.sessionId, parsed.data.status);
        return;
      }

      case Op.SET_APPEARANCE: {
        const parsed = setAppearanceSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid appearance', false);
          return;
        }
        this.world.setAppearance(connection.sessionId, parsed.data.appearance);
        return;
      }

      case Op.EMOTE: {
        const parsed = emoteSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid emote', false);
          return;
        }
        // The return value is deliberately discarded. A throttled emote is
        // dropped silently (Phase 4 Rules): it is not an error, and telling a
        // client that leaned on a key about it produces a stream of warnings
        // for behaviour the server already handled correctly.
        this.world.emote(connection.sessionId, parsed.data.emote);
        return;
      }

      // ── Chat (phase 5) ─────────────────────────────────────────────────────
      //
      // All four are validated here and answered by ChatService. A rejected
      // *send* is not answered with `ERROR`: the sender has a message on screen
      // and needs to know which one failed, which is what `CHAT_REJECT` carries
      // (FR-5.8). `ERROR bad-frame` stays for what it has always meant — a frame
      // that did not parse.

      case Op.CHAT_SEND: {
        const parsed = chatSendSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid chat message', false);
          return;
        }
        this.chat.send(connection.sessionId, parsed.data);
        return;
      }

      case Op.TYPING: {
        const parsed = typingSchema.safeParse(payload);
        // Dropped silently, like a throttled emote. A malformed typing frame
        // costs nobody anything, and answering a client that is mid-keystroke
        // with an error is noise about something the server already handled.
        if (!parsed.success || !connection.sessionId) return;
        this.chat.typing(connection.sessionId, parsed.data);
        return;
      }

      case Op.CHAT_HISTORY: {
        const parsed = chatHistoryRequestSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid history request', false);
          return;
        }
        this.chat.requestHistory(connection.sessionId, parsed.data);
        return;
      }

      case Op.CHAT_READ: {
        const parsed = chatReadSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) return;
        this.chat.markRead(connection.sessionId, parsed.data);
        return;
      }

      // ── Moderation (phase 7) ───────────────────────────────────────────────
      //
      // **The three handlers `NFR-34` is about.** Guarding HTTP controllers is
      // routine; the socket carries these too, and an unguarded handler here
      // would be a complete bypass of every role check in the product — the
      // Phase 7 implementation notes name it as the single most likely way this
      // phase ships broken.
      //
      // Nothing is checked in this file. Every one of them goes through
      // `ModerationService`, which asks `hasCapability` and `outranks` from the
      // same matrix `RolesGuard` asks on the HTTP path. A check written here
      // would be a second copy of the rules, which is the failure one refactor
      // away from being two different answers.

      case Op.MODERATE: {
        const parsed = moderateSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid moderation request', false);
          return;
        }
        void this.answer(connection, this.moderation.moderate(connection.sessionId, parsed.data));
        return;
      }

      case Op.BLOCK: {
        const parsed = blockSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid block request', false);
          return;
        }
        void this.answer(connection, this.moderation.block(connection.sessionId, parsed.data));
        return;
      }

      case Op.REPORT: {
        const parsed = reportSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid report', false);
          return;
        }
        void this.answer(connection, this.moderation.report(connection.sessionId, parsed.data));
        return;
      }

      // ── Spaces and maps (phase 8) ──────────────────────────────────────────
      //
      // `NAVIGATE` is answered the same way a moderation frame is: silence on
      // success, because the effect is a whole new world arriving on the socket,
      // and one `ERROR` on refusal, because a "go to" that quietly did nothing
      // is indistinguishable from one that worked. The codes are `map-full` and
      // `map-unavailable` rather than `forbidden`: a room that is full and a room
      // that has been archived need different sentences and different next
      // steps.

      case Op.NAVIGATE: {
        const parsed = navigateSchema.safeParse(payload);
        if (!parsed.success || !connection.sessionId) {
          this.sendError(connection, 'bad-frame', 'invalid navigation request', false);
          return;
        }
        void this.world
          .navigate(connection.sessionId, parsed.data)
          .then((outcome) => {
            if (outcome.ok) return;
            this.sendError(
              connection,
              outcome.code === 'map-full' ? 'map-full' : 'map-unavailable',
              outcome.message ?? 'You cannot go there right now.',
              false,
            );
          })
          .catch((error: Error) => {
            this.logger.error(`Navigation failed: ${error.message}`);
            this.sendError(connection, 'internal', 'That move could not be completed.', false);
          });
        return;
      }

      case Op.DIRECTORY: {
        // No schema check worth doing — the payload is empty by definition, and
        // a client that sent something is asking the same question.
        if (connection.sessionId) this.world.sendDirectory(connection.sessionId);
        return;
      }

      default:
        // Unknown opcodes are ignored, never fatal — that is what lets a newer
        // client talk to an older server.
        this.logger.debug(`Ignoring unknown opcode 0x${opcode.toString(16)}`);
    }
  }

  private async handleJoin(connection: Connection, payload: unknown): Promise<void> {
    if (connection.joined) {
      this.sendError(connection, 'bad-frame', 'already joined', false);
      return;
    }

    const parsed = joinSchema.safeParse(payload);
    if (!parsed.success) {
      this.sendError(connection, 'bad-frame', 'invalid join payload', true);
      connection.socket.close(1008, 'invalid join');
      return;
    }

    // FR-6.18 — resolved BEFORE the connection joins a world. Everything the
    // participant is created with depends on the answer, so there is no window
    // in which they exist as one identity and become another.
    const identity = await this.authenticate(connection, parsed.data.accessToken);
    if (identity === REFUSED) return;

    // FR-7.8, FR-7.11 – FR-7.15 — and *before* the participant exists, for the
    // same reason the identity is resolved first: a refusal has to happen at the
    // door, not to somebody who has already been announced to the room.
    const origin = {
      fingerprint: parsed.data.clientFingerprint ?? null,
      ip: connection.ip,
    };
    const admitted = await this.admit(connection, parsed.data, identity, origin);
    if (!admitted) return;

    const { participant, resumed, instance } = this.world.join(
      connection,
      parsed.data.displayName,
      parsed.data.resumeToken,
      parsed.data.appearance,
      identity ?? undefined,
      origin,
    );

    if (connection.handshakeTimer) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
    }

    // `FR-7.16`, `FR-7.18` — the blocker's durable list, projected onto the
    // people who are here. Loaded before the first tick that could deliver
    // anything, so nobody hears a person they blocked yesterday for the 50 ms it
    // would take a lazy load to arrive.
    const participantIdentity = identityOf(participant);
    await this.blocks.load(participantIdentity);
    this.world.applyBlocks(participant.sessionId, this.blocks.blockedBy(participantIdentity));

    // FR-2.1 — the credentials the client needs to publish. Null when no SFU is
    // configured, which the client renders as "voice unavailable" rather than
    // failing the join.
    //
    // `FR-7.5` — the grant carries the participant's current force-mute state.
    // Without it a muted participant would drop their socket, be issued a fresh
    // token with `canPublish: true`, and be back — a moderation action with a
    // ten-second workaround.
    // Phase 8, `FR-8.10` — the room of the *instance* they landed in, not a
    // Space-wide one. Two copies of a Map are two LiveKit rooms, which is what
    // makes their isolation structural rather than a subscription filter.
    const media = await this.media.grant(
      participant.sessionId,
      participant.displayName,
      participant.moderation,
      instance.mediaRoom(this.media.room),
    );

    // A socket that closed while the token was being signed has nobody to tell.
    if (connection.socket.readyState !== connection.socket.OPEN) return;

    const config = this.world.runtimeConfig;
    const map = this.registry.byId(instance.mapId);
    const instanceCount = this.world.instancesOf(instance.mapId).length;

    this.world.send(connection, Op.JOINED, {
      sessionId: participant.sessionId,
      localId: participant.localId,
      displayName: participant.displayName,
      resumeToken: participant.resumeToken,
      resumeTokenTtlMs: config.resumeTokenTtlMs,
      spawn: participant.transform,
      // Phase 8 — from the Map they actually landed on, rather than from one
      // configured world id. The geometry comes out of the document, which is
      // what says what a Map is made of; a second spelling in configuration
      // would let the two disagree the moment a Map is copied.
      mapUrl: map ? this.registry.geometryUrl(map) : instance.document.geometry.url,
      mapDocumentUrl: map
        ? this.registry.documentUrl(map)
        : `/maps/${encodeURIComponent(instance.mapId)}/document`,
      mapId: instance.mapId,
      mapName: instance.mapName,
      instanceId: instance.id,
      instanceIndex: instance.index,
      instanceLabel: instance.label(instanceCount),
      instanceCount,
      spaceName: this.registry.currentSpace.name,
      avatarModelUrl: this.maps.avatarModelUrl,
      // What they are actually wearing, which is not necessarily what they
      // asked for: a join with no appearance gets one generated, and the
      // customizer has to open on the real thing.
      appearance: participant.appearance,
      tuning: config.clientTuning,
      // FR-5.5 — the channels available right now. Seeded here and revised by
      // PARTICIPANT_UPDATE on every chat-enabled zone crossing; a client that
      // started empty and waited would show no chat at all to somebody who joins
      // and stands still.
      chatChannels: this.chat.channelsFor(participant),
      media,
      resumed,
      // FR-6.18 — stated, not inferred. A client that sent a token which had
      // expired in the meantime must not render an account session on top of a
      // guest one. From phase 7 it also carries the role and the capability list
      // (`FR-7.2`), built by the same function the `IDENTITY` frame uses.
      identity: this.world.identityPayloadFor(participant),
    });

    // FR-1.15 — current state of nearby participants, not just future updates.
    this.world.send(connection, Op.SNAPSHOT, this.world.snapshotFor(participant.sessionId));

    // `FR-7.5` — re-stated on every join, including a resume. A muted
    // participant who reconnects has a microphone that will not turn on, and
    // without this frame nothing on their screen says why.
    if (participant.moderation.micMuted || participant.moderation.cameraDisabled) {
      this.world.sendModerationState(participant);
    }

    // `FR-8.12` — the directory, seeded here rather than waiting up to a second
    // for the first push. A client that opened its map panel immediately and
    // found it empty would conclude the Space had one room.
    this.world.sendDirectory(participant.sessionId);
  }

  /**
   * `FR-7.8`, `FR-7.11`–`FR-7.15` — may this person come in?
   *
   * Split from `authenticate` deliberately. That answers *who somebody is* and
   * can refuse for identity reasons (`guests-not-allowed`, `auth-required`); this
   * answers whether an established identity is admitted, and every refusal here
   * carries a code the entry screen can act on — ask for a password, say the
   * space is full, say when a ban ends.
   *
   * Runs on the **resume path too**, which is the sharp edge the Phase 7 notes
   * name: a banned identity presenting a valid resume token must be refused, and
   * a ban check that lives only in the fresh-join branch is a ban that lasts
   * until the target's client reconnects.
   */
  private async admit(
    connection: Connection,
    join: { resumeToken?: string; spacePassword?: string },
    identity: AuthenticatedIdentity | null,
    origin: { fingerprint: string | null; ip: string | null },
  ): Promise<boolean> {
    const resumable = join.resumeToken ? this.world.resumableSessionOf(join.resumeToken) : null;

    // `FR-7.7` — the short post-kick denylist. Checked before the policy because
    // it is the cheapest of the two and because a kicked client is, by
    // definition, already retrying.
    //
    // Against the identity, not the session: a kicked account that reconnects
    // with a fresh socket and no resume token is the same person, and a
    // per-session denylist would be defeated by the reconnect it exists to slow
    // down.
    // Two keys, and for a guest the second is the one that can match: their
    // identity is scoped to a session that the kick has already destroyed, so
    // the browser fingerprint is what carries across a reconnect. See
    // `WorldInstanceService.kick`.
    const identityKey = identity ? `acct:${identity.accountId}` : (resumable?.identity ?? null);
    const cooled =
      (identityKey !== null && this.world.kickedRecently(identityKey)) ||
      (origin.fingerprint !== null && this.world.kickedRecently(`fp:${origin.fingerprint}`));
    if (cooled) {
      this.sendError(
        connection,
        'forbidden',
        'You were just removed from this space. Wait a few seconds before rejoining.',
        true,
      );
      connection.socket.close(1008, 'kicked');
      return false;
    }

    const refusal = await this.access.evaluate({
      accountId: identity?.accountId ?? null,
      email: identity ? await this.accounts.emailOf(identity.accountId) : null,
      role: identity?.role ?? 'guest',
      fingerprint: origin.fingerprint,
      ip: origin.ip,
      password: join.spacePassword ?? null,
      occupancy: this.world.stats.connected,
      // A resume is somebody who is already counted and already retained.
      // Refusing them on capacity would evict a participant for a dropped
      // packet; every other check still applies, which is the point of running
      // this on the resume path at all.
      resuming: resumable !== null,
    });

    if (!refusal) return true;

    this.sendError(connection, refusal.code, refusal.message, true);
    connection.socket.close(1008, refusal.code);
    return false;
  }

  /**
   * Answer a moderation frame — `FR-7.4`, "attempts are refused".
   *
   * Success is silent: the effect is already visible, as a participant
   * disappearing or a mute badge appearing. A refusal always speaks, because a
   * button that silently does nothing is indistinguishable from one that worked,
   * and that is precisely the outcome the requirement rules out.
   */
  private async answer(
    connection: Connection,
    outcome: Promise<{ ok: boolean; code?: string; message?: string }>,
  ): Promise<void> {
    try {
      const result = await outcome;
      if (result.ok) return;
      this.sendError(
        connection,
        (result.code ?? 'forbidden') as 'forbidden',
        result.message ?? 'That is not allowed.',
        false,
      );
    } catch (error) {
      this.logger.error(`Moderation action failed: ${(error as Error).message}`);
      this.sendError(connection, 'internal', 'That action could not be completed.', false);
    }
  }

  /**
   * `FR-6.6`, `FR-6.8`, `FR-6.18` — who is allowed in, and as what.
   *
   * Three outcomes, and the middle one is the whole point:
   *
   *   an identity — the token resolved; they join as that account.
   *   `null`      — no token, and guests are allowed; the phase 1 path, unchanged.
   *   `REFUSED`   — the connection has already been closed and told why.
   *
   * A token that does not resolve is **refused, never downgraded to a guest**.
   * Somebody who believes they are signed in must not quietly start acting under
   * an identity that disappears when they close the tab — their profile edits,
   * their direct messages and their membership would all land on nothing. The
   * client's answer to `auth-required` is to refresh and retry, which is what
   * makes a fifteen-minute access token survivable across a reconnect.
   */
  private async authenticate(
    connection: Connection,
    accessToken: string | undefined,
  ): Promise<AuthenticatedIdentity | null | typeof REFUSED> {
    if (accessToken) {
      const account = await this.accounts.resolveAccessToken(accessToken);
      if (account) {
        // `FR-7.1` — resolved here rather than carried on the token. An access
        // token lives fifteen minutes; a role baked into one would keep working
        // for fifteen minutes after it was revoked, which makes `FR-7.3`
        // advisory. One indexed lookup on a path that already did several.
        return { ...account, role: await this.roles.roleOf(account.accountId) };
      }

      this.sendError(
        connection,
        'auth-required',
        'Your session has expired. Sign in again to rejoin.',
        true,
      );
      connection.socket.close(1008, 'auth required');
      return REFUSED;
    }

    // FR-6.8 / AC-6.5 — a Space that requires accounts refuses guests with a
    // clear message and an invite path, never a generic denial. The Rules are
    // explicit that this is not the same thing as a rejected credential.
    if (await this.spaces.allowsGuests()) return null;

    this.sendError(
      connection,
      'guests-not-allowed',
      'This space requires an account. Sign in, or open the invite link you were sent.',
      true,
    );
    connection.socket.close(1008, 'guests not allowed');
    return REFUSED;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Limits
  // ───────────────────────────────────────────────────────────────────────────

  /** NFR-32. Applies from phase 1, before any authentication exists. */
  private checkRate(connection: Connection): boolean {
    const config = this.world.runtimeConfig;
    const now = Date.now();

    if (now - connection.rateWindowStart >= 1000) {
      connection.rateWindowStart = now;
      connection.rateCount = 0;
    }

    connection.rateCount++;
    if (connection.rateCount <= config.maxInboundMsgsPerSec) return true;

    // Well past the limit is not a bug on their side any more.
    if (connection.rateCount > config.maxInboundMsgsPerSec * 3) {
      connection.socket.close(1008, 'rate limit exceeded');
    } else if (connection.rateCount === config.maxInboundMsgsPerSec + 1) {
      this.sendError(connection, 'rate-limited', 'too many messages', false);
    }
    return false;
  }

  private sendError(
    connection: Connection,
    code:
      | 'bad-frame'
      | 'not-joined'
      | 'rate-limited'
      | 'internal'
      | 'invalid-resume'
      | 'guests-not-allowed'
      | 'auth-required'
      // ── Phase 7 ────────────────────────────────────────────────────────────
      // Separate codes rather than one refusal, because `AC-7.4` requires
      // "a clear reason" and the recovery differs for every one of them: type a
      // password, wait, ask an admin, or give up.
      | 'forbidden'
      | 'banned'
      | 'space-locked'
      | 'password-required'
      | 'password-incorrect'
      | 'not-allowlisted'
      | 'world-full'
      // ── Phase 8 ────────────────────────────────────────────────────────────
      // Both are about a *room*, not about the connection or the Space, and both
      // are non-fatal: the participant stays exactly where they are. `world-full`
      // above is the Space refusing entry at the door; `map-full` is somebody
      // already inside who cannot get into that room.
      | 'map-full'
      | 'map-unavailable',
    message: string,
    fatal: boolean,
  ): void {
    this.world.send(connection, Op.ERROR, { code, message, fatal });
  }
}

/** A join that has already been answered and closed. Distinct from `null`,
 *  which means "no account, and that is fine". */
const REFUSED = Symbol('refused');

/**
 * The client's address at the WebSocket upgrade — phase 7, `FR-7.8`.
 *
 * `x-forwarded-for` first, because the deployment target is Compose behind a
 * proxy where `socket.remoteAddress` is the proxy. Only the **first** entry is
 * taken: the header is a client-appendable list, and reading the last one lets
 * anybody choose which address a ban is issued against.
 *
 * That still trusts whatever sits directly in front of this process, which is
 * the same trust `app.set('trust proxy', 1)` already places for the refresh
 * cookie's `Secure` attribute. A ban is only as good as its weakest signal, and
 * for a guest that is documented as weak in any case.
 */
function clientAddress(request: {
  headers: Record<string, unknown>;
  socket: { remoteAddress?: string };
}): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof header === 'string' && header.trim()) {
    return header.split(',')[0]?.trim() ?? null;
  }
  return request.socket.remoteAddress ?? null;
}
