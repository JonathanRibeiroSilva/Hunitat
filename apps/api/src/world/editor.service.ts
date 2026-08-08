/**
 * The editor's server half — `FR-9.4`, `FR-9.17`–`FR-9.22`.
 *
 * Drafts, versions, publishing, reverting, and the two mechanisms that stop two
 * authors destroying each other's afternoon.
 *
 * ── Drafts are mutable, versions are not ────────────────────────────────────
 *
 * A **draft** is one `jsonb` column on `maps` that authors overwrite as they
 * work. A **version** is an immutable row in `map_versions` written at publish.
 * Participants read `maps.current_version_id`, which no amount of editing
 * touches — so `FR-9.4`'s "non-destructive to the live published Map" is a
 * property of the shape rather than a rule somebody has to remember.
 *
 * A version per *save* was the obvious alternative and is wrong: an author saves
 * every few seconds, and `FR-9.19`'s "retained so an author can review and
 * revert" would be a list of keystrokes nobody could read by lunchtime.
 *
 * ── Reverting copies forward ────────────────────────────────────────────────
 *
 * `revert(3)` loads version 3's document into the draft and — if asked —
 * publishes it as version 8. Version 7 still exists, which is the half of
 * `FR-9.19` a pointer rolled backwards would lose: an author who reverts and
 * changes their mind has somewhere to go.
 *
 * ── Two protections, and only one of them is a guarantee ────────────────────
 *
 * `FR-9.22` asks that "concurrent editing is handled safely (at minimum, prevent
 * conflicting overwrites)".
 *
 *   **The revision check is the guarantee.** Every save states the revision it
 *   was made against; a mismatch is refused. It cannot be bypassed, because it
 *   is a compare-and-set on the row itself.
 *
 *   **The lock is the courtesy.** It stops two authors reaching that refusal by
 *   telling the second one somebody is already in there. It expires, because the
 *   failure it guards against is a closed laptop.
 *
 * A merge is deliberately absent. Two authors moving the same wall have no
 * correct automatic resolution, and inventing one is how work disappears
 * silently — which is the outcome the requirement rules out.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EDITOR_LOCK_TTL_MS,
  MAP_DOCUMENT_WARN_BYTES,
  MAP_VERSIONS_RETAINED,
  POSITION_MAX_M,
  POSITION_MIN_M,
  mapDocumentSchema,
  type EditorStateDto,
  type MapDocument,
  type MapVersionDto,
  type PublishRequest,
  type RevertRequest,
} from '@hubitat/protocol';
import type { DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../persistence/database.js';
import { AssetService } from './asset.service.js';
import { MapEntity, MapVersionEntity } from './map.entities.js';
import { MapRegistry, RegistryError, type MapRecord } from './map-registry.service.js';

/** Who is asking. Enough to record authorship and to own a lock. */
export interface Editor {
  accountId: string;
  name: string;
}

@Injectable()
export class EditorService {
  private readonly logger = new Logger(EditorService.name);

