/**
 * resolveAudience — who can hear and see whom, and how loudly.
 *
 * This is the highest-leverage function in the project. Four phases consume it:
 *
 *   Phase 2  proximity, falloff, visible range      (FR-2.6, FR-2.9, FR-2.12)
 *   Phase 3  private / spotlight zone precedence    (FR-3.19, FR-3.20)
 *   Phase 5  recipients for `nearby` and `zone` chat
 *   Phase 7  user blocks                            (FR-7.16)
 *
 * Phase 5's Rules require chat reach to match media reach. Calling the same
 * function is what makes that true by construction, rather than by two
 * implementations being kept in step. Do not write a second proximity check
 * anywhere.
 *
 * Phase 1 passes no zones and no blocks, so this degrades to pure proximity.
 *
 * ── The precedence model ────────────────────────────────────────────────────
 *
 * FR-3.20 demands determinism for every combination, and FR-3.19 gives a
 * baseline rather than a total order. Instead of a precedence list, two steps:
 *
 *   1. Isolation defines a universe. In a private zone → your universe is that
 *      zone's occupants. Otherwise → everyone not in a private zone.
 *   2. Within the intersection of both universes, audience is the union of
 *      proximity and spotlight reach, minus blocks.
 *
 * Step 1 collapses to a single comparison: two participants share a universe iff
 * they are in the same private zone, or both in none.
 *
 * This yields FR-3.8 (in-zone regardless of distance), FR-3.9 (symmetric
 * isolation — symmetry is structural, since equality is commutative), FR-3.11
 * (disjoint universes) and FR-3.13 (a union, so a listener hears the spotlight
 * AND their neighbours).
 *
 * The case FR-3.20 names — a spotlighted speaker inside a private zone —
 * resolves as: the broadcast reaches only that private zone. Isolation is
 * computed first and is absolute. The spec does not settle this; we fail closed,
 * because a privacy leak is a serious harm and a spotlight that does not carry
 * is a visible, reportable annoyance.
 *
 * Full write-up: docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320
 *
 * ── Audible and visible are one computation ─────────────────────────────────
 *
 * FR-2.7 lets the two thresholds differ and they do (12 m against 8 m), but the
 * zone rules over them are identical: FR-3.8 and FR-3.12 both say "audio/video".
 * So visibility is a flag on one entry rather than a second list — a second list
 * is where the zone logic would eventually drift apart between the two.
 */

export interface AudienceParticipant {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Id of the private zone occupied, or null. Computed by the caller from zone
   *  occupancy; this function does not do geometry. */
  readonly privateZoneId?: string | null;
  /** True while standing in a spotlight zone whose scope covers the map. */
  readonly inSpotlight?: boolean;
}

export interface AudienceConfig {
  maxAudibleDistanceM: number;
  /** FR-2.7 — independent of the audible threshold, and normally smaller. */
  maxVisibleDistanceM: number;
  /**
   * How far past a threshold someone already in the set may drift before being
   * dropped (`AUDIO_HYSTERESIS_M`).
   *
   * The Phase 2 Rules require it: "Rapid in/out at a range boundary must not
   * thrash connections." Without it, standing at exactly 12 m subscribes and
   * unsubscribes a WebRTC track twenty times a second — which is audible as
   * clicking, and expensive on the SFU.
   *
   * The same mechanism as the two AOI radii and the zone margin, spelled the
   * same way: membership depends on whether you were already in.
   */
  hysteresisM: number;
  refDistanceM: number;
  rolloffFactor: number;
  spotlightGain: number;
  privateZoneGain: number;
}

export interface AudienceEntry {
  id: string;
  /** 0..1. The client applies its own PannerNode falloff for audio; this value
   *  drives chat scoping, moderation gain, and the AUDIENCE frame. */
  gain: number;
  reason: 'proximity' | 'private-zone' | 'spotlight';
  /** FR-2.12 — whether video is subscribed too, not only audio. */
  visible: boolean;
  /** Separation at the tick this was computed, in metres. */
  distanceM: number;
}

/**
 * Who was audible and who was visible last tick, per listener.
 *
 * Passing it is what turns the thresholds into a band. Omit it and the function
 * is stateless and hysteresis-free, which is what Phase 1 and any pure query
 * (chat scoping, tests) want.
 */
export interface AudienceMemory {
  readonly audible: ReadonlySet<string>;
  readonly visible: ReadonlySet<string>;
}

const NO_MEMORY: AudienceMemory = { audible: new Set(), visible: new Set() };

/** Blocks are symmetric for audience purposes: FR-7.16 requires the blocked user
 *  to be unable to reach the blocker by media or chat. */
export interface BlockLookup {
  isBlocked(a: string, b: string): boolean;
}

export const NO_BLOCKS: BlockLookup = { isBlocked: () => false };

/**
 * The symmetry rule, written once — phase 7, `FR-7.16`.
 *
 * A block is filed by one person against another, and it has to cut **both**
 * directions: the requirement is that the blocker stops receiving the blocked
 * user's media and chat, "and vice-versa as appropriate", and the Rules are
 * explicit that a blocked user must not be able to harass by media or chat. A
 * one-directional read would leave the blocked party still hearing the blocker,
 * which is most of the harassment the feature exists to stop.
 *
 * `blockedBy(x)` returns the ids **x has blocked**, so the caller stores one
 * direction and this derives the other. Both audience resolution and chat
 * recipient resolution take the result, which is what keeps "who can hear me"
 * and "who my message reaches" from disagreeing about a block — the same
 * property the Phase 5 consistency rule buys for distance.
 *
 * It does **not** hide anybody from the presence list. The Rules require a block
 * not to falsely imply the blocker is offline, so both parties stay visible and
 * simply go silent.
 */
