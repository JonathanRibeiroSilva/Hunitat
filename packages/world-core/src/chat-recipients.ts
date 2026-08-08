/**
 * Who a `nearby` chat message reaches — phase 5, `FR-5.2`.
 *
 * The Phase 5 Rules carry one requirement that constrains the design more than
 * any other in that phase:
 *
 *   > Proximity/zone recipient resolution must match the same ranges/zones used
 *   > by media so behavior is consistent ("people I can talk to" ≈ "people my
 *   > local chat reaches").
 *
 * The only way to hold that is to not write a second implementation. So this
 * file contains **no geometry**. It builds an `AudienceConfig` at the chat
 * radius and delegates to `resolveAudience` — the same function Phase 2 uses for
 * falloff, Phase 3 extended with zones and Phase 7 extended with blocks.
 * Consistency then holds by construction rather than by two pieces of code being
 * kept in step: a `nearby` message stops reaching somebody who has been blocked
 * for exactly the reason their voice stops, which is that both answers come from
 * one function.
 *
 * ── Direction ───────────────────────────────────────────────────────────────
 *
 * `resolveAudience(listener, …)` answers "who can **this listener** hear". Chat
 * asks the transpose: "who can hear **this speaker**". For proximity and private
 * zones the relation is symmetric and either direction would do. For a spotlight
 * it is not — a speaker on a stage reaches the whole map, and asking what the
 * speaker can hear would return the handful of people standing next to the
 * stage.
 *
 * So each candidate is asked, as a listener, whether the sender is in *their*
 * audience. That is the literal definition of "people my local chat reaches",
 * and it inherits spotlight reach and private-zone isolation without restating
 * either. It costs one call per candidate against a one-element list; the
 * candidate set is already bounded by the caller's area of interest, and chat is
 * not the hot path (`FR-5.6` is about a person's perception of "immediate", not
 * about the 50 ms tick budget).
 */

import {
  NO_BLOCKS,
  resolveAudience,
  type AudienceConfig,
  type AudienceParticipant,
  type BlockLookup,
} from './resolve-audience.js';

export interface ChatAudienceConfig {
  /**
   * `CHAT_NEARBY_RADIUS_M`. Defaults to `MAX_AUDIBLE_DISTANCE_M` and should
   * track it — diverging them deliberately is allowed, by accident is the bug
   * the rule above exists to prevent.
   */
  nearbyRadiusM: number;
  refDistanceM: number;
  rolloffFactor: number;
  spotlightGain: number;
  privateZoneGain: number;
}

/**
 * Every participant who receives a `nearby` message from `sender`, by id.
 *
 * The sender is never in the result. Their own copy is the optimistic echo the
 * server sends back to them explicitly (`FR-5.8`), which is a different thing
 * from being a recipient and must not depend on whether they can hear
 * themselves.
 */
export function resolveNearbyRecipients(
  sender: AudienceParticipant,
  participants: Iterable<AudienceParticipant>,
  config: ChatAudienceConfig,
  blocks: BlockLookup = NO_BLOCKS,
): string[] {
  const audienceConfig = toAudienceConfig(config);
  const recipients: string[] = [];

  for (const listener of participants) {
    if (listener.id === sender.id) continue;
    // No `previous` memory is passed, and that is deliberate: a send is a
    // one-shot query, not a subscription being maintained across ticks. The
    // hysteresis band exists to stop WebRTC tracks thrashing at a boundary
    // (Phase 2 Rules); applying it here would make delivery depend on which
    // direction someone happened to walk, which is not a property a message
    // should have.
    if (resolveAudience(listener, [sender], audienceConfig, blocks).length > 0) {
      recipients.push(listener.id);
    }
  }

  return recipients;
}

/**
 * The chat radius expressed as a media audience.
 *
 * `maxVisibleDistanceM` is set equal to the audible one rather than left at the
 * media default. Chat has no video, so the flag is unused — and an unused field
 * carrying a *different* threshold is a second range waiting to be mistaken for
 * a meaningful one.
 */
function toAudienceConfig(config: ChatAudienceConfig): AudienceConfig {
  return {
    maxAudibleDistanceM: config.nearbyRadiusM,
    maxVisibleDistanceM: config.nearbyRadiusM,
    hysteresisM: 0,
    refDistanceM: config.refDistanceM,
    rolloffFactor: config.rolloffFactor,
    spotlightGain: config.spotlightGain,
    privateZoneGain: config.privateZoneGain,
  };
}

export type { AudienceParticipant };
