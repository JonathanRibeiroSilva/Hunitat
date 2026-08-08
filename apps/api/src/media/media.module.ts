import { Module } from '@nestjs/common';
import { MediaService } from './media.service.js';

/**
 * Phase 2 media. Token issuance only — the SFU itself is a separate process and
 * who-hears-whom is decided on the world tick, not here (ADR 0006).
 */
@Module({
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
