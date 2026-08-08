import { Module } from '@nestjs/common';
import { ChatService } from '../chat/chat.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { ModerationModule } from '../moderation/moderation.module.js';
import { AssetService } from './asset.service.js';
import { CollabGateway } from './collab.gateway.js';
import { EditorController } from './editor.controller.js';
import { EditorService } from './editor.service.js';
import { JobQueueService } from './job-queue.service.js';
import { MapController } from './map.controller.js';
import { MapRegistry } from './map-registry.service.js';
import { MapService } from './map.service.js';
import { ObjectStateService } from './object-state.service.js';
import { ModerationService } from './moderation.service.js';
import { SpaceController } from './space.controller.js';
import { StorageService } from './storage.service.js';
import { WorldGateway } from './world.gateway.js';
import { WorldInstanceService } from './world-instance.service.js';

/**
 * `ChatService` is provided here rather than in a module of its own, and that is
 * a dependency decision rather than an organisational one: it needs
 * `WorldInstanceService`, and `WorldGateway` needs it. A separate module would
 * make those two imports a cycle.
 *
 * The same shape holds for phase 6. `AuthModule` knows nothing about the world —
 * it resolves tokens to accounts and hands back a profile — so the gateway can
 * import it to authenticate a handshake (`FR-6.18`) without anything pointing
 * back. The one thing auth needs *from* the world, rebinding a live session
 * after a guest upgrade (`FR-6.7`), goes the other way through a callback the
 * gateway registers, not through an import.
 *
 * Storage is no longer listed here at all: `PersistenceModule` is global from
 * phase 6, because three modules need the same connection.
 *
 * Phase 7 repeats the shape a third time. `ModerationModule` holds the records
 * and the guard and knows nothing about the world, so this module can import it
 * for the access-policy check the handshake needs; `ModerationService` — the
 * half that actually mutes somebody and closes a socket — is provided **here**,
 * beside `ChatService`, because it needs `WorldInstanceService` and the gateway
 * needs it. What has to travel back the other way goes through
 * `WorldModerationBridge`, which the gateway registers at bootstrap.
 */
@Module({
  imports: [MediaModule, AuthModule, ModerationModule],
  /**
   * Phase 8 puts two controllers here rather than in a module of their own, for
   * the reason `ChatService` and `ModerationService` are providers here: both
   * need `MapRegistry` and one of them needs `WorldInstanceService`, and a
   * separate module would make those imports a cycle.
   *
   * `MapController` is unguarded and serves one thing — the Map Document a
   * client has to fetch while it loads a world. `SpaceController` is the
   * lifecycle surface and is guarded twice, like every other administrative
   * route in the product (`NFR-34`).
   */
  controllers: [MapController, SpaceController, EditorController],
  providers: [
    MapService,
    MapRegistry,
    // Phase 9. All four are here rather than in a module of their own for the
    // reason the phase 8 controllers are: `EditorService` needs `MapRegistry`
    // and `AssetService`, `AssetService` needs both of those plus the queue, and
    // a separate module would make the imports a cycle.
    StorageService,
    JobQueueService,
    AssetService,
    EditorService,
    // Phase 10. `CollabGateway` mounts a second WebSocket on the same server as
    // the game protocol (ADR 0003), which is what lets it enforce `FR-10.14`
    // against the live world rather than against a token nobody can check.
    ObjectStateService,
    WorldInstanceService,
    ChatService,
    ModerationService,
    WorldGateway,
    CollabGateway,
  ],
  exports: [WorldInstanceService, MapService, MapRegistry, AssetService, ChatService],
})
export class WorldModule {}
