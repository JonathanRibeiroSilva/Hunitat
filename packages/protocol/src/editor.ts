/**
 * The map editor and the asset pipeline — phase 9.
 *
 * ── This phase does not design a format ─────────────────────────────────────
 *
 * `DC-9.1` is the Map Document, and it was defined before Phase 1 in
 * [map-document.md](../../../specs/protocol/map-document.md) — because Phase 1
 * loads one, Phase 3 stores zones in one and Phase 10 stores object
 * configuration in one. Inventing it here would have broken everything built in
 * between. So what is new in this file is everything *around* the document: the
 * draft that is being edited, the versions it has been published as, the lock
 * that stops two authors clobbering each other, and the assets it references.
 *
 * ── Drafts are mutable, versions are not ────────────────────────────────────
 *
 * The distinction runs through every shape here and is worth stating once. A
 * **draft** is one row per Map that authors overwrite as they work; a **version**
 * is an immutable snapshot written at publish. That is what makes `FR-9.4`
 * ("non-destructive to the live published Map") structural rather than a rule
 * somebody has to remember: participants read `maps.current_version_id`, which no
 * amount of editing touches.
 *
 * Reverting (`FR-9.19`) writes an *older document into a newer version*, never
 * deletes the newer one. That is what lets an author revert and then return to
 * what they reverted from — a revert that rolled the pointer backwards would
 * leave the way forward only through the browser's back button.
 */

import { z } from 'zod';
import { TUNING } from './constants.js';
import { mapDocumentSchema } from './map-document.js';

// ─────────────────────────────────────────────────────────────────────────────
// DC-9.3 Asset · DC-9.4 Asset Library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an asset is. Closed, because each kind has a different validator and a
 * different place in the editor.
 *
 * `model` is the only one placed in a scene. `texture` and `thumbnail` exist
 * because `FR-9.11` names them, and because a model with no preview image is a
 * grey box in a library of grey boxes.
 */
export const ASSET_KINDS = ['model', 'texture', 'thumbnail'] as const;
export const assetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof assetKindSchema>;

/**
 * `DC-9.3`'s "validation status", which is also the job state.
 *
 * The pipeline runs in another process (`FR-9.13`, and see the phase notes on
 * why), so an upload is not finished when the bytes land — it is finished when
 * the worker has parsed it, decided it is usable, and written its optimized
 * variants. These four states are that progression, and the editor shows them
 * rather than pretending an asset is ready the moment it is uploaded.
 *
 * `rejected` is terminal and always carries a reason (`FR-9.12`).
 */
export const ASSET_STATUSES = ['pending', 'processing', 'ready', 'rejected'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

/** One level-of-detail variant produced by the pipeline (`FR-9.13`). */
export const assetLodSchema = z.object({
  /** 0 is the original. Higher indices are progressively simpler. */
  level: z.number().int().nonnegative(),
  /** The fraction of the original triangle count this variant was simplified to. */
  ratio: z.number().positive().max(1),
  triangles: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  url: z.string(),
});

export type AssetLodDto = z.infer<typeof assetLodSchema>;

export const assetSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  name: z.string(),
  /**
   * What a Map Document's `assetId` references (`DC-9.2`).
   *
   * A slug rather than the uuid, for the reason a Map's slug is one: a document
   * is read, copied between Maps and hand-edited by people, and a uuid in it is
   * an act of copy-paste archaeology. Unique within the Space, derived from the
   * name on upload.
   */
  slug: z.string(),
  status: assetStatusSchema,
  /** Present once `ready`. The URL a Map Document's `geometry.url` or a placed
   *  object's asset resolves to. */
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  triangles: z.number().int().nonnegative(),
  lods: z.array(assetLodSchema).default([]),
  /** `FR-9.12` — always present on `rejected`, and always specific. "Invalid
   *  file" is not a reason somebody can act on. */
  error: z.string().nullable(),
  /**
   * `FR-9.14` — how many Maps in this Space reference it, across every retained
   * version.
   *
   * Not a foreign key, because the reference lives inside a `jsonb` document and
   * Postgres cannot see it. Counted by an explicit scan, which is the standing
   * cost of storing the document as a blob (ADR 0008) and is what makes
   * "removing an in-use asset is blocked" enforceable rather than advisory.
   */
  usedByMaps: z.number().int().nonnegative().default(0),
  /** `FR-9.15` — shipped with the product rather than uploaded. Built-ins cannot
   *  be deleted; a Space always has something to build with. */
  builtIn: z.boolean().default(false),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

export type AssetDto = z.infer<typeof assetSchema>;

/**
 * `FR-9.11` — ask for somewhere to put the bytes.
 *
 * The answer is a presigned `PUT` straight to object storage: the bytes never
 * pass through `api`, which is running a 20 Hz world tick and has no business
 * buffering a 40 MB model. The size is declared up front so an oversized upload
 * is refused before it starts rather than after it finishes.
 */
export const assetUploadRequestSchema = z.object({
  kind: assetKindSchema,
  name: z.string().trim().min(1).max(120),
  contentType: z.string().min(1).max(128),
  bytes: z.number().int().positive().max(TUNING.ASSET_MAX_BYTES),
});

export type AssetUploadRequest = z.infer<typeof assetUploadRequestSchema>;

export const assetUploadTicketSchema = z.object({
  asset: assetSchema,
  /** Presigned `PUT`. Short-lived by design — it is write access to a bucket. */
  uploadUrl: z.string(),
  expiresInSeconds: z.number().int().positive(),
  /** Headers the client must send with the PUT, exactly. A presigned URL signs
   *  them, so a mismatch is a signature error rather than a helpful message. */
  headers: z.record(z.string(), z.string()).default({}),
});

export type AssetUploadTicketDto = z.infer<typeof assetUploadTicketSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// DC-9.5 Map Version · FR-9.17 – FR-9.20
// ─────────────────────────────────────────────────────────────────────────────

export const mapVersionSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  notes: z.string().nullable(),
  /** The one participants are in right now. Exactly one version is this. */
  published: z.boolean(),
});

