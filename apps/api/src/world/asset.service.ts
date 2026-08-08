/**
 * `DC-9.3 Asset`, `DC-9.4 Asset Library` — `FR-9.11`–`FR-9.15`.
 *
 * The library a Map is built from: what is in it, how something gets into it,
 * and what stops something leaving it while a room still stands on it.
 *
 * ── Uploads are three steps, and the middle one is not ours ─────────────────
 *
 *   1. `requestUpload` writes a `pending` row and signs a `PUT`.
 *   2. The **client** sends the bytes straight to object storage. They never
 *      pass through this process, which is running a 20 Hz world tick.
 *   3. `completeUpload` checks the object actually arrived, at the size it
 *      claimed, and queues the pipeline.
 *
 * A row written before the bytes is deliberate: without it there is nothing for
 * an abandoned upload to be, and the library would silently accumulate objects
 * in a bucket that nothing references. A `pending` row that never completes is
 * visible, and is something an administrator can delete.
 *
 * ── Built-ins are files, not uploads ────────────────────────────────────────
 *
 * `FR-9.15` requires a Map to be buildable with no uploads at all, and the only
 * way that is true on a server with no object storage is for the default set to
 * be *files in the repository*, served statically beside the world assets. They
 * are seeded as rows so the library is one list rather than two, and they carry
 * `builtIn` so a delete can refuse them — a Space that could empty its own
 * library is a Space somebody can make unusable.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  ASSET_MAX_BYTES,
  type AssetDto,
  type AssetUploadRequest,
  type AssetUploadTicketDto,
} from '@hubitat/protocol';
import { In, type DataSource, type Repository } from 'typeorm';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import { AssetEntity } from './asset.entities.js';
import { MapEntity, MapVersionEntity } from './map.entities.js';
import { MapRegistry, RegistryError } from './map-registry.service.js';
import { assetsRoot } from './map.service.js';
import { JobQueueService } from './job-queue.service.js';
import { StorageService } from './storage.service.js';

/** Where the built-in set lives, relative to `assets/`. Served statically by
 *  `main.ts` at `/assets/library/…`, like the world GLBs. */
const LIBRARY_DIR = 'library';

