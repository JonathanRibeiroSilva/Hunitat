/**
 * `DC-10.3` — the shared-object socket (`FR-10.11`–`FR-10.14`, `FR-10.16`).
 *
 * ── Why a CRDT, and why that answers three requirements at once ─────────────
 *
 * `FR-10.12` (concurrent edits converge), `FR-10.13` (a late joiner sees current
 * state) and the Rules' clause about out-of-order updates describe a
 * distributed-systems problem with a small set of correct answers. Two people
 * drawing on a whiteboard at once, one on a slow link, must end with identical
 * results: a last-write-wins field silently loses strokes, and locking the
 * object makes collaboration feel broken.
 *
 * Yjs (ADR 0012) makes all three **properties of the data structure** rather
 * than logic written here and argued about:
 *
 *   convergence under concurrent and reordered updates is what a CRDT *is*;
 *   state-vector sync delivers exactly the updates a joiner lacks;
 *   and `FR-10.17` — closing never corrupts state for others — is inherent,
 *   because there is no state on a connection to corrupt.
 *
 * ── Why it is on this server ────────────────────────────────────────────────
 *
 * The Yjs sync protocol runs over `ws`, which is what the game protocol already
 * is (ADR 0003), so it mounts at `/collab` on the **same** HTTP server and
 * inherits the process, the origin and the handshake. A second service would
 * have needed its own authentication, and `FR-10.14` — updates scoped to
 * participants who are actually there — is only answerable by something that can
 * see the world.
 *
 * Two synchronization mechanisms now coexist and must not be unified (sharp edge
 * nº3): the game protocol optimises for speed and tolerates loss, this optimises
 * for convergence and tolerates latency.
 *
 * ── The sync protocol, implemented rather than imported ─────────────────────
 *
 * `y-websocket`'s bundled server is a standalone process with its own
 * persistence adapter and no notion of who is asking. What is used here is the
 * *protocol* — `y-protocols/sync` and `y-protocols/awareness`, the same modules
 * its client uses — with the connection policy written against this world. That
 * is thirty lines and it is the thirty lines `FR-10.14` lives in.
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
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { COLLAB_PATH, parseCollabRoom } from '@hubitat/protocol';
import { ObjectStateService } from './object-state.service.js';
import { WorldInstanceService } from './world-instance.service.js';

/** The two message types the Yjs WebSocket protocol defines. Numbers rather
 *  than an enum because they are the wire format, shared with `y-websocket`'s
 *  client — inventing our own would be a protocol nobody else speaks. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/**
 * One shared object, live in memory.
 *
 * Held for as long as anybody is connected and dropped when the last person
 * leaves — the same shape as a Map Instance, and for the same reason: with one
 * process the in-memory copy is the truth, and there is nothing to coordinate.
 */
interface CollabRoom {
  readonly key: string;
  readonly mapId: string;
  readonly objectId: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly sockets: Set<WebSocket>;
  contentType: string;
  /** Set when the document has changed since it was last written down. */
  dirty: boolean;
  persist: boolean;
}

