/**
 * The editor and the asset library, over HTTP — `FR-9.11`–`FR-9.21`.
 *
 * ── Every route needs `manage-maps` ─────────────────────────────────────────
 *
 * `FR-9.21` is one sentence — "only roles permitted by Phase 7 can edit, manage
 * assets, and publish; others cannot modify a Map" — and it is satisfied by
 * putting phase 7's `RolesGuard` in front of the whole controller rather than
 * per route. A class-level requirement cannot be forgotten on the endpoint added
 * next month, which is exactly how an authorization rule ships broken.
 *
 * The same capability as adding and archiving Maps, deliberately: authoring the
 * contents of a room and deciding a room exists are the same job, and splitting
 * them would create a role that can build a room nobody can enter.
 *
 * ── Reading is guarded too, and that is not obvious ─────────────────────────
 *
 * The published document is public — `MapController` serves it unauthenticated,
 * because every participant downloads it to render the world. The *draft* is
 * not: it is unfinished work, it can contain rooms that do not exist yet, and
 * `FR-9.4` makes it explicitly not the thing participants are in.
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  accountIdentity,
  assetUploadRequestSchema,
  draftSaveSchema,
  publishRequestSchema,
  revertRequestSchema,
  type AssetDto,
  type AssetUploadRequest,
  type AssetUploadTicketDto,
  type DraftSaveRequest,
  type EditorStateDto,
  type MapDocument,
  type PublishRequest,
  type RevertRequest,
} from '@hubitat/protocol';
import { AccessTokenGuard, CurrentAccount } from '../auth/auth.guard.js';
import type { ResolvedAccount } from '../auth/account.service.js';
import { ZodBody } from '../auth/zod.pipe.js';
import { AuditService } from '../moderation/audit.service.js';
import { RequireCapability, RolesGuard } from '../moderation/roles.guard.js';
import { AssetService } from './asset.service.js';
import { EditorService, type Editor } from './editor.service.js';
import { RegistryError } from './map-registry.service.js';

@Controller('spaces/:slug/editor')
@UseGuards(AccessTokenGuard, RolesGuard)
@RequireCapability('manage-maps')
export class EditorController {
  constructor(
    private readonly editor: EditorService,
    private readonly assets: AssetService,
    private readonly audit: AuditService,
  ) {}

  // ── The map being edited ───────────────────────────────────────────────────

  /** `FR-9.4`, `FR-9.17` — open a Map for editing. */
  @Get('maps/:mapId')
  state(
    @Param('mapId') mapId: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    return this.attempt(() => this.editor.state(mapId, editorOf(account)));
  }

  /** `FR-9.19` — read a retained version before deciding to revert to it.
   *  Reverting blind is how somebody restores the wrong afternoon. */
  @Get('maps/:mapId/versions/:version')
  version(@Param('mapId') mapId: string, @Param('version') version: string): Promise<MapDocument> {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('A version is a positive whole number.');
    }
    return this.attempt(() => this.editor.versionDocument(mapId, parsed));
  }

  /**
   * `FR-9.4`, `FR-9.22` — save the draft.
   *
   * `PUT` rather than `PATCH`: the whole document every time. A patch would need
   * the client and the server to agree on what the current value is, and they
   * demonstrably do not during the save a previous edit is still in flight for —
   * which is the same reasoning `SET_APPEARANCE` used four phases ago.
   */
  @Put('maps/:mapId/draft')
  save(
    @Param('mapId') mapId: string,
    @Body(new ZodBody(draftSaveSchema)) body: DraftSaveRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    return this.attempt(() =>
      this.editor.saveDraft(mapId, body.document, body.revision, editorOf(account)),
    );
  }

  /** Throw the draft away and start again from what is live. */
  @Delete('maps/:mapId/draft')
  discard(
    @Param('mapId') mapId: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    return this.attempt(() => this.editor.discardDraft(mapId, editorOf(account)));
  }

  /** `FR-9.18`, `FR-9.20` — make the draft live. */
  @Post('maps/:mapId/publish')
  async publish(
    @Param('mapId') mapId: string,
    @Body(new ZodBody(publishRequestSchema)) body: PublishRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    const state = await this.attempt(() => this.editor.publish(mapId, body, editorOf(account)));
    // The same append-only record moderation writes to. Publishing changes the
    // room everybody is standing in; "who changed the office and when" is the
    // question `FR-7.20` exists to answer, and it would be unanswerable if only
    // moderation of people were recorded.
    await this.record(account, 'map-updated', {
      slug: state.mapSlug,
      published: state.publishedVersion,
      ...(body.notes ? { notes: body.notes } : {}),
    });
    return state;
  }

  /** `FR-9.19` — copy an older version forward. */
  @Post('maps/:mapId/revert')
  async revert(
    @Param('mapId') mapId: string,
    @Body(new ZodBody(revertRequestSchema)) body: RevertRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    const state = await this.attempt(() => this.editor.revert(mapId, body, editorOf(account)));
    await this.record(account, 'map-updated', {
      slug: state.mapSlug,
      revertedTo: body.version,
      published: body.publish ? state.publishedVersion : null,
    });
    return state;
  }

  // ── FR-9.22 — the advisory lock ────────────────────────────────────────────

  /** Take it, or extend it. The editor beats on this while it is open. */
  @Post('maps/:mapId/lock')
  lock(
    @Param('mapId') mapId: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<EditorStateDto> {
    return this.attempt(() => this.editor.acquireLock(mapId, editorOf(account)));
  }

  @Delete('maps/:mapId/lock')
  @HttpCode(204)
  unlock(@Param('mapId') mapId: string, @CurrentAccount() account: ResolvedAccount): Promise<void> {
    return this.attempt(() => this.editor.releaseLock(mapId, editorOf(account)));
  }

  // ── DC-9.4 — the asset library ─────────────────────────────────────────────

  /** `FR-9.14` — browse. */
  @Get('assets')
  listAssets(): Promise<AssetDto[]> {
    return this.attempt(() => this.assets.list());
  }

  /**
   * `FR-9.11` — somewhere to put the bytes.
   *
   * The response is a presigned `PUT` the client sends the file to directly. The
   * api signs a URL and gets out of the way: this process runs a 20 Hz world
   * tick and has no business buffering a 40 MB model through it.
   */
  @Post('assets')
  requestUpload(
    @Body(new ZodBody(assetUploadRequestSchema)) body: AssetUploadRequest,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<AssetUploadTicketDto> {
    return this.attempt(() => this.assets.requestUpload(body, account.accountId));
  }

  /** The bytes have landed. Verified against the object, then queued for the
   *  pipeline (`FR-9.13`). */
  @Post('assets/:assetId/complete')
  completeUpload(@Param('assetId') assetId: string): Promise<AssetDto> {
    return this.attempt(() => this.assets.completeUpload(assetId));
  }

  /** `FR-9.14` — remove, unless a Map is standing on it. */
  @Delete('assets/:assetId')
  @HttpCode(204)
  async removeAsset(
    @Param('assetId') assetId: string,
    @CurrentAccount() account: ResolvedAccount,
  ): Promise<void> {
    await this.attempt(() => this.assets.remove(assetId));
    await this.record(account, 'map-updated', { removedAsset: assetId });
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Registry refusals as HTTP status codes.
   *
   * `conflict` is the one that carries weight here: it is `FR-9.22`'s stale-save
   * and the lock held by somebody else, and a 409 is what tells a client to
   * reload rather than retry. Retrying a stale write is how the overwrite the
   * requirement forbids happens anyway.
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
          throw new ConflictException(error.message);
        case 'last-map':
          throw new ForbiddenException(error.message);
        default:
          throw new BadRequestException(error.message);
      }
    }
  }

  private record(
    account: ResolvedAccount,
    action: 'map-updated',
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

function editorOf(account: ResolvedAccount): Editor {
  return { accountId: account.accountId, name: account.displayName };
}