  private readonly maps: Repository<MapEntity> | null;
  private readonly versions: Repository<MapVersionEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly registry: MapRegistry,
    private readonly assets: AssetService,
  ) {
    this.maps = dataSource ? dataSource.getRepository(MapEntity) : null;
    this.versions = dataSource ? dataSource.getRepository(MapVersionEntity) : null;
  }

  get enabled(): boolean {
    return this.maps !== null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reading
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Everything the editor needs to open a Map.
   *
   * The draft is **seeded from the published document** the first time somebody
   * opens it, rather than starting empty. An editor that opened on an empty room
   * would make "edit this map" mean "rebuild this map", and the first author to
   * press publish would have destroyed it.
   */
  async state(mapId: string, editor: Editor): Promise<EditorStateDto> {
    const { row, map } = await this.require(mapId);

    const draft = row.draftDocument ?? map.document;
    const versions = await this.versionList(row);
    const documentBytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');

    return {
      mapId: map.id,
      mapSlug: map.slug,
      mapName: map.name,
      draft,
      revision: row.draftRevision,
      draftUpdatedAt: row.draftUpdatedAt?.toISOString() ?? null,
      draftUpdatedBy: row.draftUpdatedBy,
      // Compared as documents rather than by a flag, so a draft edited back to
      // what is live correctly reports itself as clean — a "publish" button lit
      // for a no-op is a button that publishes nothing and says it did.
      dirty: JSON.stringify(draft) !== JSON.stringify(map.document),
      publishedVersion: map.version,
      versions,
      lock: this.lockOf(row, editor),
      assets: await this.assets.list(),
      // Recomputed on every read, because the Map a portal names can be deleted
      // while somebody has the editor open — which is precisely when the Rules
      // want it flagged: "before publish rather than after".
      brokenPortals: this.brokenPortals(draft),
      documentBytes,
    };
  }

  /** `FR-9.19` — one retained version's document, for previewing before a
   *  revert. Reverting blind is how somebody restores the wrong afternoon. */
  async versionDocument(mapId: string, version: number): Promise<MapDocument> {
    const { row } = await this.require(mapId);
    const found = await this.versions!.findOne({ where: { mapId: row.id, version } });
    if (!found) throw new RegistryError('not-found', `There is no version ${version} of this map.`);
    return found.document;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.4, FR-9.22 — saving a draft
  // ───────────────────────────────────────────────────────────────────────────

  async saveDraft(
    mapId: string,
    document: MapDocument,
    revision: number,
    editor: Editor,
  ): Promise<EditorStateDto> {
    const { row, map } = await this.require(mapId);

    // `FR-9.22`'s guarantee. A compare-and-set, so two saves racing on the same
    // revision cannot both win — the second reads a revision that has moved and
    // is refused with what it needs to recover: reload, and re-apply.
    if (row.draftRevision !== revision) {
      throw new RegistryError(
        'conflict',
        `${row.draftUpdatedBy ?? 'Somebody else'} saved this map while you were editing it. ` +
          `Reload to see their changes — saving now would overwrite them.`,
      );
    }

    const problem = this.validate(document, map);
    if (problem) throw new RegistryError('invalid', problem);

    const held = this.lockOf(row, editor);
    if (held && !held.mine) {
      // The courtesy, enforced. A holder who walked away expires; one who is
      // actively editing is not overwritten by somebody who ignored the notice.
      throw new RegistryError(
        'conflict',
        `${held.name} is editing this map. Their lock expires at ` +
          `${new Date(held.expiresAt).toLocaleTimeString('en-GB')}.`,
      );
    }

    // A compare-and-set, not a read-then-write. The check above catches the
    // ordinary case and gives a good message; this catches the case the check
    // cannot — two saves that both read revision 7 in the same millisecond — by
    // making the revision part of the WHERE clause. Without it `FR-9.22` holds
    // only for requests that do not overlap, which is the definition of the
    // race it exists to prevent.
    const affected = await this.writeDraft(row.id, document, revision, editor.name);
    if (affected === 0) {
      throw new RegistryError(
        'conflict',
        'Somebody saved this map at the same moment. Reload to see their changes.',
      );
    }

    return this.state(mapId, editor);
  }

  /** Throw the draft away and start again from what is live. The one operation
   *  that makes an experiment safe to make. */
  async discardDraft(mapId: string, editor: Editor): Promise<EditorStateDto> {
    const { row } = await this.require(mapId);
    await this.writeDraft(row.id, null, null, editor.name);
    return this.state(mapId, editor);
  }

  /**
   * Write the draft, optionally only if it is still at `expectedRevision`.
   *
   * Raw SQL rather than `repository.update`, and for two reasons that both
   * matter. The revision has to be part of the `WHERE` clause for the write to
   * be a compare-and-set at all — TypeORM's `update` takes criteria and a patch,
   * and expressing "and only if" through it is a query builder either way. And
   * `draft_document` is `jsonb` holding a `Record<string, unknown>` from the
   * interactive-object schema, which TypeORM's deep-partial types cannot
   * describe; casting around that would be a lie about a value we are about to
   * serialise by hand anyway.
   *
   * Returns the number of rows written: zero means the revision moved, which is
   * `FR-9.22`'s refusal.
   */
  private async writeDraft(
    mapId: string,
    document: MapDocument | null,
    expectedRevision: number | null,
    editorName: string,
  ): Promise<number> {
    const guard = expectedRevision === null ? '' : ' AND "draft_revision" = $4';
    const parameters: unknown[] = [
      mapId,
      document === null ? null : JSON.stringify(document),
      editorName.slice(0, 64),
    ];
    if (expectedRevision !== null) parameters.push(expectedRevision);

    const result = (await this.maps!.query(
      `UPDATE "maps"
          SET "draft_document"   = $2::jsonb,
              "draft_revision"   = "draft_revision" + 1,
              "draft_updated_at" = now(),
              "draft_updated_by" = $3
        WHERE "id" = $1${guard}`,
      parameters,
    )) as unknown;

    // `query` returns `[rows, affected]` for an UPDATE under the postgres
    // driver. Read defensively rather than destructured: the shape is the
    // driver's, not TypeORM's, and a change to it should degrade to "assume it
    // worked" rather than to a crash on a path that has already succeeded.
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.18, FR-9.20 — publishing
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Make the draft live.
   *
   * Three things, in this order:
   *
   *   1. Write an immutable version row and point the Map at it. From this
   *      instant the *next* instance of the Map reads the new document.
   *   2. Reload the catalogue, so this process's cache agrees.
   *   3. Tell the people already inside — as a **notification**, not a reload.
   *      `FR-9.20` is explicit that publishing must not hard-break them, and a
   *      client that tore the world down mid-sentence would be exactly that. The
   *      running instance keeps the document it was allocated with; it is
   *      replaced when the room next empties and is re-created.
   */
  async publish(mapId: string, request: PublishRequest, editor: Editor): Promise<EditorStateDto> {
    const { row, map } = await this.require(mapId);

    const draft = row.draftDocument;
    if (!draft) {
      throw new RegistryError('invalid', 'There is nothing to publish — this map has no draft.');
    }

    const problem = this.validate(draft, map);
    if (problem) throw new RegistryError('invalid', problem);

    const broken = this.brokenPortals(draft);
    if (broken.length > 0) {
      // The Rules ask for these to be flagged in the editor before publish. A
      // refusal rather than a warning, because the alternative is a published
      // room with a doorway that refuses everybody who walks into it — and the
      // author is the one person who can fix it and the last to find out.
      throw new RegistryError(
        'invalid',
        `${broken.length} portal(s) point at a map that does not exist: ` +
          `${broken.map((portal) => `${portal.zoneId} → ${portal.targetMapId}`).join(', ')}. ` +
          `Repoint or remove them before publishing.`,
      );
    }

    const version = await this.registry.publishVersion(
      row.id,
      draft,
      editor.accountId,
      request.notes,
    );

    // The draft is kept rather than cleared. An author who publishes and keeps
    // working should not find their room emptied by the act of shipping it, and
    // `dirty` correctly reports false because the two documents now match.
    await this.maps!.update({ id: row.id }, { draftUpdatedBy: editor.name.slice(0, 64) });

    await this.registry.refreshAfterPublish({
      kind: 'published',
      mapId: row.id,
      version,
      by: editor.name,
      notes: request.notes ?? null,
    });

    this.logger.log(`${editor.name} published "${map.slug}" version ${version}.`);
    return this.state(mapId, editor);
  }

  /** `FR-9.19` — copy an older version forward. See the header for why forward. */
  async revert(mapId: string, request: RevertRequest, editor: Editor): Promise<EditorStateDto> {
    const { row } = await this.require(mapId);

    const source = await this.versions!.findOne({
      where: { mapId: row.id, version: request.version },
    });
    if (!source) {
      throw new RegistryError('not-found', `There is no version ${request.version} of this map.`);
    }

    await this.writeDraft(row.id, source.document, null, editor.name);

    if (!request.publish) return this.state(mapId, editor);

    return this.publish(mapId, { notes: `Reverted to version ${request.version}` }, editor);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.22 — the advisory lock
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Take the lock, or refuse because somebody else holds it.
   *
   * Also the heartbeat: calling it again while holding it extends the expiry,
   * which is what makes an editor left open for an hour keep its lock and an
   * editor closed by a laptop lid lose it in ninety seconds.
   */
  async acquireLock(mapId: string, editor: Editor): Promise<EditorStateDto> {
    const { row } = await this.require(mapId);

    const held = this.lockOf(row, editor);
    if (held && !held.mine) {
      throw new RegistryError(
        'conflict',
        `${held.name} is editing this map. Their lock expires at ` +
          `${new Date(held.expiresAt).toLocaleTimeString('en-GB')}.`,
      );
    }

    await this.maps!.update(
      { id: row.id },
      {
        lockedBy: editor.accountId,
        lockedByName: editor.name.slice(0, 64),
        lockExpiresAt: new Date(Date.now() + EDITOR_LOCK_TTL_MS),
      },
    );

    return this.state(mapId, editor);
  }

  /** Give it back. Only the holder can, so a second author cannot take a room
   *  from somebody who is in the middle of it. */
  async releaseLock(mapId: string, editor: Editor): Promise<void> {
    const { row } = await this.require(mapId);
    if (row.lockedBy && row.lockedBy !== editor.accountId) return;
    await this.maps!.update(
      { id: row.id },
      { lockedBy: null, lockedByName: null, lockExpiresAt: null },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────

  private lockOf(row: MapEntity, editor: Editor): EditorStateDto['lock'] {
    if (!row.lockedBy || !row.lockExpiresAt) return null;
    // Expired is the same as absent. Read rather than swept: the set is one row,
    // and a timer to clear a field nobody is reading would be work for its own
    // sake.
    if (row.lockExpiresAt.getTime() <= Date.now()) return null;
    return {
      accountId: row.lockedBy,
      name: row.lockedByName ?? 'Somebody',
      expiresAt: row.lockExpiresAt.toISOString(),
      mine: row.lockedBy === editor.accountId,
    };
  }

  private async versionList(row: MapEntity): Promise<MapVersionDto[]> {
    const rows = await this.versions!.find({
      where: { mapId: row.id },
      order: { version: 'DESC' },
      take: MAP_VERSIONS_RETAINED,
    });
    return rows.map((version) => ({
      version: version.version,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdBy,
      notes: version.notes,
      published: version.id === row.currentVersionId,
    }));
  }

  /**
   * Everything that must be true before a document is written down.
   *
   * The schema has already run — the pipe validated the body — so this is the
   * part a schema cannot express: that the document belongs to *this* Map, and
   * that it fits inside the wire format.
   *
   * Sharp edge nº5 in the phase notes is the second one. Position is quantized
   * to i16 centimetres, so geometry outside ±327.67 m cannot be transmitted at
   * all. Refusing it here is what stops it failing at runtime as visual
   * corruption nobody can trace back to an afternoon of authoring.
   */
  private validate(document: MapDocument, map: MapRecord): string | null {
    const parsed = mapDocumentSchema.safeParse(document);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'That map document is invalid.';

    if (document.id !== map.slug) {
      return (
        `This document says it is "${document.id}", but this map is "${map.slug}". A ` +
        `document whose id does not match its map resolves portals against the wrong room.`
      );
    }

    const bounds = [document.bounds.min, document.bounds.max];
    for (const corner of bounds) {
      for (const [axis, value] of Object.entries(corner)) {
        if (value < POSITION_MIN_M || value > POSITION_MAX_M) {
          return (
            `Bounds reach ${value} m on ${axis}, outside the ±${POSITION_MAX_M} m the wire ` +
            `format can represent. Geometry beyond it cannot be sent to a client at all.`
          );
        }
      }
    }

    for (const object of document.objects) {
      const { x, y, z } = object.transform.position;
      if (Math.min(x, y, z) < POSITION_MIN_M || Math.max(x, y, z) > POSITION_MAX_M) {
        return (
          `"${object.id}" is outside the ±${POSITION_MAX_M} m the wire format can ` +
          `represent. Move it back inside the map.`
        );
      }
    }

    const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    if (bytes > MAP_DOCUMENT_WARN_BYTES * 8) {
      // Eight times the warning threshold is no longer a large map, it is a
      // document that will be read on every instance allocation and sent to
      // every client.
      return (
        `This document is ${(bytes / 1024).toFixed(0)} KB, far past what a map should be. ` +
        `Split it, or reuse assets instead of duplicating geometry.`
      );
    }

    return null;
  }

  /** The Rules' "portals authored here must resolve to valid Maps/spawns; broken
   *  targets must be flagged in the editor". Same-map targets are checked by the
   *  document schema itself; this is the cross-map half, which only the
   *  catalogue can answer. */
  private brokenPortals(document: MapDocument): { zoneId: string; targetMapId: string }[] {
    const broken: { zoneId: string; targetMapId: string }[] = [];
    for (const zone of document.zones) {
      const target = zone.properties.target?.mapId;
      if (!target) continue;
      if (target === document.id) continue;
      const destination = this.registry.resolve(target);
      if (!destination || destination.archivedAt) {
        broken.push({ zoneId: zone.id, targetMapId: target });
      }
    }
    return broken;
  }

  private async require(mapId: string): Promise<{ row: MapEntity; map: MapRecord }> {
    if (!this.maps || !this.versions) {
      throw new RegistryError(
        'unavailable',
        'The editor needs a database, and this server is running without one.',
      );
    }

    const map = this.registry.byId(mapId) ?? this.registry.resolve(mapId);
    if (!map) throw new RegistryError('not-found', 'That map does not exist.');

    const row = await this.maps.findOne({
      where: { id: map.id, spaceId: this.registry.currentSpace.id },
    });
    if (!row) throw new RegistryError('not-found', 'That map does not exist.');

    return { row, map };
  }
}