@Injectable()
export class AssetService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AssetService.name);
  private readonly config: RuntimeConfig = loadConfig();

  private readonly assets: Repository<AssetEntity> | null;
  private readonly maps: Repository<MapEntity> | null;
  private readonly versions: Repository<MapVersionEntity> | null;

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly registry: MapRegistry,
    private readonly storage: StorageService,
    private readonly jobs: JobQueueService,
  ) {
    this.assets = dataSource ? dataSource.getRepository(AssetEntity) : null;
    this.maps = dataSource ? dataSource.getRepository(MapEntity) : null;
    this.versions = dataSource ? dataSource.getRepository(MapVersionEntity) : null;
  }

  get enabled(): boolean {
    return this.assets !== null;
  }

  /** Whether anything can be *uploaded*. Distinct from `enabled`: a Space with a
   *  database and no object storage still has a library, it just cannot grow. */
  get uploadsEnabled(): boolean {
    return this.enabled && this.storage.enabled;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.seedBuiltIns();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.14 — browsing
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The library, with a usable URL on everything that is ready.
   *
   * URLs are minted per read rather than stored, because a presigned one
   * expires — a stored URL in a Map Document would be a broken link with a
   * date on it. Built-ins have static paths and need no signing at all.
   */
  async list(): Promise<AssetDto[]> {
    if (!this.assets) return [];
    const space = this.registry.currentSpace;

    const rows = await this.assets.find({
      where: { spaceId: space.id },
      order: { builtIn: 'DESC', name: 'ASC' },
    });

    const usage = await this.usageCounts(rows.map((row) => row.slug));
    return Promise.all(rows.map((row) => this.toDto(row, usage.get(row.slug) ?? 0)));
  }

  /** Resolve the assets one Map Document references, for the runtime client.
   *  Public — a placed object is world geometry, exactly as the map's own GLB
   *  is, and gating it behind a credential the world loader does not have would
   *  make rooms render empty. */
  async resolveForMap(mapId: string): Promise<{ id: string; slug: string; url: string }[]> {
    const map = this.registry.resolve(mapId) ?? this.registry.byId(mapId);
    if (!map || !this.assets) return [];

    const referenced = new Set(map.document.objects.map((object) => object.assetId));
    if (referenced.size === 0) return [];

    const rows = await this.assets.find({
      where: { spaceId: this.registry.currentSpace.id, slug: In([...referenced]) },
    });

    const resolved: { id: string; slug: string; url: string }[] = [];
    for (const row of rows) {
      if (row.status !== 'ready') continue;
      const url = await this.urlFor(row);
      if (url) resolved.push({ id: row.id, slug: row.slug, url });
    }
    return resolved;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.11, FR-9.12 — uploading
  // ───────────────────────────────────────────────────────────────────────────

  async requestUpload(
    input: AssetUploadRequest,
    createdBy: string | null,
  ): Promise<AssetUploadTicketDto> {
    if (!this.assets) {
      throw new RegistryError(
        'unavailable',
        'Uploading assets needs a database, and this server is running without one.',
      );
    }
    if (!this.storage.enabled) {
      throw new RegistryError(
        'unavailable',
        'Uploading assets needs object storage. Set MINIO_ENDPOINT, or build maps from the ' +
          'built-in library (FR-9.15).',
      );
    }

    // `FR-9.12`, the half that can be answered before a byte moves. The worker
    // checks everything that needs the file parsed; this checks what the client
    // has already told us, so an oversized upload is refused in milliseconds
    // rather than after four minutes of transfer.
    if (input.bytes > ASSET_MAX_BYTES) {
      throw new RegistryError(
        'invalid',
        `That file is ${megabytes(input.bytes)} MB. The limit is ${megabytes(ASSET_MAX_BYTES)} MB.`,
      );
    }
    const typeProblem = this.checkContentType(input);
    if (typeProblem) throw new RegistryError('invalid', typeProblem);

    const space = this.registry.currentSpace;
    const slug = await this.uniqueSlug(space.id, input.name);
    // The key carries the space and a fresh uuid: two uploads of `chair.glb`
    // must not overwrite one another, and a key derived from the name alone
    // would let the second one silently replace the first.
    const storageKey = `spaces/${space.id}/assets/${randomUUID()}/${sanitizeFilename(input.name)}`;

    const ticket = await this.storage.presignUpload(storageKey, input.contentType);
    if (!ticket) throw new RegistryError('unavailable', 'Object storage is not available.');

    const row = await this.assets.save(
      this.assets.create({
        spaceId: space.id,
        kind: input.kind,
        name: input.name,
        slug,
        status: 'pending',
        storageKey,
        contentType: input.contentType,
        bytes: String(input.bytes),
        triangles: 0,
        error: null,
        lods: [],
        thumbnailKey: null,
        builtIn: false,
        createdBy,
      }),
    );

    return {
      asset: await this.toDto(row, 0),
      uploadUrl: ticket.url,
      expiresInSeconds: this.config.assetUrlTtlSeconds,
      headers: ticket.headers,
    };
  }

  /**
   * The bytes have landed — check, then queue.
   *
   * The size is verified against the object rather than trusted from the client:
   * the presign call signed a URL, not a promise, and a client that declared 1 MB
   * and sent 400 is a client that has bypassed `FR-9.12`'s cheap check. Refusing
   * here is the expensive one, and it is the one that holds.
   */
  async completeUpload(assetId: string): Promise<AssetDto> {
    if (!this.assets) throw new RegistryError('unavailable', 'No database.');

    const row = await this.assets.findOne({
      where: { id: assetId, spaceId: this.registry.currentSpace.id },
    });
    if (!row) throw new RegistryError('not-found', 'That asset does not exist.');

    const object = await this.storage.describe(row.storageKey);
    if (!object) {
      await this.reject(row, 'The upload did not arrive. Try again.');
      return this.toDto(row, 0);
    }
    if (object.bytes > ASSET_MAX_BYTES) {
      await this.storage.remove(row.storageKey);
      await this.reject(
        row,
        `That file is ${megabytes(object.bytes)} MB. The limit is ${megabytes(ASSET_MAX_BYTES)} MB.`,
      );
      return this.toDto(row, 0);
    }

    row.bytes = String(object.bytes);

    // `FR-9.13` — the pipeline, in another process. When there is none, the
    // asset is usable exactly as it arrived and says so, rather than sitting at
    // `pending` for the life of the deployment waiting for a worker that does
    // not exist.
    const queued =
      row.kind === 'model'
        ? await this.jobs.enqueueOptimize({
            assetId: row.id,
            spaceId: row.spaceId,
            storageKey: row.storageKey,
            kind: row.kind,
          })
        : false;

    row.status = queued ? 'processing' : 'ready';
    await this.assets.save(row);

    this.logger.log(
      `Asset "${row.slug}" uploaded (${megabytes(object.bytes)} MB)` +
        `${queued ? ' — queued for optimization' : ' — usable as uploaded'}.`,
    );
    return this.toDto(row, 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-9.14 — removal, with the safeguard
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Delete an asset, unless something is standing on it.
   *
   * **Blocked, not warned.** The Rules are explicit — "removing an asset still
   * referenced by a Map must be prevented or clearly warned, and must not break
   * published Maps" — and warn-and-allow does break them: the room renders with
   * a hole in it and the only record of what used to be there is a slug in a
   * document. Archiving the Map is how somebody who genuinely wants it gone gets
   * there.
   *
   * "In use" spans **drafts as well as published versions**. An asset placed in
   * a draft and then deleted would leave an author with a room that cannot be
   * published, which is the same broken outcome one step earlier.
   */
  async remove(assetId: string): Promise<void> {
    if (!this.assets) throw new RegistryError('unavailable', 'No database.');

    const row = await this.assets.findOne({
      where: { id: assetId, spaceId: this.registry.currentSpace.id },
    });
    if (!row) throw new RegistryError('not-found', 'That asset does not exist.');

    if (row.builtIn) {
      throw new RegistryError(
        'invalid',
        'Built-in assets cannot be removed — they are what guarantees a map can always be ' +
          'built here (FR-9.15).',
      );
    }

    const usage = await this.usageCounts([row.slug]);
    const count = usage.get(row.slug) ?? 0;
    if (count > 0) {
      throw new RegistryError(
        'conflict',
        `"${row.name}" is placed in ${count} map${count === 1 ? '' : 's'}. Remove it from ` +
          `them first — deleting it would leave a hole in a room somebody is standing in.`,
      );
    }

    await this.storage.remove(row.storageKey);
    for (const lod of row.lods) {
      // The variant keys are derived from the original, and the worker wrote
      // them; removing the row without them would leak storage nothing points at.
      const key = keyFromUrlPath(lod.url);
      if (key) await this.storage.remove(key);
    }
    await this.assets.delete({ id: row.id });
    this.logger.log(`Asset "${row.slug}" removed.`);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `FR-9.15` — the built-in set, seeded from files in the repository.
   *
   * By slug and only for slugs that are absent, exactly like `MapRegistry`'s
   * disk seeding and for the same reason: adding a file to the repository adds
   * an asset to a fresh deployment and does nothing to an established one, so a
   * built-in that somebody renamed is never resurrected.
   */
  private async seedBuiltIns(): Promise<void> {
    if (!this.assets) return;

    // Nest gives no ordering guarantee between two providers' bootstrap hooks,
    // and every row written here is keyed by *this* Space. Without this wait the
    // seed can run against the placeholder id the registry starts with, which
    // fails as an unreadable uuid syntax error at boot.
    await this.registry.whenReady();

    const root = join(assetsRoot(), LIBRARY_DIR);
    if (!existsSync(root)) {
      this.logger.warn(
        `No built-in asset library at ${root}. Run "node assets/library/build-library.mjs" — ` +
          `without it a map can only be built from uploads (FR-9.15).`,
      );
      return;
    }

    const space = this.registry.currentSpace;
    const files = readdirSync(root).filter((name) => name.endsWith('.glb'));
    const existing = await this.assets.find({ where: { spaceId: space.id, builtIn: true } });
    const known = new Set(existing.map((row) => row.slug));

    let seeded = 0;
    for (const file of files.sort()) {
      const slug = file.slice(0, -'.glb'.length);
      if (known.has(slug)) continue;

      await this.assets.save(
        this.assets.create({
          spaceId: space.id,
          kind: 'model',
          name: titleize(slug),
          slug,
          status: 'ready',
          // A path rather than an object key. Built-ins are served statically
          // beside the world GLBs, which is what makes them work on a server
          // with no object storage at all.
          storageKey: `/assets/${LIBRARY_DIR}/${file}`,
          contentType: 'model/gltf-binary',
          bytes: '0',
          triangles: 0,
          error: null,
          lods: [],
          thumbnailKey: null,
          builtIn: true,
          createdBy: null,
        }),
      );
      seeded++;
    }

    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} built-in asset(s) from assets/${LIBRARY_DIR} (FR-9.15).`);
    }
  }

  /**
   * How many Maps reference each of these assets.
   *
   * One query over `map_versions` and one over the drafts, both containment
   * tests against `jsonb`. There is no foreign key to lean on — the reference
   * lives *inside* a document — so this is the explicit scan ADR 0008's blob
   * storage costs, and the GIN indexes are what keep it from being a full scan.
   */
  private async usageCounts(slugs: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!this.versions || !this.maps || slugs.length === 0) return counts;

    const spaceId = this.registry.currentSpace.id;

    for (const slug of slugs) {
      const probe = JSON.stringify({ objects: [{ assetId: slug }] });

      const published = await this.versions.query<{ count: string }[]>(
        `SELECT COUNT(DISTINCT v."map_id")::text AS "count"
           FROM "map_versions" v
           JOIN "maps" m ON m."id" = v."map_id"
          WHERE m."space_id" = $1 AND v."document" @> $2::jsonb`,
        [spaceId, probe],
      );

      const drafts = await this.maps.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS "count"
           FROM "maps"
          WHERE "space_id" = $1
            AND "draft_document" IS NOT NULL
            AND "draft_document" @> $2::jsonb`,
        [spaceId, probe],
      );

      counts.set(slug, Number(published[0]?.count ?? 0) + Number(drafts[0]?.count ?? 0));
    }

    return counts;
  }

  private async reject(row: AssetEntity, reason: string): Promise<void> {
    if (!this.assets) return;
    row.status = 'rejected';
    row.error = reason;
    await this.assets.save(row);
    this.logger.warn(`Asset "${row.slug}" rejected: ${reason}`);
  }

  /**
   * `FR-9.12`, the cheapest check there is.
   *
   * A closed list rather than a sniff, because the point is to refuse a video
   * file named `.glb` before four minutes of upload rather than after. The
   * worker parses what actually arrives, which is the check that holds.
   */
  private checkContentType(input: AssetUploadRequest): string | null {
    const allowed: Record<string, readonly string[]> = {
      model: ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream'],
      texture: ['image/png', 'image/jpeg', 'image/webp', 'image/ktx2'],
      thumbnail: ['image/png', 'image/jpeg', 'image/webp'],
    };
    const list = allowed[input.kind] ?? [];
    if (list.includes(input.contentType)) return null;
    return `A ${input.kind} cannot be "${input.contentType}". Accepted: ${list.join(', ')}.`;
  }

  private async uniqueSlug(spaceId: string, name: string): Promise<string> {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'asset';

    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const clash = await this.assets!.findOne({ where: { spaceId, slug } });
      if (!clash) return slug;
    }
  }

  private async urlFor(row: AssetEntity): Promise<string | null> {
    // Built-ins are static paths and are never signed — which is exactly what
    // lets them work with no object storage configured.
    if (row.storageKey.startsWith('/')) return row.storageKey;
    return this.storage.presignDownload(row.storageKey);
  }

  private async toDto(row: AssetEntity, usedByMaps: number): Promise<AssetDto> {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      slug: row.slug,
      status: row.status,
      url: row.status === 'ready' ? await this.urlFor(row) : null,
      thumbnailUrl: row.thumbnailKey ? await this.storage.presignDownload(row.thumbnailKey) : null,
      bytes: Number(row.bytes),
      triangles: row.triangles,
      lods: row.lods,
      error: row.error,
      usedByMaps,
      builtIn: row.builtIn,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
    };
  }
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'asset.bin';
}

function titleize(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The object key inside a presigned URL, for cleaning up variants. Presigned
 *  URLs carry the key in their path; anything else is a static built-in and has
 *  nothing to delete. */
function keyFromUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // `/<bucket>/<key…>` — path-style, which is how the client is configured.
    return parts.length > 1 ? parts.slice(1).join('/') : null;
  } catch {
    return null;
  }
}
