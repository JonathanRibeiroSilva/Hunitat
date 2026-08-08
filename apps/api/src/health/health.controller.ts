import { Controller, Get } from '@nestjs/common';
import { AccountService } from '../auth/account.service.js';
import { SpaceService } from '../auth/space.service.js';
import { ChatService } from '../chat/chat.service.js';
import { AccessPolicyService } from '../moderation/access-policy.service.js';
import { MapRegistry } from '../world/map-registry.service.js';
import { WorldInstanceService } from '../world/world-instance.service.js';

/**
 * NFR-38 — enough to see tick duration degrading before users report it.
 *
 * `lastTickMs` is the number that matters: NFR-7 budgets under 10 ms against a
 * 50 ms interval, and a tick that overruns compounds, stuttering the world for
 * everyone at once.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly world: WorldInstanceService,
    private readonly registry: MapRegistry,
    private readonly chat: ChatService,
    private readonly accounts: AccountService,
    private readonly spaces: SpaceService,
    private readonly access: AccessPolicyService,
  ) {}

  @Get()
  async get() {
    const stats = this.world.stats;
    const budgetMs = 1000 / stats.tickRateHz;
    const space = await this.spaces.current();
    const policy = await this.access.describe();

    return {
      status: stats.lastTickMs < budgetMs ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      /**
       * Phase 8 — the Space, and the Maps in it.
       *
       * A list rather than the one map phase 1 reported, because "which world am
       * I looking at" became a question with several answers. `landingMap` is the
       * one `FR-8.7` puts arrivals on; the per-map occupancy is what turns
       * "nobody can find anyone" into an observation rather than a report.
       */
      space: {
        slug: this.registry.currentSpace.slug,
        name: this.registry.currentSpace.name,
        landingMap: this.registry.landingMap().slug,
        maps: this.registry.live().map((map) => {
          const live = this.world.occupancyByMap().get(map.id);
          return {
            slug: map.slug,
            name: map.name,
            capacity: this.registry.capacityOf(map),
            occupancy: live?.occupancy ?? 0,
            instances: live?.instances ?? 0,
          };
        }),
      },
      world: {
        ...stats,
        tickBudgetMs: Number(budgetMs.toFixed(2)),
      },
      // Phase 5. `memory` means room and direct history empties on restart,
      // which is a supported configuration and an alarming surprise — better
      // reported than inferred from a conversation that went missing.
      chat: { history: this.chat.historyKind },
      /**
       * Phase 6. Both fields are supported states rather than failures, and both
       * are invisible from the outside otherwise:
       *
       *   `accounts: false` — no database, so everybody is a guest and the entry
       *   screen shows no sign-in. Reported because "sign-up has disappeared"
       *   should not require reading the boot log.
       *
       *   `allowGuests` — `FR-6.8`, and the one thing that decides whether a
       *   stranger following a link gets in or gets `guests-not-allowed`. It
       *   lives in the database, so configuration alone cannot answer it.
       */
      accounts: {
        enabled: this.accounts.enabled,
        space: space?.slug ?? null,
        allowGuests: policy.allowGuests,
      },
      /**
       * Phase 7. Every one of these silently changes who can get in, and none of
       * them is visible from outside — "nobody can join and the server looks
       * healthy" is otherwise a question that takes a database session to
       * answer.
       *
       * The allowlist's **length**, never its contents: a health endpoint is
       * usually unauthenticated, and a list of addresses permitted into an
       * internal Space is a staff list — the same thing phase 6 refused to let
       * `POST /auth/login` disclose.
       */
      access: {
        locked: policy.locked,
        passwordRequired: policy.passwordSet,
        allowlistEnabled: policy.allowlistEnabled,
        allowlistSize: policy.allowlist.length,
        capacity: policy.capacity ?? this.world.runtimeConfig.defaultMapCapacity,
      },
    };
  }
}