export function symmetricBlocks(
  blockedBy: (id: string) => ReadonlySet<string> | undefined,
): BlockLookup {
  return {
    isBlocked(a, b) {
      return blockedBy(a)?.has(b) === true || blockedBy(b)?.has(a) === true;
    },
  };
}

export function resolveAudience(
  listener: AudienceParticipant,
  participants: Iterable<AudienceParticipant>,
  config: AudienceConfig,
  blocks: BlockLookup = NO_BLOCKS,
  previous: AudienceMemory = NO_MEMORY,
): AudienceEntry[] {
  const listenerZone = listener.privateZoneId ?? null;
  const audience: AudienceEntry[] = [];

  for (const speaker of participants) {
    if (speaker.id === listener.id) continue;

    // Step 1 — isolation. Shared universe iff same private zone, or both in none.
    const speakerZone = speaker.privateZoneId ?? null;
    if (speakerZone !== listenerZone) continue;

    if (blocks.isBlocked(listener.id, speaker.id)) continue;

    const distanceM = distance3D(listener, speaker);

    // Step 2 — union of spotlight and proximity, within that universe.
    //
    // Both overrides defeat distance entirely, so neither consults the
    // thresholds and neither needs hysteresis: membership follows zone
    // occupancy, which has its own margin (ZONE_HYSTERESIS_M).
    if (speaker.inSpotlight) {
      audience.push({
        id: speaker.id,
        gain: config.spotlightGain,
        reason: 'spotlight',
        visible: true,
        distanceM,
      });
      continue;
    }

    if (speakerZone !== null) {
      // FR-3.8: inside a shared private zone, distance does not attenuate.
      audience.push({
        id: speaker.id,
        gain: config.privateZoneGain,
        reason: 'private-zone',
        visible: true,
        distanceM,
      });
      continue;
    }

    // Strictly inside, not "at or inside": at exactly the threshold the falloff
    // below is already zero, so admitting them would publish an entry that
    // subscribes a track nobody can hear.
    const audibleLimit = previous.audible.has(speaker.id)
      ? config.maxAudibleDistanceM + config.hysteresisM
      : config.maxAudibleDistanceM;
    if (distanceM >= audibleLimit) continue;

    const visibleLimit = previous.visible.has(speaker.id)
      ? config.maxVisibleDistanceM + config.hysteresisM
      : config.maxVisibleDistanceM;

    audience.push({
      id: speaker.id,
      gain: inverseFalloff(distanceM, config),
      reason: 'proximity',
      visible: distanceM < visibleLimit,
      distanceM,
    });
  }

  return audience;
}

/**
 * FR-2.18 — shed streams when there are more than the client can carry.
 *
 * NFR-20 caps a client at 6 video and 12 audio streams. The order is not
 * negotiable: **video goes before audio, most distant first**, because a
 * conversation survives losing a face and does not survive losing a voice.
 *
 * Zone-driven entries are kept ahead of proximity ones at equal distance. Being
 * in someone's private zone or on a stage is a deliberate authoring decision
 * about who matters; being 3 m away is an accident of where you stood.
 *
 * Applied on the server so one policy governs every client, and so the harness
 * can assert it — the client cannot be trusted to shed anything, and a client
 * that silently kept 40 streams would surface as "it's slow", not as a bug.
 */
export interface MediaBudget {
  maxConcurrentAudio: number;
  maxConcurrentVideo: number;
}

export function applyMediaBudget(entries: AudienceEntry[], budget: MediaBudget): AudienceEntry[] {
  const ranked = [...entries].sort(compareByPriority);

  let video = 0;
  const kept: AudienceEntry[] = [];

  for (const entry of ranked) {
    if (kept.length >= budget.maxConcurrentAudio) break;
    if (!entry.visible) {
      kept.push(entry);
      continue;
    }
    if (video < budget.maxConcurrentVideo) {
      video++;
      kept.push(entry);
    } else {
      // Audio survives; only the video half is shed.
      kept.push({ ...entry, visible: false });
    }
  }

  return kept;
}

/** Zone reach first, then nearest. Ties broken by id so the result is stable
 *  across ticks and the change-detection signature does not flap. */
function compareByPriority(a: AudienceEntry, b: AudienceEntry): number {
  const rank = reasonRank(a.reason) - reasonRank(b.reason);
  if (rank !== 0) return rank;
  if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function reasonRank(reason: AudienceEntry['reason']): number {
  return reason === 'private-zone' ? 0 : reason === 'spotlight' ? 1 : 2;
}

/**
 * Inverse distance attenuation, matching the Web Audio `inverse` distance model
 * the client uses for actual playback (ADR 0007). Keeping the formulae identical
 * means the server's advertised gain and what the listener hears agree.
 */
export function inverseFalloff(distance: number, config: AudienceConfig): number {
  if (distance >= config.maxAudibleDistanceM) return 0;
  if (distance <= config.refDistanceM) return 1;
  const gain =
    config.refDistanceM /
    (config.refDistanceM + config.rolloffFactor * (distance - config.refDistanceM));
  return Math.max(0, Math.min(1, gain));
}

function distance3D(a: AudienceParticipant, b: AudienceParticipant): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
