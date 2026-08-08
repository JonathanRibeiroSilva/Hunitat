/**
 * Interactive objects and their content — phase 10.
 *
 * ── The configuration format already exists ─────────────────────────────────
 *
 * `DC-10.1` is the `interactive` block on a placed object, and it was specified
 * before Phase 1 in [map-document.md](../../../specs/protocol/map-document.md)
 * alongside everything else the document holds. Its *presence* is what makes an
 * object interactive; this file is what the two ends agree about the payload
 * inside it, and about the live state that is deliberately **not** in the
 * document.
 *
 * ── Configuration versions with the map; state does not ─────────────────────
 *
 * The Phase 10 Rules put it plainly, and it is the distinction the whole phase
 * turns on. A whiteboard's *configuration* — that it is a whiteboard, how close
 * you must stand, whether it is shared — lives in the Map Document and is
 * versioned by phase 9. A whiteboard's *contents* live in a CRDT and are not.
 * Reverting a map to last Tuesday must not silently erase what people drew on
 * Wednesday.
 *
 * ── The boundary `AC-10.6` asks to be confirmed ─────────────────────────────
 *
 * There is no generic app framework here and there is nowhere to put one. The
 * content types are a **closed enum**, validated by Zod on both ends; adding one
 * is a code change and a schema bump. There is no sandbox, no `postMessage`
 * bridge, and no arbitrary iframe. A plain outbound link is allowed, because a
 * link is not hosting somebody else's application.
 */

import { z } from 'zod';
import { TUNING } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// DC-10.2 Content
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five built-in types, and nothing else — `FR-10.5`–`FR-10.9`.
 *
 * Re-exported from the map document's own enum rather than restated, so the
 * closed set `AC-10.6` asks about has exactly one definition. A sixth entry here
 * that the document did not know about would be a content type nobody could
 * author.
 */
export const CONTENT_TYPES = ['link', 'image', 'video', 'note', 'document'] as const;
export const contentTypeSchema = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof contentTypeSchema>;

/**
 * The payload per type, validated rather than trusted.
 *
 * `placedObjectSchema.interactive.content` is a `Record<string, unknown>` in the
 * document — deliberately, so the format did not have to predict five payload
 * shapes before Phase 1 — and this is where that record becomes a thing with
 * fields. Parsed at the point of *use* rather than at the point of storage,
 * which is what lets an older document hold a type this build has never heard
 * of without failing to load the room.
 */
export const linkContentSchema = z.object({
  /**
   * Where it goes. `http` and `https` only.
   *
   * `javascript:` and `data:` are refused rather than sanitised: an outbound
   * link that executes in the page is not an outbound link, and the Rules
   * require following one to be "clearly an outbound action" — which it cannot
   * be if it never leaves.
   */
  url: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'a link must start with http:// or https://'),
  label: z.string().trim().max(120).optional(),
});

export const imageContentSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  alt: z.string().trim().max(280).optional(),
  /** `FR-10.6` — "and/or render it in-world". A poster on a wall is a texture,
   *  a slide deck is a panel, and both are legitimate readings of the same
   *  requirement. */
  inWorld: z.boolean().default(false),
});

export const videoContentSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  title: z.string().trim().max(120).optional(),
  /** Whether to start playing on open. Off by default: a wall of screens that
   *  all start talking when somebody walks past is a room nobody can work in. */
  autoplay: z.boolean().default(false),
});

export const noteContentSchema = z.object({
  /** The starting text. Once an editable note is opened, the CRDT is the
   *  authority and this is only what a fresh one begins as (`FR-10.8`). */
  text: z.string().max(20_000).default(''),
  /** `FR-10.8` — "and, if configured, editable". */
  editable: z.boolean().default(false),
  title: z.string().trim().max(120).optional(),
});

export const documentContentSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  title: z.string().trim().max(120).optional(),
});

/**
 * `FR-10.11` — the shared surfaces, which have no content in the document at
 * all.
 *
 * A whiteboard's configuration is "this is a whiteboard"; everything else about
 * it is in the CRDT. It rides on `note` with `shared: true` rather than being a
 * sixth content type, because it *is* a note surface — and adding a type to the
 * closed enum is a schema bump the Map Document shares with three other phases.
 */
export const whiteboardSurfaceSchema = z.object({
  /** `whiteboard` draws strokes, `notes` places sticky notes, `text` is a shared
   *  document. All three are `note` content with `shared: true`. */
  surface: z.enum(['text', 'whiteboard', 'notes']).default('text'),
});

export type LinkContent = z.infer<typeof linkContentSchema>;
export type ImageContent = z.infer<typeof imageContentSchema>;
export type VideoContent = z.infer<typeof videoContentSchema>;
export type NoteContent = z.infer<typeof noteContentSchema>;
export type DocumentContent = z.infer<typeof documentContentSchema>;

/**
 * Parse one object's content against its declared type.
 *
 * Returns null rather than throwing, and every caller draws "this object is
 * misconfigured" rather than failing. A room with one badly-authored poster in
 * it must still be a room.
 */
