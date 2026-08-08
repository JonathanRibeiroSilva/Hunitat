/**
 * The Space and the Maps in it — `DC-8.1`, `DC-8.2`, `FR-8.1`–`FR-8.3`,
 * `FR-8.15`–`FR-8.17`.
 *
 * One catalogue, read by everything that needs to know what a Map *is*: the
 * world runtime allocating an instance, the portal resolver turning
 * `{ mapId, spawnId }` into a place, the directory counting heads, and the
 * management endpoints.
 *
 * ── Three states, and all three are supported ───────────────────────────────
 *
 *   **No database.** The catalogue is whatever is in `assets/world`, ids are
 *   slugs, and nothing can be created or archived — the management endpoints say
 *   so rather than pretending. This is the README's development flow and it is
 *   not a degraded mode nobody tests: it is how phases 1–5 ran, and multi-map
 *   works in it exactly as it does with a database, minus the ability to change
 *   the catalogue at runtime.
 *
 *   **Database, first boot.** Every document on disk is seeded as a Map with its
 *   first version, and the Space's landing Map is set to `WORLD_MAP_ID`. From
 *   this moment the database is authoritative.
 *
 *   **Database, later boots.** Disk is read for documents whose *slug is not
 *   already a Map*, and nothing else. Dropping a file into `assets/world` adds a
 *   Map to a fresh deployment and does nothing to an established one — which is
 *   right for both, and is the same relationship `SPACE_ALLOW_GUESTS` has with
 *   `spaces.allow_guests`: configuration seeds, the database decides.
 *
 * ── One live Space per process ──────────────────────────────────────────────
 *
 * `FR-8.15` asks for creating Spaces and this does create them — durable rows,
 * with an owner, archivable and deletable. What one process does not do is
 * *serve* more than one at a time: it runs the Space named by `SPACE_SLUG`, and
 * entering a different one means pointing a deployment at it.
 *
 * That is a real limit and it is stated rather than hidden. Access policy, bans,
 * roles and chat history are all Space-scoped singletons resolved once at the
 * door (phases 6 and 7), and making them per-connection would be a rewrite of
 * two phases to support a case — several tenants in one process — that ADR 0009
 * explicitly declined when it put live state in process memory.
 *
 * ── Documents are cached in memory, deliberately ────────────────────────────
 *
 * A Map Document is read on every instance allocation and on every portal
 * traversal, is a few kilobytes of `jsonb`, and changes when somebody publishes
 * an edit. Reading it from Postgres each time would put a query inside the
 * world tick. The cache is written through by every mutation here, which is what
 * keeps it honest — the same arrangement `SpaceService` has with its row.
 */

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  instanceIdOf,
  mapDocumentSchema,
  type BrokenPortalDto,
  type InstancingPolicy,
  type MapCreateRequest,
  type MapDocument,
  type MapUpdateRequest,
  type OverflowRule,
  type SpaceCreateRequest,
  type SpaceRecordDto,
  type SpaceSettingsUpdate,
} from '@hubitat/protocol';
import { In, type DataSource, type Repository } from 'typeorm';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';
import { DATA_SOURCE } from '../persistence/database.js';
import { SpaceEntity } from '../auth/auth.entities.js';
import { SpaceService } from '../auth/space.service.js';
import { MapEntity, MapVersionEntity } from './map.entities.js';
import { MapService } from './map.service.js';

/**
 * A Map as everything upstream of the database sees it.
 *
 * Flattened across `maps` and `map_versions` on purpose: every reader wants the
 * metadata *and* the document, none of them wants a join, and a lazy relation
 * would put a query on the world tick the first time somebody forgot to load it.
 */
export interface MapRecord {
  /** A uuid with a database, the slug without one. Opaque to every caller. */
  id: string;
  slug: string;
  name: string;
  capacity: number | null;
  instancing: InstancingPolicy;
  overflow: OverflowRule;
  archivedAt: Date | null;
  sortIndex: number;
  version: number;
  document: MapDocument;
}

/** The Space this process is serving. */
export interface SpaceRecord {
  id: string;
  slug: string;
  name: string;
  ownerAccountId: string | null;
  defaultMapId: string | null;
  archivedAt: Date | null;
  /** `FR-7.14` — the Space's own ceiling, or null for `DEFAULT_MAP_CAPACITY`.
   *  Cached here so `capacityOf` is synchronous: it is called from instance
   *  assignment, which runs on the join path and inside the tick, and neither is
   *  a place to await a row. Written through by `AccessPolicyService.update`
   *  reloading the registry. */
  capacity: number | null;
}