export type MapVersionDto = z.infer<typeof mapVersionSchema>;

/**
 * `FR-9.22` — the advisory editor lock.
 *
 * Advisory, and the word is doing work: the *guarantee* against clobbering is
 * the optimistic `revision` check below, which cannot be bypassed. This is the
 * courtesy that stops two authors reaching that guarantee at all, by telling the
 * second one that somebody is already in there.
 *
 * It expires rather than being held: an author who closes their laptop must not
 * lock a Map until somebody restarts the server.
 */
export const editorLockSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  expiresAt: z.string(),
  /** True when the lock belongs to the caller, so the editor can say "you have
   *  it" rather than "somebody has it". */
  mine: z.boolean(),
});

export type EditorLockDto = z.infer<typeof editorLockSchema>;

/**
 * Everything the editor needs to open a Map, in one response.
 *
 * One call rather than four, for the reason the moderation and space overviews
 * give: a draft with no version history, or a lock with no document, is a screen
 * somebody would have to reconcile by hand.
 */
export const editorStateSchema = z.object({
  mapId: z.string(),
  mapSlug: z.string(),
  mapName: z.string(),
  /**
   * `FR-9.4` — what is being edited. Seeded from the published document the
   * first time a Map is opened, so an author never starts from an empty room
   * they then have to rebuild.
   */
  draft: mapDocumentSchema,
  /**
   * `FR-9.22`'s guarantee. Every save carries the revision it was made against
   * and is refused with 409 if the draft has moved on — which is what makes
   * "concurrent edits must not silently clobber" true rather than hoped for.
   */
  revision: z.number().int().nonnegative(),
  draftUpdatedAt: z.string().nullable(),
  draftUpdatedBy: z.string().nullable(),
  /** True when the draft differs from the published version — what the publish
   *  button is enabled by, and what "unsaved" means on this screen. */
  dirty: z.boolean(),
  publishedVersion: z.number().int().nonnegative(),
  versions: z.array(mapVersionSchema).default([]),
  lock: editorLockSchema.nullable(),
  /** `FR-9.14`, and the editor half of it: what this Map can be built from. */
  assets: z.array(assetSchema).default([]),
  /**
   * The Rules' "portals with unresolvable targets are flagged in the editor,
   * before publish rather than after". Recomputed on every read of this state,
   * because the Map a portal names can be deleted while somebody has the editor
   * open.
   */
  brokenPortals: z.array(z.object({ zoneId: z.string(), targetMapId: z.string() })).default([]),
  /** Sharp edge nº4 in the phase notes: a `jsonb` document should stay well
   *  under a megabyte, and the only way that is true is if the number is on
   *  screen before it stops being true. */
  documentBytes: z.number().int().nonnegative(),
});

export type EditorStateDto = z.infer<typeof editorStateSchema>;