@Injectable()
export class CollabGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CollabGateway.name);
  private wss: WebSocketServer | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly rooms = new Map<string, CollabRoom>();
  private readonly roomOf = new WeakMap<WebSocket, CollabRoom>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly world: WorldInstanceService,
    private readonly states: ObjectStateService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getHttpServer();

    /**
     * `noServer`, and the mirror of `WorldGateway`'s routing.
     *
     * Two WebSocket servers on one HTTP server cannot both use `ws`'s `server`
     * option: each installs an `upgrade` listener that **destroys** a socket
     * whose path it does not recognise, so whichever booted first would silently
     * kill every connection to the other. `WorldGateway` owns the refusal for
     * unknown paths; this one only ever claims its own and destroys nothing.
     */
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (request.url ?? '').split('?')[0];
      if (path !== COLLAB_PATH) return;
      this.wss?.handleUpgrade(request, socket, head, (client) => {
        void this.handleConnection(client, request.url ?? '');
      });
    });

    // `FR-10.16` — debounced rather than per-update. A whiteboard produces an
    // update per stroke segment, and a `bytea` write per mouse-move would be a
    // database doing a pen's job.
    this.flushTimer = setInterval(() => void this.flushDirty(), this.states.debounceMs);
    this.flushTimer.unref();

    this.logger.log(`Shared objects on ${COLLAB_PATH} (Yjs, ADR 0012)`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    // Everything dirty, written down before the process goes. A restart that
    // lost the last two seconds of a workshop would be the one failure this
    // whole mechanism exists to prevent.
    await this.flushDirty(true);
    this.wss?.close();
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-10.14` — scoped at subscription, which is the only place it can be.
   *
   * A CRDT update is opaque and idempotent; there is no per-message filtering to
   * do and no meaningful way to do it. So the check happens once, at connect:
   * the caller must prove they are the session they claim, be standing in the
   * Map the object belongs to, and be within its interaction range. A socket
   * that passes is a socket that is entitled to everything on it.
   *
   * The resume token is what proves the session, and it is the same secret the
   * guest-upgrade endpoint accepts for the same purpose (`FR-6.7`): it is held
   * only by the client the server issued it to, unlike a session id, which is
   * broadcast to everybody in range on `PARTICIPANT_ADD`.
   */
  private async handleConnection(socket: WebSocket, url: string): Promise<void> {
    const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const roomKey = query.get('room') ?? '';
    const resumeToken = query.get('token') ?? '';

    const parsed = parseCollabRoom(roomKey);
    if (!parsed || !resumeToken) {
      socket.close(1008, 'room and token are required');
      return;
    }

    const authorized = this.world.authorizeInteraction(resumeToken, parsed.objectId);
    if (!authorized.ok) {
      // Closed with the reason rather than dropped. A socket that simply goes
      // away is indistinguishable from a network fault, and the client would
      // retry into the same refusal forever.
      socket.close(1008, authorized.reason);
      return;
    }

    if (authorized.mapId !== parsed.mapId) {
      socket.close(1008, 'that object is not in the map you are in');
      return;
    }

    /**
     * The listener goes on **before** the room is loaded, and early frames are
     * queued.
     *
     * Loading a room is a database read (sharp edge nº4), and a client sends its
     * own sync step as soon as the socket opens — which is inside that await. A
     * listener attached afterwards misses it entirely, and `ws` does not buffer
     * for a socket nobody is listening to: the frame is simply gone. The
     * symptom is a handshake that half-completes and a whiteboard that stays
     * empty, with nothing logged anywhere.
     */
    socket.binaryType = 'nodebuffer';
    const queued: Buffer[] = [];
    let ready: CollabRoom | null = null;

    socket.on('message', (data) => {
      if (ready) this.onMessage(socket, ready, data as Buffer);
      else queued.push(data as Buffer);
    });

    const room = await this.roomFor(
      parsed.mapId,
      parsed.objectId,
      authorized.contentType,
      authorized.persist,
    );

    // The socket may have closed while the snapshot was loading. Adding it to a
    // room now would leave a dead reference the reap check counts as an
    // occupant, which is a room that never empties.
    if (socket.readyState !== socket.OPEN) return;

    room.sockets.add(socket);
    this.roomOf.set(socket, room);
    socket.on('close', () => this.onClose(socket, room));
    socket.on('error', () => this.onClose(socket, room));

    // `FR-10.13` — step one of the sync handshake, sent by the server without
    // being asked. The client answers with what it is missing, and there is no
    // window in which it has applied an update it has no base for.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(socket, encoding.toUint8Array(encoder));

    // Whoever else is already here, so a joiner sees their cursors immediately
    // rather than when they next move.
    const states = room.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
      );
      send(socket, encoding.toUint8Array(awarenessEncoder));
    }

    // Drain whatever arrived while the snapshot was loading, in order, and only
    // then let new frames through directly — so the two paths cannot interleave
    // and deliver an update before the step it answers.
    ready = room;
    for (const message of queued) this.onMessage(socket, room, message);
    queued.length = 0;
  }

  private onMessage(socket: WebSocket, room: CollabRoom, data: Buffer): void {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          // `readSyncMessage` applies what it is given and writes any reply the
          // protocol requires. Updates are relayed by the document's own
          // observer below, not from here — so a client that sends an update and
          // a client that receives one go through exactly one path.
          syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
          if (encoding.length(encoder) > 1) send(socket, encoding.toUint8Array(encoder));
          break;
        }

        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            room.awareness,
            decoding.readVarUint8Array(decoder),
            socket,
          );
          break;
        }

        default:
          // A newer client speaking a message type this build does not know.
          // Ignored, never fatal — the same versioning rule the game protocol
          // follows for unknown opcodes.
          break;
      }
    } catch (error) {
      this.logger.warn(`Malformed collaboration frame: ${(error as Error).message}`);
    }
  }

  private onClose(socket: WebSocket, room: CollabRoom): void {
    if (!room.sockets.delete(socket)) return;

    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [...room.awareness.getStates().keys()].filter(
        (client) =>
          room.awareness.meta.get(client)?.clock !== undefined && client !== room.doc.clientID,
      ),
      socket,
    );

    if (room.sockets.size > 0) return;

    // `FR-10.16` — flushed when the last participant leaves, rather than waiting
    // for the debounce. The one moment a room genuinely finishes is the moment
    // everybody has gone, and a crash in the two seconds afterwards would lose
    // exactly the session that just ended.
    void this.flushRoom(room, true).then(() => {
      // Only dropped once it is safely written down, and only if nobody arrived
      // in the meantime.
      if (room.sockets.size === 0) {
        room.doc.destroy();
        this.rooms.delete(room.key);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The live document for one object, loaded on first use.
   *
   * Sharp edge nº4 in the phase notes: this is a database read, so the first
   * interaction with a dormant object pays for it — which is why the client
   * shows a loading state rather than an empty whiteboard, since an empty
   * whiteboard reads as data loss.
   */
  private async roomFor(
    mapId: string,
    objectId: string,
    contentType: string,
    persist: boolean,
  ): Promise<CollabRoom> {
    const key = `${mapId}:${objectId}`;
    const existing = this.rooms.get(key);
    if (existing) return existing;

    const doc = new Y.Doc();
    const snapshot = persist ? await this.states.load(mapId, objectId) : null;
    if (snapshot) Y.applyUpdate(doc, snapshot);

    const room: CollabRoom = {
      key,
      mapId,
      objectId,
      doc,
      awareness: new awarenessProtocol.Awareness(doc),
      sockets: new Set(),
      contentType,
      dirty: false,
      persist,
    };

    // One relay for updates, one for awareness. Both exclude their origin, so a
    // client never receives its own change back — which would be harmless for a
    // CRDT and wasteful at the rate a pen produces them.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      room.dirty = true;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const socket of room.sockets) {
        if (socket === origin) continue;
        send(socket, message);
      }
    });

    room.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed),
        );
        const message = encoding.toUint8Array(encoder);
        for (const socket of room.sockets) {
          if (socket === origin) continue;
          send(socket, message);
        }
      },
    );

    this.rooms.set(key, room);
    return room;
  }

  /** `FR-10.16` — everything that has changed since the last sweep. */
  private async flushDirty(force = false): Promise<void> {
    for (const room of this.rooms.values()) {
      if (!room.dirty && !force) continue;
      await this.flushRoom(room, force);
    }
  }

  private async flushRoom(room: CollabRoom, force: boolean): Promise<void> {
    if (!room.persist) {
      // `persistShared: false` — the state was never meant to outlive the
      // session, and writing it anyway would make the editor's checkbox a lie.
      room.dirty = false;
      return;
    }
    if (!room.dirty && !force) return;
    room.dirty = false;

    try {
      await this.states.save(room.mapId, room.objectId, room.contentType, room.doc);
    } catch (error) {
      // Marked dirty again, so the next sweep retries. Losing a whiteboard to a
      // transient database failure is the outcome this whole mechanism exists to
      // prevent, and a silent drop would be exactly that.
      room.dirty = true;
      this.logger.error(
        `Could not persist ${room.key}: ${(error as Error).message}. It will be retried.`,
      );
    }
  }

  /** For `/health`: how many shared objects are live, and how many people are on
   *  them. Two synchronization mechanisms coexist and only one of them is
   *  visible from `lastTickMs`. */
  get stats(): { objects: number; sockets: number } {
    let sockets = 0;
    for (const room of this.rooms.values()) sockets += room.sockets.size;
    return { objects: this.rooms.size, sockets };
  }
}

function send(socket: WebSocket, message: Uint8Array): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(message);
}