/** Refusals the management endpoints turn into HTTP status codes, and the
 *  gateway into `ERROR` frames. `code` is what a caller branches on; `message`
 *  is what a person reads. */
export interface RegistryRefusal {
  code: 'unavailable' | 'not-found' | 'conflict' | 'invalid' | 'last-map';
  message: string;
}

export class RegistryError extends Error implements RegistryRefusal {
  constructor(
    readonly code: RegistryRefusal['code'],
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class MapRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(MapRegistry.name);
  private readonly config: RuntimeConfig = loadConfig();

  private readonly mapRows: Repository<MapEntity> | null;
  private readonly versionRows: Repository<MapVersionEntity> | null;
  private readonly spaceRows: Repository<SpaceEntity> | null;

  /** Insertion-ordered by `sortIndex` then slug, so `list()` never sorts and the
   *  directory is stable between refreshes. */
  private catalogue: MapRecord[] = [];
  private space: SpaceRecord = {
    id: 'local',
    slug: 'default',
    name: 'hubitat',
    ownerAccountId: null,
    defaultMapId: null,
    archivedAt: null,
    capacity: null,
  };

  /** Fires whenever the catalogue changes shape — a Map created, archived,
   *  renamed or deleted. The world runtime subscribes to evict people from a Map
   *  that has just gone away (`FR-8.18`) and to re-push the directory. */
  private readonly listeners = new Set<(reason: CatalogueChange) => void>();

  /**
   * Resolves once the catalogue has been read for the first time.
   *
   * Nest gives no ordering guarantee between two providers' bootstrap hooks, and
   * `AssetService` seeds rows keyed by *this* Space — so without something to
   * wait on it can run first and write against the placeholder id this class
   * starts with. An explicit promise rather than a provider ordering, because an
   * ordering is a comment somebody has to preserve and this is a fact the code
   * can check.
   */
  private readonly readySignal: { promise: Promise<void>; resolve: () => void } = createSignal();

  constructor(
    @Inject(DATA_SOURCE) dataSource: DataSource | null,
    private readonly maps: MapService,
    private readonly spaces: SpaceService,
  ) {
    this.mapRows = dataSource ? dataSource.getRepository(MapEntity) : null;
    this.versionRows = dataSource ? dataSource.getRepository(MapVersionEntity) : null;
    this.spaceRows = dataSource ? dataSource.getRepository(SpaceEntity) : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reload({ seed: true });
    this.readySignal.resolve();

    const live = this.list().filter((map) => !map.archivedAt);
    this.logger.log(
      `Space "${this.space.slug}" (${this.space.name}) holds ${live.length} map(s): ` +
        `${live.map((map) => (map.id === this.space.defaultMapId ? `${map.slug}*` : map.slug)).join(', ')} ` +
        `— * is the landing map (FR-8.7).`,
    );

    if (!this.persistent) {
      this.logger.log(
        'No database — the map catalogue is read-only and comes from assets/world. ' +
          'Portals between maps, instancing and the directory all work; creating and ' +
          'archiving maps needs a database.',
      );
    }
  }

  /** Whether the catalogue can be changed at runtime. False is a supported
   *  state, not a failure — see the header. */
  get persistent(): boolean {
    return this.mapRows !== null;
  }

  /** Awaited by anything that bootstraps against this Space. See `readySignal`. */
  whenReady(): Promise<void> {
    return this.readySignal.promise;
  }

  onChange(listener: (reason: CatalogueChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reading
  // ───────────────────────────────────────────────────────────────────────────

  get currentSpace(): SpaceRecord {
    return this.space;
  }

  /** Every Map in the Space, archived ones included. Callers that mean "places
   *  somebody can be" filter on `archivedAt`, which is deliberate: the directory
   *  and the management screen want different answers and a method that returned
   *  only one of them would be silently wrong for the other. */
  list(): readonly MapRecord[] {
    return this.catalogue;
  }

  live(): MapRecord[] {
    return this.catalogue.filter((map) => map.archivedAt === null);
  }

  byId(id: string): MapRecord | undefined {
    return this.catalogue.find((map) => map.id === id);
  }

  /**
   * A portal's `mapId`, resolved — `FR-8.5`.
   *
   * Accepts a slug or an id, and prefers the slug. A cross-map portal is
   * authored by hand into a Map Document (`portalTargetSchema`), so what a person
   * types there is `atrium`, not a uuid they would have to look up — and the
   * document is copied between Spaces, where a uuid would resolve to nothing or,
   * worse, to something.
   *
   * Archived Maps resolve, and the caller decides. A portal into an archived Map
   * must refuse with "that room is closed" rather than with "no such room": the
   * first is true and actionable, the second sends somebody looking for a
   * mistake in the map file.
   */
  resolve(reference: string | undefined): MapRecord | undefined {
    if (!reference) return undefined;
    return (
      this.catalogue.find((map) => map.slug === reference) ??
      this.catalogue.find((map) => map.id === reference)
    );
  }

  /**
   * `FR-8.7` — where somebody entering the Space lands.
   *
   * The configured landing Map when it is live, and otherwise the first live Map
   * in sort order. The fallback is not defensive tidiness: `spaces.default_map_id`
   * has no foreign key precisely so that deleting a Map cannot make the Space
   * unreadable, which means a dangling pointer is a state this function has to
   * have an answer for. Arriving somewhere sensible is what the requirement asks
   * for; a valid pointer is not.
   */
  landingMap(): MapRecord {
    const configured = this.space.defaultMapId ? this.byId(this.space.defaultMapId) : undefined;
    if (configured && !configured.archivedAt) return configured;

    const fallback = this.live()[0];
    if (!fallback) {
      // Unreachable in practice: `MapService.loadFromDisk` refuses to boot with
      // an empty catalogue, and `archiveMap` refuses to archive the last live
      // Map. Thrown rather than returning undefined because every caller would
      // have to invent the same answer, and the answer is "this Space is broken".
      throw new RegistryError(
        'not-found',
        'This space has no map anybody can enter. Restore one from the archive.',
      );
    }
    if (configured) {
      this.logger.warn(
        `The landing map of "${this.space.slug}" is archived or missing; falling back to ` +
          `"${fallback.slug}" (FR-8.7).`,
      );
    }
    return fallback;
  }

  /**
   * `FR-8.8` and `FR-7.14` — one capacity, resolved in one place.
   *
   * Three levels, most specific first: the Map's own, the Space's, then
   * `DEFAULT_MAP_CAPACITY` from configuration. The Phase 8 notes call this out as
   * sharp edge nº3 — capacity is checked at the Space door and again at instance
   * assignment, and if the two read different values they disagree about whether
   * somebody can come in. They do not, because both call this.
   */
  capacityOf(map: MapRecord): number {
    return map.capacity ?? this.space.capacity ?? this.config.defaultMapCapacity;
  }

  /** Where the client fetches this Map's document. Served by `MapController`
   *  rather than as a static file, because from phase 9 the document lives in
   *  `map_versions` and the file on disk is a seed rather than the truth. */
  documentUrl(map: MapRecord): string {
    return `/maps/${encodeURIComponent(map.id)}/document`;
  }

  /** The GLB, taken from the document rather than derived from configuration:
   *  the document is what says which geometry a Map is made of, and a second
   *  spelling would let the two disagree the moment a Map is copied. */
  geometryUrl(map: MapRecord): string {
    return map.document.geometry.url;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FR-8.15, FR-8.16, FR-8.17 — the lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async createMap(input: MapCreateRequest, createdBy: string | null): Promise<MapRecord> {
    this.requirePersistence('Creating a map');

    if (this.catalogue.some((map) => map.slug === input.slug)) {
      throw new RegistryError('conflict', `This space already has a map called "${input.slug}".`);
    }

    // Copy an existing Map, or start from the Space's landing Map. Either way a
    // new Map arrives with a document that is *already valid* — a Map with no
    // contents would be a room with no floor and no spawn, which `FR-8.7` has no
    // way to place anybody in.
    const source = input.copyFromMapId
      ? this.resolve(input.copyFromMapId)
      : (this.byId(this.space.defaultMapId ?? '') ?? this.live()[0]);
    if (!source) {
      throw new RegistryError('not-found', 'There is no map to copy contents from.');
    }

    // The document's own `id` must match the Map it belongs to, or a client that
    // trusts the document (the harness does, and phase 9's editor will) would
    // resolve portals against the wrong room.
    const document: MapDocument = { ...source.document, id: input.slug, name: input.name };

    const row = await this.mapRows!.save(
      this.mapRows!.create({
        spaceId: this.space.id,
        slug: input.slug,
        name: input.name,
        capacity: input.capacity ?? null,
        instancing: input.instancing ?? 'fill-then-spill',
        overflow: input.overflow ?? 'instance',
        currentVersionId: null,
        archivedAt: null,
        sortIndex: this.catalogue.length,
        createdBy,
      }),
    );

    await this.publishVersion(row.id, document, createdBy, 'created');

    if (input.makeDefault) {
      await this.patchSpaceRow({ defaultMapId: row.id });
    }

    await this.reload();
    this.announce({ kind: 'created', mapId: row.id });

    this.logger.log(`Map "${input.slug}" created in space "${this.space.slug}".`);
    return this.byId(row.id)!;
  }

  /**
   * `FR-8.16`, and `FR-8.17`'s archive half.
   *
   * Returns the Maps whose *occupants have to move*, rather than moving them:
   * this class knows nothing about live participants, and putting an eviction in
   * here would make the catalogue depend on the runtime that depends on it. The
   * caller — `WorldInstanceService`, through the change listener — does the
   * moving, which is `FR-8.18`.
   */
  async updateMap(mapId: string, patch: MapUpdateRequest): Promise<MapRecord> {
    this.requirePersistence('Configuring a map');

    const map = this.byId(mapId);
    if (!map) throw new RegistryError('not-found', 'That map does not exist.');

    // Typed to the four columns this touches rather than to `Partial<MapEntity>`.
    // The entity gained a `jsonb` document in phase 9, and TypeORM's deep-partial
    // recursion cannot express `Record<string, unknown>` inside it — so a broad
    // partial stops compiling for fields this method never writes.
    const fields: Partial<
      Pick<MapEntity, 'name' | 'capacity' | 'instancing' | 'overflow' | 'archivedAt'>
    > = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.capacity !== undefined) fields.capacity = patch.capacity;
    if (patch.instancing !== undefined) fields.instancing = patch.instancing;
    if (patch.overflow !== undefined) fields.overflow = patch.overflow;

    if (patch.archived !== undefined) {
      // The last live Map cannot be archived. `FR-8.7` requires an arrival to
      // land on a valid Map at a valid spawn, and a Space whose every Map is
      // archived is a Space nobody — including the administrator who would
      // un-archive one — can enter.
      if (patch.archived && this.live().filter((other) => other.id !== mapId).length === 0) {
        throw new RegistryError(
          'last-map',
          'This is the only map anybody can enter. Add another before archiving this one.',
        );
      }
      fields.archivedAt = patch.archived ? new Date() : null;
    }

    if (Object.keys(fields).length > 0) {
      await this.mapRows!.update({ id: mapId, spaceId: this.space.id }, fields);
    }

    if (patch.makeDefault) {
      if (fields.archivedAt) {
        throw new RegistryError(
          'invalid',
          'An archived map cannot be the one people land on (FR-8.7).',
        );
      }
      await this.patchSpaceRow({ defaultMapId: mapId });
    }

    await this.reload();

    // Archiving is what makes this a change people *feel*: `FR-8.18` requires
    // present participants to be notified and moved out rather than left in a
    // broken instance.
    this.announce(
      patch.archived === true ? { kind: 'archived', mapId } : { kind: 'updated', mapId },
    );
    return this.byId(mapId)!;
  }

  /**
   * `FR-8.17` — durable removal, and the Rules' dangling-portal check.
   *
   * The scan runs **before** the delete and its result is returned, not acted
   * on. A portal whose destination has gone is an authoring decision to make —
   * repoint it, remove it, or leave it refusing with a clear message — and
   * silently rewriting somebody's map to tidy up after an administrator is not
   * this phase's business. `usePortal` already refuses an unresolvable target
   * without swallowing the participant (Phase 3 Rules), so a dangling portal is
   * a flagged nuisance rather than a trap.
   */
  async deleteMap(mapId: string): Promise<{ brokenPortals: BrokenPortalDto[] }> {
    this.requirePersistence('Deleting a map');

    const map = this.byId(mapId);
    if (!map) throw new RegistryError('not-found', 'That map does not exist.');

    if (this.live().filter((other) => other.id !== mapId).length === 0) {
      throw new RegistryError(
        'last-map',
        'This is the only map anybody can enter. Add another before deleting this one.',
      );
    }

    const brokenPortals = this.portalsTargeting(map);

    // Versions cascade from the row. The Space's landing pointer does not — it
    // has no foreign key on purpose — so it is cleared here rather than left
    // dangling for `landingMap()` to warn about on every boot.
    await this.mapRows!.delete({ id: mapId, spaceId: this.space.id });
    if (this.space.defaultMapId === mapId) {
      await this.patchSpaceRow({ defaultMapId: null });
    }

    await this.reload();
    this.announce({ kind: 'deleted', mapId });

    this.logger.log(
      `Map "${map.slug}" deleted from space "${this.space.slug}"` +
        `${brokenPortals.length > 0 ? `; ${brokenPortals.length} portal(s) now point nowhere` : ''}.`,
    );
    return { brokenPortals };
  }

  /**
   * Every portal in the Space that names a Map — the Rules' explicit query.
   *
   * `jsonb` gives no foreign key, so this is a scan of the documents rather than
   * a constraint. It runs over the in-memory catalogue rather than over Postgres
   * because the catalogue *is* the set of current versions and is already in
   * memory; the GIN index in the migration is there for the day phase 9 makes
   * this a query over history.
   */
  portalsTargeting(target: MapRecord): BrokenPortalDto[] {
    const broken: BrokenPortalDto[] = [];
    for (const map of this.catalogue) {
      if (map.id === target.id) continue;
      for (const zone of map.document.zones) {
        const reference = zone.properties.target?.mapId;
        if (!reference) continue;
        if (reference !== target.slug && reference !== target.id) continue;
        broken.push({
          mapId: map.id,
          mapName: map.name,
          zoneId: zone.id,
          targetMapId: reference,
        });
      }
    }
    return broken;
  }

  /** Every portal in the Space pointing at a Map that does not exist — what the
   *  management screen shows so an administrator can see the damage a previous
   *  delete left, rather than only the damage the next one would cause. */
  brokenPortals(): BrokenPortalDto[] {
    const broken: BrokenPortalDto[] = [];
    for (const map of this.catalogue) {
      for (const zone of map.document.zones) {
        const reference = zone.properties.target?.mapId;
        if (!reference) continue;
        if (this.resolve(reference)) continue;
        broken.push({
          mapId: map.id,
          mapName: map.name,
          zoneId: zone.id,
          targetMapId: reference,
        });
      }
    }
    return broken;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Spaces — FR-8.15, FR-8.16, FR-8.17
  //
  // Durable rows, created and retired here. What this process *serves* is still
  // the one Space named by `SPACE_SLUG` — see the header.
  // ───────────────────────────────────────────────────────────────────────────

  async createSpace(
    input: SpaceCreateRequest,
    ownerAccountId: string | null,
  ): Promise<SpaceRecord> {
    this.requirePersistence('Creating a space');

    const existing = await this.spaceRows!.findOne({ where: { slug: input.slug } });
    if (existing) {
      throw new RegistryError('conflict', `A space called "${input.slug}" already exists.`);
    }

    const row = await this.spaceRows!.save(
      this.spaceRows!.create({
        slug: input.slug,
        name: input.name,
        // `FR-8.1` — a Space is owned by an account, and the creator is it. A
        // Space with no owner has nobody who can appoint one, which is the same
        // rule `RolesService` applies to the founding member of the first Space.
        ownerAccountId,
        allowGuests: this.config.spaceAllowGuests,
        locked: false,
        accessPasswordHash: null,
        allowlistEnabled: false,
        capacity: null,
        defaultMapId: null,
        archivedAt: null,
      }),
    );

    this.logger.log(
      `Space "${input.slug}" created. This process serves "${this.space.slug}"; point a ` +
        `deployment at SPACE_SLUG=${input.slug} to run it.`,
    );

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      ownerAccountId: row.ownerAccountId,
      defaultMapId: row.defaultMapId,
      archivedAt: row.archivedAt,
      capacity: row.capacity,
    };
  }

  /**
   * Re-read the Space row after somebody changed it elsewhere.
   *
   * `AccessPolicyService` owns `spaces.capacity` (`FR-7.14`) and writes it
   * through its own cache; this registry caches the same row for `capacityOf`,
   * which has to be synchronous because it is called from instance assignment
   * on the join path and inside the tick. Two caches of one row is one too many
   * unless something reconciles them, and this is that something.
   */
  async refreshSpace(): Promise<void> {
    if (!this.spaceRows) return;
    await this.reload();
  }

  /**
   * Re-read the catalogue, and tell the runtime what happened — phase 9.
   *
   * `EditorService` owns drafts and versions and writes `maps.current_version_id`
   * on publish; this is how that write becomes the document the next instance
   * reads and the `MAP_UPDATED` frame the people already inside see
   * (`FR-9.20`). Kept here rather than duplicated there, because the catalogue's
   * cache and its listeners are this class's to keep honest.
   */
  async refreshAfterPublish(change: CatalogueChange): Promise<void> {
    await this.reload();
    this.announce(change);
  }

  async updateSpace(patch: SpaceSettingsUpdate): Promise<SpaceRecord> {
    this.requirePersistence('Configuring a space');

    const fields: Partial<SpaceEntity> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.archived !== undefined) fields.archivedAt = patch.archived ? new Date() : null;

    if (patch.defaultMapId !== undefined) {
      const map = this.resolve(patch.defaultMapId);
      if (!map) throw new RegistryError('not-found', 'That map does not exist.');
      if (map.archivedAt) {
        throw new RegistryError(
          'invalid',
          'An archived map cannot be the one people land on (FR-8.7).',
        );
      }
      fields.defaultMapId = map.id;
    }

    await this.patchSpaceRow(fields);
    await this.reload();
    this.announce(patch.archived === true ? { kind: 'space-archived' } : { kind: 'updated' });
    return this.space;
  }

  /**
   * `FR-8.17` — durable removal of a Space.
   *
   * Everything inside it goes with it: `maps` and `map_versions` cascade from the
   * row, and so do memberships, invites, bans, reports and the audit log
   * (`ON DELETE CASCADE`, from phases 6 and 7). Deleting the Space this process
   * is serving is refused — there would be nowhere for the people standing in it
   * to be moved to, and the requirement's "handles currently-present
   * participants gracefully" has no graceful answer for "the building is gone
   * and so is every other building".
   */
  async deleteSpace(slug: string): Promise<void> {
    this.requirePersistence('Deleting a space');

    if (slug === this.space.slug) {
      throw new RegistryError(
        'invalid',
        'This is the space this server is running. Archive it instead, or point the ' +
          'deployment at another space before deleting it.',
      );
    }

    const row = await this.spaceRows!.findOne({ where: { slug } });
    if (!row) throw new RegistryError('not-found', 'That space does not exist.');

    await this.spaceRows!.delete({ id: row.id });
    this.logger.log(`Space "${slug}" deleted, with every map and record in it.`);
  }

  async listSpaces(): Promise<SpaceRecordDto[]> {
    if (!this.spaceRows) {
      return [
        {
          id: this.space.id,
          slug: this.space.slug,
          name: this.space.name,
          ownerAccountId: null,
          ownerName: null,
          defaultMapId: this.space.defaultMapId,
          archivedAt: null,
          memberCount: 0,
          occupancy: 0,
        },
      ];
    }

    const rows = await this.spaceRows.find({ order: { createdAt: 'ASC' } });
    const counts = await this.spaceRows.query<{ space_id: string; count: string }[]>(
      `SELECT "space_id", COUNT(*)::text AS "count" FROM "memberships" GROUP BY "space_id"`,
    );
    const bySpace = new Map(counts.map((row) => [row.space_id, Number(row.count)]));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      ownerAccountId: row.ownerAccountId,
      ownerName: null,
      defaultMapId: row.defaultMapId,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      memberCount: bySpace.get(row.id) ?? 0,
      // Filled in by the caller, which is the only party that can see the live
      // registry. Zero here rather than a lie.
      occupancy: 0,
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Documents — the storage half of DC-9.1
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Write a new version and make it current.
   *
   * Insert-then-point, never update-in-place. A running instance holds the
   * document it started with, so publishing while somebody is standing in a Map
   * changes what the *next* instance reads rather than mutating the world under
   * the feet of the one that exists — which is what phase 9 needs, and what makes
   * "revert to the previous version" a pointer move rather than an archaeology
   * project.
   */
  async publishVersion(
    mapId: string,
    document: MapDocument,
    createdBy: string | null,
    notes?: string,
  ): Promise<number> {
    this.requirePersistence('Publishing a map version');

    const parsed = mapDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new RegistryError('invalid', `That map document is not valid: ${parsed.error.message}`);
    }

    const latest = await this.versionRows!.findOne({
      where: { mapId },
      order: { version: 'DESC' },
    });
    const version = (latest?.version ?? 0) + 1;

    const row = await this.versionRows!.save(
      this.versionRows!.create({
        mapId,
        version,
        document: parsed.data,
        createdBy,
        notes: notes ?? null,
      }),
    );

    await this.mapRows!.update({ id: mapId }, { currentVersionId: row.id });
    return version;
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Rebuild the catalogue from whatever the authority is.
   *
   * Wholesale rather than patched. It runs at boot and after each mutation — a
   * handful of times in the life of a process — and a patch would have to know
   * which of a dozen fields changed, which is a dozen more things to get wrong
   * than a query costs.
   */
  /**
   * Write to the `spaces` row **and** to the copy `SpaceService` is caching.
   *
   * `SpaceService.current()` returns a cached entity — it is consulted on every
   * join and changes roughly never — so a bare `update()` here would leave that
   * copy holding the old landing map for the life of the process, and `reload`
   * would read the stale one straight back. The same write-through
   * `AccessPolicyService.update` does, and for the same reason.
   */
  private async patchSpaceRow(fields: Partial<SpaceEntity>): Promise<void> {
    if (!this.spaceRows) return;
    const cached = await this.spaces.current();
    if (!cached) return;
    await this.spaceRows.update({ id: cached.id }, fields);
    Object.assign(cached, fields);
  }

  private async reload(options: { seed?: boolean } = {}): Promise<void> {
    if (!this.mapRows || !this.versionRows || !this.spaceRows) {
      this.catalogue = this.fromDisk();
      const starter =
        this.catalogue.find((map) => map.slug === this.maps.starterSlug) ?? this.catalogue[0];
      this.space = {
        id: 'local',
        slug: this.config.spaceSlug,
        name: this.config.spaceName,
        ownerAccountId: null,
        defaultMapId: starter?.id ?? null,
        archivedAt: null,
        capacity: null,
      };
      return;
    }

    // Seeding runs first and can write `default_map_id`, so the row is read
    // *after* it. Reading first and seeding second leaves this cache holding a
    // null landing map for the life of the process on a fresh database — the
    // directory would mark no room as the one people arrive in, and `FR-8.7`
    // would be satisfied only by the fallback in `landingMap`.
    if (options.seed) {
      const existing = await this.spaces.current();
      if (existing) await this.seedFromDisk(existing.id);
    }

    const row = await this.spaces.current();
    if (!row) {
      // The Space row is created by phase 6's migration and reconciled by
      // `SpaceService`. Missing means a mis-set `SPACE_SLUG`, which that service
      // already logs as an error; falling back to disk keeps the world running
      // rather than refusing to boot over a name.
      this.catalogue = this.fromDisk();
      return;
    }

    this.space = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      ownerAccountId: row.ownerAccountId,
      defaultMapId: row.defaultMapId,
      archivedAt: row.archivedAt,
      capacity: row.capacity,
    };

    const maps = await this.mapRows.find({
      where: { spaceId: row.id },
      order: { sortIndex: 'ASC', slug: 'ASC' },
    });

    // `In(...)` rather than an array of `where` objects: TypeORM reads an *empty*
    // array as "no condition" and returns every row in the table, so a Space
    // whose Maps all lack a published version would load every document ever
    // written. The explicit empty case below is what makes that unrepresentable.
    const versionIds = maps
      .map((map) => map.currentVersionId)
      .filter((id): id is string => id !== null);
    const versions =
      versionIds.length > 0 ? await this.versionRows.find({ where: { id: In(versionIds) } }) : [];
    const byVersionId = new Map(versions.map((version) => [version.id, version]));

    const catalogue: MapRecord[] = [];
    for (const map of maps) {
      const version = map.currentVersionId ? byVersionId.get(map.currentVersionId) : undefined;
      if (!version) {
        // A Map with no current version cannot be entered and cannot be
        // rendered. Skipped with a warning rather than crashing the catalogue:
        // the other Maps in the Space are fine, and the management screen is how
        // somebody fixes this one.
        this.logger.warn(`Map "${map.slug}" has no published version and is being skipped.`);
        continue;
      }

      // Re-validated on the way out of the database, not trusted. `jsonb` is
      // schemaless by construction and this row can be written by phase 9's
      // editor, by a migration, or by somebody with a psql prompt — and an
      // invalid document reaching the tick is a spawn-less world discovered at
      // the first join.
      const parsed = mapDocumentSchema.safeParse(version.document);
      if (!parsed.success) {
        this.logger.error(
          `Map "${map.slug}" version ${version.version} is not a valid map document and is ` +
            `being skipped: ${parsed.error.message}`,
        );
        continue;
      }

      catalogue.push({
        id: map.id,
        slug: map.slug,
        name: map.name,
        capacity: map.capacity,
        instancing: map.instancing,
        overflow: map.overflow,
        archivedAt: map.archivedAt,
        sortIndex: map.sortIndex,
        version: version.version,
        document: parsed.data,
      });
    }

    this.catalogue = catalogue;
  }

  /**
   * Seed Maps for documents on disk that are not already Maps.
   *
   * By slug, and only for slugs that are absent. That is what makes this safe to
   * run on every boot: a Map renamed, re-authored or archived through the API is
   * never resurrected or overwritten by the file it was originally seeded from.
   */
  private async seedFromDisk(spaceId: string): Promise<void> {
    const existing = await this.mapRows!.find({ where: { spaceId } });
    const known = new Set(existing.map((map) => map.slug));

    let seeded = 0;
    let sortIndex = existing.length;

    for (const disk of this.maps.loadFromDisk()) {
      if (known.has(disk.slug)) continue;

      const row = await this.mapRows!.save(
        this.mapRows!.create({
          spaceId,
          slug: disk.slug,
          name: disk.document.name,
          capacity: null,
          instancing: 'fill-then-spill',
          overflow: 'instance',
          currentVersionId: null,
          archivedAt: null,
          sortIndex: disk.slug === this.maps.starterSlug ? -1 : sortIndex++,
          createdBy: null,
        }),
      );
      await this.publishVersion(row.id, disk.document, null, 'seeded from assets/world');
      seeded++;
    }

    if (seeded > 0) this.logger.log(`Seeded ${seeded} map(s) from assets/world.`);

    // The landing Map, set once. Only when the Space has none — an administrator
    // who chose a different one must not have it reverted by a restart, which is
    // the same relationship every other seeded value has with its column.
    const space = await this.spaceRows!.findOne({ where: { id: spaceId } });
    if (space && !space.defaultMapId) {
      const starter =
        (await this.mapRows!.findOne({ where: { spaceId, slug: this.maps.starterSlug } })) ??
        (await this.mapRows!.findOne({ where: { spaceId }, order: { sortIndex: 'ASC' } }));
      if (starter) {
        await this.patchSpaceRow({ defaultMapId: starter.id });
        this.logger.log(`Landing map set to "${starter.slug}" (FR-8.7).`);
      }
    }
  }

  private fromDisk(): MapRecord[] {
    return this.maps.loadFromDisk().map((disk, index) => ({
      id: disk.slug,
      slug: disk.slug,
      name: disk.document.name,
      capacity: null,
      instancing: 'fill-then-spill' as const,
      overflow: 'instance' as const,
      archivedAt: null,
      sortIndex: disk.slug === this.maps.starterSlug ? -1 : index,
      version: 0,
      document: disk.document,
    }));
  }

  private requirePersistence(what: string): void {
    if (this.persistent) return;
    throw new RegistryError(
      'unavailable',
      `${what} needs a database, and this server is running without one. The maps in ` +
        `assets/world are all there are.`,
    );
  }

  private announce(change: CatalogueChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

/** What changed, for the runtime that has to react to it. `archived` and
 *  `deleted` are the two that strand people (`FR-8.18`); the rest only mean the
 *  directory is stale. */
export type CatalogueChange =
  | { kind: 'created'; mapId: string }
  | { kind: 'updated'; mapId?: string }
  | { kind: 'archived'; mapId: string }
  | { kind: 'deleted'; mapId: string }
  | { kind: 'space-archived' }
  /**
   * Phase 9, `FR-9.20` — a new version of a Map is live.
   *
   * Deliberately not in the same family as `archived` and `deleted`, which move
   * people out. Publishing must **not** be a hard break: the running instance
   * keeps the document it was allocated with, the next one reads the new
   * version, and the people inside are offered a reload they choose to take.
   */
  | { kind: 'published'; mapId: string; version: number; by: string | null; notes: string | null };

/** Convenience for callers that only have an id and want the pair the world
 *  runtime keys instances by. Re-exported so nothing outside this module has to
 *  know the format. */
export { instanceIdOf };

/** A promise with its resolver, for the readiness signal above. */
function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