export function parseContent(
  contentType: ContentType,
  content: Record<string, unknown>,
):
  | { type: 'link'; value: LinkContent }
  | { type: 'image'; value: ImageContent }
  | { type: 'video'; value: VideoContent }
  | { type: 'note'; value: NoteContent }
  | { type: 'document'; value: DocumentContent }
  | null {
  switch (contentType) {
    case 'link': {
      const parsed = linkContentSchema.safeParse(content);
      return parsed.success ? { type: 'link', value: parsed.data } : null;
    }
    case 'image': {
      const parsed = imageContentSchema.safeParse(content);
      return parsed.success ? { type: 'image', value: parsed.data } : null;
    }
    case 'video': {
      const parsed = videoContentSchema.safeParse(content);
      return parsed.success ? { type: 'video', value: parsed.data } : null;
    }
    case 'note': {
      const parsed = noteContentSchema.safeParse(content);
      return parsed.success ? { type: 'note', value: parsed.data } : null;
    }
    case 'document': {
      const parsed = documentContentSchema.safeParse(content);
      return parsed.success ? { type: 'document', value: parsed.data } : null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DC-10.3 Shared Object State — the collaboration channel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The path the CRDT socket is opened on.
 *
 * A second WebSocket on the **same server** as the game protocol, and the phase
 * notes are explicit that this is a feature of the transport choice rather than
 * an accident: `y-websocket` is built on `ws`, so it mounts beside the game
 * protocol (ADR 0003) and inherits the same process, the same origin and the
 * same authenticated handshake. Had the transport been socket.io this would have
 * needed a shim.
 *
 * Two synchronization mechanisms now coexist, and they must not be unified
 * (sharp edge nº3): the game protocol optimises for speed and tolerates loss;
 * this optimises for convergence and tolerates latency.
 */
export const COLLAB_PATH = '/collab';

/**
 * Which shared object a socket is for — `<mapId>:<objectId>`.
 *
 * The map is part of it because object ids are unique within a document, not
 * across a Space: two rooms can each have a `whiteboard-1`, and one CRDT for
 * both would merge two teams' work into one surface.
 */
export function collabRoom(mapId: string, objectId: string): string {
  return `${mapId}:${objectId}`;
}

export function parseCollabRoom(room: string): { mapId: string; objectId: string } | null {
  const separator = room.lastIndexOf(':');
  if (separator <= 0 || separator === room.length - 1) return null;
  return { mapId: room.slice(0, separator), objectId: room.slice(separator + 1) };
}

/**
 * The Yjs keys both ends agree on.
 *
 * Constants rather than literals for the reason every channel id in this project
 * is one: a client writing strokes into `strokes` and a server persisting
 * `stroke` is a whiteboard that saves nothing, and nothing anywhere would error.
 */
export const YJS_KEYS = {
  /** `Y.Array` of strokes. Each is `{ color, width, points: number[] }` with
   *  points as a flat `[x, y, x, y…]` in 0..1 board space, so a board rendered
   *  at any size is the same drawing. */
  strokes: 'strokes',
  /** `Y.Map` of sticky notes, keyed by id: `{ x, y, text, color, by }`. */
  notes: 'notes',
  /** `Y.Text` — the shared note body (`FR-10.8`). */
  text: 'text',
  /** `Y.Map` holding `{ state, positionMs, updatedAt }` for a shared video
   *  (`FR-10.7`, `FR-10.10`). Position is stamped with the time it was true, so
   *  a late joiner can compute where the video is *now* rather than seeking to
   *  where it was when somebody pressed play. */
  video: 'video',
} as const;

/** `FR-10.7`, `FR-10.10` — what a shared video's `Y.Map` holds. */
export const videoSyncSchema = z.object({
  state: z.enum(['playing', 'paused']),
  positionMs: z.number().nonnegative(),
  /** Server-agnostic: the client that set it stamps its own clock, and every
   *  reader compares *elapsed* rather than absolute time. Clocks are not assumed
   *  to agree (conventions/coordinates-and-units.md#time). */
  updatedAt: z.number(),
  by: z.string().optional(),
});

export type VideoSyncState = z.infer<typeof videoSyncSchema>;

// ─────────────────────────────────────────────────────────────────────────────

/** `FR-10.2` — the default interaction range, when an object does not set one. */
export const INTERACT_RANGE_M = TUNING.INTERACT_RANGE_M;
/** `FR-10.16` — how long shared state settles before it is written down. */
export const YJS_PERSIST_DEBOUNCE_MS = TUNING.YJS_PERSIST_DEBOUNCE_MS;
/** `FR-10.10` — how far a shared video may drift before a client seeks. */
export const VIDEO_SYNC_DRIFT_TOLERANCE_MS = TUNING.VIDEO_SYNC_DRIFT_TOLERANCE_MS;
/** Sharp edge nº1 — the snapshot size at which history is compacted away. */
export const YJS_COMPACT_ABOVE_BYTES = TUNING.YJS_COMPACT_ABOVE_BYTES;
