/**
 * `FR-8.15`–`FR-8.18` — the Space and Map lifecycle, over HTTP.
 *
 * ── The split with the socket, one phase later ──────────────────────────────
 *
 * `NAVIGATE` is a WebSocket frame because it acts on a **session**: the subject
 * is somebody standing in a room and the effect is a whole new world arriving on
 * their connection. Everything here is the opposite — a Map outlives every
 * session, an administrator configuring one may not be in the world at all, and
 * archiving a room is a decision about the building rather than about a person.
 * The same argument phases 6 and 7 made for putting accounts and roles on HTTP.
 *
 * ── Every route is guarded twice, and that is not redundant ─────────────────
 *
 * `AccessTokenGuard` establishes **who**; `RolesGuard` establishes **what they
 * may do** (`NFR-34`). Two capabilities are used and the line between them is
 * `FR-8.17`'s "appropriate permission checks":
 *
 *   `manage-maps` (admin) — add, configure and archive the rooms *inside* a
 *   Space. The same class of act as locking it or setting its capacity.
 *
 *   `manage-space` (owner) — create a Space, archive one, delete one. Deleting a
 *   Space is durable removal of every Map, every version and every message
 *   written in it, and an admin who may retire a meeting room is not thereby
 *   somebody who may retire the building.
 *
 * ── Confirmation is a typed slug, not a boolean ─────────────────────────────
 *
 * `FR-8.17` asks for "appropriate confirmation". A `?confirm=true` is one
 * mis-click on the wrong row; typing the thing's own slug is the only
 * confirmation that cannot be given by accident.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  accountIdentity,
  hasCapability,
  mapCreateSchema,
  mapUpdateSchema,
  spaceCreateSchema,
  spaceSettingsSchema,
  type MapCreateRequest,
  type MapRecordDto,
  type MapUpdateRequest,
  type SpaceCreateRequest,
  type SpaceOverviewDto,
  type SpaceRecordDto,
  type SpaceSettingsUpdate,
} from '@hubitat/protocol';
import { AccessTokenGuard, CurrentAccount } from '../auth/auth.guard.js';
import type { ResolvedAccount } from '../auth/account.service.js';
import { ZodBody } from '../auth/zod.pipe.js';
import { AuditService, type AuditAction } from '../moderation/audit.service.js';
import { RequireCapability, RolesGuard, type RoleAwareRequest } from '../moderation/roles.guard.js';
import { z } from 'zod';
import { MapRegistry, RegistryError, type MapRecord } from './map-registry.service.js';
import { WorldInstanceService } from './world-instance.service.js';

/**
 * `FR-8.17`'s confirmation, declared here rather than in the protocol package.
 *
 * It is a property of this HTTP surface — the shape of a delete request — and
 * nothing on the wire between the world and a client carries it. The protocol
 * package publishes `deleteConfirmationSchema` for a client that wants to build
 * the body; this is the parser, and the two are the same three lines because
 * there is nothing else to say about a typed name.
 */
const confirmationSchema = z.object({ confirm: z.string().min(1).max(64) });