/** `FR-9.4` — save the draft. Never touches what participants are standing in. */
export const draftSaveSchema = z.object({
  document: mapDocumentSchema,
  /** The revision this edit was made against. A mismatch is a 409, not a
   *  merge: two authors moving the same wall have no correct automatic
   *  resolution, and inventing one is how work disappears. */
  revision: z.number().int().nonnegative(),
});

export type DraftSaveRequest = z.infer<typeof draftSaveSchema>;

/** `FR-9.18` — make the draft live. */
export const publishRequestSchema = z.object({
  notes: z.string().trim().max(200).optional(),
});

export type PublishRequest = z.infer<typeof publishRequestSchema>;

/**
 * `FR-9.19` — go back to a retained version.
 *
 * Copy-forward: the named version's document becomes the draft, and publishing
 * it writes a *new* version. Nothing is deleted, so the author can return to
 * what they reverted from — which is the half of the requirement that a pointer
 * rolled backwards would lose.
 */
export const revertRequestSchema = z.object({
  version: z.number().int().positive(),
  /** Whether to publish the reverted document immediately, or only load it into
   *  the draft for review. Both are things an author means by "revert", and
   *  guessing which produces either a surprise or an extra click. */
  publish: z.boolean().default(false),
});

export type RevertRequest = z.infer<typeof revertRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// FR-9.20 — telling participants a new version exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `0xA2 MAP_UPDATED` — the Map you are standing in has been republished.
 *
 * **Not a forced reload.** The requirement is explicit that publishing must
 * handle participants gracefully — "apply on next entry or coordinate a smooth
 * reload, not a hard break" — and a client that tore the world down mid-sentence
 * would be the hard break. So this is a notification: the running instance keeps
 * the document it was allocated with, the next one reads the new version, and
 * the participant is offered a reload they choose to take.
 *
 * Sent only to people in the Map that changed. Everybody else has no use for it.
 */
export const mapUpdatedSchema = z.object({
  mapId: z.string(),
  mapName: z.string(),
  version: z.number().int().positive(),
  /** Who published it, so the prompt can say "Ana published a new version"
   *  rather than something happening for no visible reason. */
  by: z.string().nullable(),
  notes: z.string().nullable(),
});

export type MapUpdatedPayload = z.infer<typeof mapUpdatedSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Limits, re-exported next to the requirement they serve
// ─────────────────────────────────────────────────────────────────────────────

/** `FR-9.12` — refused before the upload starts, not after it finishes. */
export const ASSET_MAX_BYTES = TUNING.ASSET_MAX_BYTES;
/** `FR-9.12` — `NFR` performance protection, checked in the worker where the
 *  file is actually parsed. */
export const ASSET_MAX_TRIANGLES = TUNING.ASSET_MAX_TRIANGLES;
export const ASSET_MAX_TEXTURE_PX = TUNING.ASSET_MAX_TEXTURE_PX;
/** `FR-9.13` — the simplification targets the pipeline produces. */
export const ASSET_LOD_RATIOS = TUNING.ASSET_LOD_RATIOS;
/** `FR-9.22` — how long an editor lock survives without a heartbeat. */
export const EDITOR_LOCK_TTL_MS = TUNING.EDITOR_LOCK_TTL_MS;
/** How often the editor renews it. A third of the life, so two missed beats are
 *  survivable — and taken from here rather than chosen locally, because a
 *  heartbeat slower than the lock is a lock that expires under somebody. */
export const EDITOR_LOCK_HEARTBEAT_MS = TUNING.EDITOR_LOCK_HEARTBEAT_MS;
/** `FR-9.19` — how far back the version list goes. */
export const MAP_VERSIONS_RETAINED = TUNING.MAP_VERSIONS_RETAINED;
/** Sharp edge nº4 — the size at which the editor starts saying so. */
export const MAP_DOCUMENT_WARN_BYTES = TUNING.MAP_DOCUMENT_WARN_BYTES;

/**
 * Sharp edge nº5 — the coordinate range the wire format can represent.
 *
 * Position is quantized to i16 centimetres, so a map authored outside this
 * cannot be transmitted. The editor refuses it at authoring time rather than
 * letting it fail at runtime as visual corruption nobody can trace.
 *
 * Re-exported from the binary layout rather than restated, so the two cannot
 * drift.
 */
export { POSITION_MAX_M, POSITION_MIN_M } from './binary.js';
