/**
 * The Map Document endpoint — phase 8.
 *
 * ── Why a route and not a static file ───────────────────────────────────────
 *
 * Phases 1–7 served `assets/world/office.map.json` straight off disk, and that
 * was right while the document *was* the file. From this phase the document
 * lives in `map_versions` and the file is a seed: a Map renamed, copied or
 * re-authored has a document the disk knows nothing about, and phase 9's editor
 * publishes new versions that never touch it.
 *
 * So the client is told a URL (`JOINED.mapDocumentUrl`, `MAP_TRANSFER.
 * mapDocumentUrl`) and this answers it. The GLB stays a static asset, because
 * geometry is genuinely a file and the document is what says which one.
 *
 * ── Why it is unauthenticated ───────────────────────────────────────────────
 *
 * Because the file it replaces was, and because the document is not a secret: it
 * is the shape of a room, and everybody who can enter the Space downloads it
 * anyway. Putting a bearer token on it would mean the *world loader* — which
 * runs in parallel with the socket handshake, deliberately, so a GLB download
 * and an SFU handshake do not serialise — needed a credential it does not
 * otherwise have, for a payload the access controls in `FR-7.11`–`FR-7.14` gate
 * at the door rather than at the asset.
 *
 * An archived Map still serves its document. Somebody standing in one while it
 * is being archived is mid-transfer out (`FR-8.18`), and refusing the fetch
 * would break the world under them on the way.
 */

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { MapDocument } from '@hubitat/protocol';
import { AssetService } from './asset.service.js';
import { MapRegistry } from './map-registry.service.js';

@Controller('maps')
export class MapController {
  constructor(
    private readonly registry: MapRegistry,
    private readonly assets: AssetService,
  ) {}

  @Get(':mapId/document')
  document(@Param('mapId') mapId: string): MapDocument {
    // Accepts an id or a slug, like every other place a Map is named — a portal
    // target is authored as a slug, and a client that followed one should not
    // have to translate.
    const map = this.registry.resolve(mapId) ?? this.registry.byId(mapId);
    if (!map) throw new NotFoundException('That map does not exist.');
    return map.document;
  }

  /**
   * Phase 9 — the assets this Map's placed objects resolve to.
   *
   * A Map Document names an asset by slug (`DC-9.2`), not by URL, because a URL
   * is either a presigned one that expires or a path that moves when storage
   * does — and a document is copied between Maps and retained for versions. So
   * the document stays stable and this answers the question it deliberately does
   * not: where the bytes are, right now.
   *
   * Unauthenticated, like the document itself and for the same reason: a placed
   * object is world geometry, every participant downloads it to render the room,
   * and gating it behind a credential the world loader does not carry would make
   * every room render empty.
   */
  @Get(':mapId/assets')
  mapAssets(@Param('mapId') mapId: string): Promise<{ id: string; slug: string; url: string }[]> {
    const map = this.registry.resolve(mapId) ?? this.registry.byId(mapId);
    if (!map) throw new NotFoundException('That map does not exist.');
    return this.assets.resolveForMap(map.id);
  }
}