@Controller('spaces')
@UseGuards(AccessTokenGuard, RolesGuard)
export class SpaceController {
  constructor(
    private readonly registry: MapRegistry,
    private readonly world: WorldInstanceService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything the Space management screen needs, in one response.
   *
   * One call rather than three, for the reason `moderationOverviewSchema` gives:
   * a map list with no occupancy, or a broken-portal warning with no maps to
   * point at, is a view somebody would have to reconcile by hand.
   *
   * Readable by any signed-in account. Which rooms exist and how busy they are
   * is what the directory already tells every participant on the socket
   * (`FR-8.12`); what this adds is the *management* view — capacities, policies,
   * archived rooms, broken portals — and gating the read behind `manage-maps`
   * would mean a member could not see why the button they were told to press is
   * absent.
   */
  @Get(':slug/overview')
  overview(@Req() request: RoleAwareRequest): SpaceOverviewDto {
    const space = this.registry.currentSpace;
    const role = request.role ?? 'guest';
    const occupancy = this.world.occupancyByMap();

    let total = 0;
    for (const entry of occupancy.values()) total += entry.occupancy;

    return {
      space: {
        id: space.id,
        slug: space.slug,
        name: space.name,
        ownerAccountId: space.ownerAccountId,
        ownerName: null,
        defaultMapId: space.defaultMapId,
        archivedAt: space.archivedAt?.toISOString() ?? null,
        memberCount: 0,
        occupancy: total,
      },
      maps: this.registry.list().map((map) => this.toDto(map)),
      brokenPortals: this.registry.brokenPortals(),
      // `NFR-34`, advisory in one direction only: this hides buttons the server
      // would refuse; it cannot enable one it would not.
      canManageMaps: hasCapability(role, 'manage-maps'),
      canManageSpace: hasCapability(role, 'manage-space'),
    };
  }

  /** `FR-8.15` — add a Map to this Space. */
  @Post(':slug/maps')
  @RequireCapability('manage-maps')
  async createMap(
    @Body(new ZodBody(mapCreateSchema)) body: MapCreateRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<MapRecordDto> {
    const map = await this.attempt(() => this.registry.createMap(body, account.accountId));
    await this.record(account, 'map-created', {
      slug: map.slug,
      name: map.name,
      ...(body.copyFromMapId ? { copiedFrom: body.copyFromMapId } : {}),
    });
    return this.toDto(map);
  }

  /**
   * `FR-8.16`, and `FR-8.17`'s archive half.
   *
   * Archiving is the one update with a consequence for people who are standing
   * somewhere: `FR-8.18` requires them to be notified and moved out rather than
   * left in an instance of something nobody can enter. That happens through the
   * registry's change listener, which the world subscribes to — this handler
   * does not move anybody, and deliberately: an HTTP response must not wait on
   * a fleet of transfers, and the catalogue must not depend on the runtime that
   * depends on it.
   */
  @Patch(':slug/maps/:mapId')
  @RequireCapability('manage-maps')
  async updateMap(
    @Param('mapId') mapId: string,
    @Body(new ZodBody(mapUpdateSchema)) body: MapUpdateRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<MapRecordDto> {
    const before = this.registry.byId(mapId) ?? this.registry.resolve(mapId);
    if (!before) throw new NotFoundException('That map does not exist.');

    const map = await this.attempt(() => this.registry.updateMap(before.id, body));

    const action: AuditAction = body.archived === true ? 'map-archived' : 'map-updated';
    await this.record(account, action, { slug: map.slug, changes: body });
    return this.toDto(map);
  }

  /**
   * `FR-8.17` — durable removal, confirmed by name.
   *
   * The response carries the portals that now point nowhere rather than
   * repairing them. A dangling portal is an authoring decision to make — repoint
   * it, remove it, or leave it refusing with a clear message — and silently
   * rewriting somebody's map to tidy up after an administrator is not this
   * phase's business. Walking into one is already answered honestly by
   * `usePortal`, which refuses without swallowing the participant.
   */
  @Delete(':slug/maps/:mapId')
  @RequireCapability('manage-maps')
  async deleteMap(
    @Param('mapId') mapId: string,
    @Body(new ZodBody(confirmationSchema)) body: { confirm: string },
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<{ deleted: string; brokenPortals: unknown[] }> {
    const map = this.registry.byId(mapId) ?? this.registry.resolve(mapId);
    if (!map) throw new NotFoundException('That map does not exist.');

    if (body.confirm !== map.slug) {
      throw new BadRequestException(
        `Type "${map.slug}" to confirm. Deleting a map removes it and everything authored in ` +
          `it, and cannot be undone — archive it instead if you might want it back.`,
      );
    }

    const { brokenPortals } = await this.attempt(() => this.registry.deleteMap(map.id));
    await this.record(account, 'map-deleted', {
      slug: map.slug,
      name: map.name,
      brokenPortals: brokenPortals.length,
    });
    return { deleted: map.slug, brokenPortals };
  }

  // ── Spaces ─────────────────────────────────────────────────────────────────

  /** Every Space this server knows about. Occupancy is filled in for the one it
   *  is actually running — see `MapRegistry`'s header on why that is one. */
  @Get()
  @RequireCapability('manage-space')
  async listSpaces(): Promise<SpaceRecordDto[]> {
    const spaces = await this.registry.listSpaces();
    const here = this.registry.currentSpace.id;
    const occupancy = this.world.stats.connected;
    return spaces.map((space) => (space.id === here ? { ...space, occupancy } : space));
  }

  /**
   * `FR-8.15` — create a Space, owned by whoever created it.
   *
   * The row is durable and complete; what this process does *not* do is start
   * serving it. One process runs the Space named by `SPACE_SLUG`, for the reason
   * `MapRegistry`'s header gives, and the response says so rather than leaving
   * an administrator to discover it.
   */
  @Post()
  @RequireCapability('manage-space')
  async createSpace(
    @Body(new ZodBody(spaceCreateSchema)) body: SpaceCreateRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<{ space: SpaceRecordDto; note: string }> {
    const space = await this.attempt(() => this.registry.createSpace(body, account.accountId));
    await this.record(account, 'space-created', { slug: space.slug, name: space.name });

    return {
      space: {
        id: space.id,
        slug: space.slug,
        name: space.name,
        ownerAccountId: space.ownerAccountId,
        ownerName: null,
        defaultMapId: space.defaultMapId,
        archivedAt: null,
        memberCount: 0,
        occupancy: 0,
      },
      note:
        `"${space.slug}" exists and you own it. This server is running ` +
        `"${this.registry.currentSpace.slug}"; start a deployment with SPACE_SLUG=${space.slug} ` +
        `to open it.`,
    };
  }

  /**
   * `FR-8.16`, `FR-8.17` — rename, re-point the landing Map, or archive.
   *
   * `…/settings` and not `PATCH /spaces/:slug`, which phase 6 already published
   * for `allowGuests` and which the client and the harness both call. The two
   * ask different questions about the same row and need different capabilities —
   * `manage-access` there, `manage-space` here — and one route with two answers
   * to "may I call this" is a guard waiting to be wrong.
   */
  @Patch(':slug/settings')
  @RequireCapability('manage-space')
  async updateSpace(
    @Body(new ZodBody(spaceSettingsSchema)) body: SpaceSettingsUpdate,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<SpaceRecordDto> {
    const space = await this.attempt(() => this.registry.updateSpace(body));
    await this.record(account, 'space-updated', { changes: body });
    return {
      id: space.id,
      slug: space.slug,
      name: space.name,
      ownerAccountId: space.ownerAccountId,
      ownerName: null,
      defaultMapId: space.defaultMapId,
      archivedAt: space.archivedAt?.toISOString() ?? null,
      memberCount: 0,
      occupancy: this.world.stats.connected,
    };
  }

  /**
   * `FR-8.17` — delete a Space, and everything in it.
   *
   * Refused for the Space this process is serving. `FR-8.18` requires present
   * participants to be handled gracefully, and there is no graceful answer to
   * "the building is gone and so is every other building" — archiving it is the
   * operation that does have one.
   */
  @Delete(':slug')
  @RequireCapability('manage-space')
  @HttpCode(200)
  async deleteSpace(
    @Param('slug') slug: string,
    @Body(new ZodBody(confirmationSchema)) body: { confirm: string },
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<{ deleted: string }> {
    if (body.confirm !== slug) {
      throw new BadRequestException(
        `Type "${slug}" to confirm. Deleting a space removes every map, every message and ` +
          `every membership in it, and cannot be undone.`,
      );
    }

    await this.attempt(() => this.registry.deleteSpace(slug));
    await this.record(account, 'space-deleted', { slug });
    return { deleted: slug };
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Turn a registry refusal into the HTTP status that means it.
   *
   * The codes exist so this mapping lives in one place: `unavailable` is a
   * server that has no database and says so (503, and retrying will not help
   * until an operator acts), `conflict` is a slug somebody already took (409),
   * `last-map` is an operation that would leave the Space unenterable (403 —
   * understood, and not allowed).
   */
  private async attempt<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof RegistryError)) throw error;
      switch (error.code) {
        case 'unavailable':
          throw new ServiceUnavailableException(error.message);
        case 'not-found':
          throw new NotFoundException(error.message);
        case 'conflict':
          throw new BadRequestException(error.message);
        case 'last-map':
          throw new ForbiddenException(error.message);
        default:
          throw new BadRequestException(error.message);
      }
    }
  }

  private toDto(map: MapRecord): MapRecordDto {
    const live = this.world.occupancyByMap().get(map.id);
    return {
      id: map.id,
      slug: map.slug,
      name: map.name,
      capacity: map.capacity,
      instancing: map.instancing,
      overflow: map.overflow,
      isDefault: map.id === this.registry.currentSpace.defaultMapId,
      archivedAt: map.archivedAt?.toISOString() ?? null,
      occupancy: live?.occupancy ?? 0,
      instanceCount: live?.instances ?? 0,
      version: map.version,
      mapUrl: this.registry.geometryUrl(map),
    };
  }

  /** `FR-7.19` — the same append-only record moderation writes to. Lifecycle
   *  belongs in it because archiving a room moves people out of it and deleting
   *  one destroys what was authored there; "where did the atrium go" is exactly
   *  the question the log exists to answer. */
  private record(
    account: ResolvedAccount,
    action: AuditAction,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorIdentity: accountIdentity(account.accountId),
      actorName: account.displayName,
      action,
      detail,
    });
  }
}
