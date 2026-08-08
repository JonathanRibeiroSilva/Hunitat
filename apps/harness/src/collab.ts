/**
 * A headless shared-object client — phase 10.
 *
 * The same `y-protocols` sync the browser and the server speak, over `ws`. That
 * is what makes the shared-object scenarios cover the real thing: a change to
 * the sync handshake, to the authorization at `/collab`, or to the persistence
 * flush fails here rather than turning up later as a whiteboard that quietly
 * forgot an afternoon.
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { COLLAB_PATH, collabRoom } from '@hubitat/protocol';

const MESSAGE_SYNC = 0;

export class CollabClient {
  readonly doc = new Y.Doc();
  private socket: WebSocket | null = null;

  /** Resolves when the first sync round trip has completed — which is the only
   *  moment "the document is the server's" becomes true, and therefore the only
   *  moment a scenario may assert on its contents. */
  readonly ready: Promise<void>;
  /** Set when the server refused (`FR-10.14`), with its reason. */
  refusal: string | null = null;

  private settle: (() => void) | null = null;
  private fail: ((error: Error) => void) | null = null;

  constructor(wsUrl: string, mapId: string, objectId: string, resumeToken: string) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;

      // A sync that never completes must *fail*, not hang. A scenario blocked
      // forever on a handshake tells whoever is reading the output nothing at
      // all, and is the one failure mode a test harness must not have.
      const timer = setTimeout(
        () => reject(new Error(`collab sync for ${objectId} did not complete within 5 s`)),
        5000,
      );
      timer.unref();
    });

    const base = wsUrl.replace(/\/ws$/, '');
    const url =
      `${base}${COLLAB_PATH}` +
      `?room=${encodeURIComponent(collabRoom(mapId, objectId))}` +
      `&token=${encodeURIComponent(resumeToken)}`;

    const socket = new WebSocket(url);
    socket.binaryType = 'nodebuffer';
    this.socket = socket;

    // The client opens the sync, and the server opens it too. Both halves are
    // needed and neither is symmetrical: a step-1 carries *my* state vector and
    // is answered with the updates I am missing, so one side sending it only
    // ever moves the document in one direction. y-websocket's client does the
    // same thing for the same reason.
    socket.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
    });

    socket.on('message', (data) => this.onMessage(new Uint8Array(data as Buffer)));
    socket.on('close', (code, reason) => {
      if (code === 1008) {
        this.refusal = reason.toString() || 'refused';
        this.fail?.(new Error(`collab refused: ${this.refusal}`));
      }
    });
    socket.on('error', (error) => this.fail?.(error));

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
  }

  /**
   * Apply a local change and have it sent.
   *
   * **No origin.** The origin is what distinguishes an edit this client made
   * from one it received: remote updates are applied with `this` as the origin,
   * so a local change tagged the same way would be mistaken for one and never
   * sent. Silent in both directions, which is why it is a method rather than a
   * convention.
   */
  transact(change: () => void): void {
    this.doc.transact(change);
  }

  close(): void {
    this.socket?.close(1000, 'done');
    this.socket = null;
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;

    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));

    // Ready when the *server's* state has arrived — a step-2 answering our
    // step-1, or an update. Resolving on the first message would resolve on the
    // server's own step-1, which carries no content at all, and a scenario would
    // then assert against an empty document.
    if (kind === syncProtocol.messageYjsSyncStep2 || kind === syncProtocol.messageYjsUpdate) {
      this.settle?.();
      this.settle = null;
    }
  }

  private send(message: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(message);
  }
}
