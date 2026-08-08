/**
 * The shared-object client — `FR-10.11`–`FR-10.14`, `FR-10.17`.
 *
 * A minimal Yjs WebSocket provider: the same `y-protocols` sync and awareness
 * the server speaks, over a socket opened at `/collab`.
 *
 * ── Why not `y-websocket`'s provider ────────────────────────────────────────
 *
 * Because its connection policy is not ours. It reconnects forever, it names
 * rooms by path, and it has no concept of a credential — and `FR-10.14` scopes a
 * channel to somebody who is *in range of the object*, which means a refusal is
 * a normal outcome rather than an error to retry through. Walking away from a
 * whiteboard closes the socket, and a provider that fought that would reopen it
 * from across the room.
 *
 * What is shared with `y-websocket` is the part that matters: the wire protocol,
 * from the same modules. This is the policy around it.
 *
 * ── Closing is safe by construction ─────────────────────────────────────────
 *
 * `FR-10.17` — "closing/leaving an object never corrupts its shared state for
 * others still using it". There is nothing to corrupt: a CRDT has no
 * per-connection state, so a disconnect at any moment leaves every other
 * participant with a document that is complete and converged.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { COLLAB_PATH, collabRoom } from '@hubitat/protocol';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** The same resolution the game socket uses — see `net/client.ts`. Empty means
 *  "this page's origin", which is what makes a tunnelled dev server work. */
const WS_BASE =
  import.meta.env.VITE_WS_URL === ''
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
    : (import.meta.env.VITE_WS_URL ?? 'ws://localhost:3000/ws').replace(/\/ws$/, '');

export type CollabStatus = 'connecting' | 'ready' | 'refused' | 'closed';

/**
 * One open shared object.
 *
 * `ready` is deliberately not "the socket opened" but "the first sync round trip
 * finished" — sharp edge nº4 in the phase notes: a dormant object's snapshot is
 * a database read, and an empty whiteboard shown before it lands reads as data
 * loss rather than as loading.
 */
export class CollabSession {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);

  private socket: WebSocket | null = null;
  private synced = false;
  private closed = false;

  status: CollabStatus = 'connecting';
  /** Present when the server refused. `FR-10.14`'s refusals are ordinary — "you
   *  are too far from that object" is a thing that happens by walking. */
  refusal: string | null = null;

  private readonly listeners = new Set<() => void>();

  constructor(
    readonly mapId: string,
    readonly objectId: string,
    private readonly resumeToken: string,
  ) {
    this.open();

    // Every local change goes out. The origin is this object, so the server's
    // relay skips the socket it came from and nothing echoes.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
      this.emit();
    });

    this.awareness.on('update', ({ added, updated, removed }: Record<string, number[]>) => {
      const changed = [...(added ?? []), ...(updated ?? []), ...(removed ?? [])];
      if (changed.length === 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this.send(encoding.toUint8Array(encoder));
    });
  }

  /** Fires whenever the document or the status changes, so React can re-read it.
   *  A subscription rather than a hook, because the same session is read by four
   *  different surfaces. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Make a local change — the only way a surface should.
   *
   * The origin is what distinguishes an edit *this* client made from one it
   * received, and getting it wrong is silent in both directions: pass the
   * session and the change is treated as remote and never sent; pass nothing on
   * a remote apply and it is echoed straight back. A method rather than a
   * convention, so the four surfaces cannot each get it wrong differently.
   */
  mutate(change: () => void): void {
    this.doc.transact(change);
  }

  close(): void {
    this.closed = true;
    // Announced before the socket goes, so other people's cursors disappear
    // promptly rather than on a timeout.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.socket?.close(1000, 'closed');
    this.socket = null;
    this.awareness.destroy();
    this.doc.destroy();
    this.status = 'closed';
    this.listeners.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────

  private open(): void {
    const url =
      `${WS_BASE}${COLLAB_PATH}` +
      `?room=${encodeURIComponent(collabRoom(this.mapId, this.objectId))}` +
      `&token=${encodeURIComponent(this.resumeToken)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.status = 'refused';
      this.refusal = 'This object could not be opened.';
      this.emit();
      return;
    }

    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    // Both sides open the sync, and neither half is redundant: a step-1 carries
    // *my* state vector and is answered with the updates I lack, so one side
    // sending it only ever moves the document one way. Ours is what fetches the
    // board somebody else has already drawn on.
    socket.onopen = () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
    };

    socket.onmessage = (event) => this.onMessage(new Uint8Array(event.data as ArrayBuffer));

    socket.onclose = (event) => {
      if (this.closed) return;
      // 1008 is the server refusing (`FR-10.14`), and its reason is a sentence
      // for a person. Anything else is a connection that went away, which for a
      // panel somebody has open is worth saying differently.
      if (event.code === 1008) {
        this.status = 'refused';
        this.refusal = event.reason || 'You cannot open that object from here.';
      } else {
        this.status = 'closed';
      }
      this.emit();
    };
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));

      // Ready when the *server's* state has arrived — a step-2 answering our
      // step-1, or an update. Not on the first message of any kind: the server
      // opens with its own step-1, which carries no content, and treating that
      // as ready would show an empty whiteboard for a board that has plenty on
      // it. See the note on `ready` above.
      if (
        !this.synced &&
        (kind === syncProtocol.messageYjsSyncStep2 || kind === syncProtocol.messageYjsUpdate)
      ) {
        this.synced = true;
        this.status = 'ready';
      }
      this.emit();
      return;
    }

    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
      this.emit();
    }
  }

  private send(message: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(message);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
