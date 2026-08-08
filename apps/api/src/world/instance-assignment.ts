/**
 * `DC-8.4 Instance Assignment Policy` — `FR-8.8`, `FR-8.9`, `FR-8.14`.
 *
 * Which copy of a Map a person is put into, and what happens when none of them
 * has room. One pure function, because the Phase 8 notes name capacity as sharp
 * edge nº3: it is checked at the Space door (`FR-7.14`) and again here
 * (`FR-8.8`), and one configured policy has to be evaluated by one function or
 * the two will disagree about whether somebody can come in.
 *
 * Pure, and not merely for tidiness. Instance assignment is the piece of this
 * phase whose failure modes are combinatorial — full, nearly full, a preferred
 * instance that is full, a Map that refuses to spill, a Map at the instance
 * ceiling — and a function with no clock, no registry and no side effects is one
 * the harness can walk through every one of those states.
 *
 * ── Keeping groups together is the point ────────────────────────────────────
 *
 * The Phase 8 Rules put it plainly: "splitting friends across instances must be
 * explainable and ideally avoidable". Two things here serve that and nothing
 * else does:
 *
 *   `preferredInstanceId` wins whenever it has room. That is what makes
 *   "go to Ana" land you next to Ana (`FR-8.14`) and what makes everybody who
 *   walked through the same portal in the same minute end up together.
 *
 *   `fill-then-spill` is the default policy, and it is the *unfashionable* one:
 *   least-loaded balancing spreads a team of six across three instances, each
 *   of them wondering where everybody else went. Filling means the sixth person
 *   joins the five, and the spill only happens when the room is genuinely full.
 */

import type { InstancingPolicy, OverflowRule } from '@hubitat/protocol';

/** One running instance, as the decision needs to see it. */
export interface InstanceLoad {
  instanceId: string;
  index: number;
  /** Connected *and* retained participants. A resumable session still holds a
   *  place: filling its slot would mean a reconnect inside the resume window
   *  arrives to find the room one over capacity. */
  occupancy: number;
}

export interface AssignmentRequest {
  instances: readonly InstanceLoad[];
  /** From `MapRegistry.capacityOf` — the Map's own, else the Space's, else
   *  `DEFAULT_MAP_CAPACITY`. Never computed here; this function is given the
   *  number, so there is nowhere for a second opinion about it to live. */
  capacity: number;
  policy: InstancingPolicy;
  overflow: OverflowRule;
  /** `FR-8.9`, `FR-8.14` — the instance the caller would like, when there is
   *  one: the instance somebody is being followed into, or the one they were
   *  just in. Honoured whenever it has room, whatever the policy says. */
  preferredInstanceId?: string | undefined;
  /** `MAX_INSTANCES_PER_MAP`. A backstop against an unbounded allocation loop,
   *  not a target. */
  maxInstances: number;
  /**
   * True when the arrival is already counted in `occupancy` — a resume, or a
   * transfer whose source instance is the destination.
   *
   * The same exemption `AccessPolicyService` gives a reconnect, and for the same
   * reason: refusing somebody who is already occupying a slot would evict them
   * for arriving.
   */
  alreadyCounted?: boolean;
}

export type Assignment =
  /** Put them in this existing instance. */
  | { kind: 'existing'; instanceId: string; spilled: boolean }
  /** Allocate a new one at this index. `FR-8.8`'s "spin up an additional
   *  instance", which is an allocation and not a deployment. */
  | { kind: 'allocate'; index: number; spilled: boolean }
  /** `FR-8.8`'s other branch: refuse, clearly. */
  | { kind: 'refuse'; reason: 'map-full' };

/**
 * Place one arrival.
 *
 * Order is the whole of the behaviour:
 *
 *   1. **The preferred instance, if it has room.** Grouping outranks balancing;
 *      see the header.
 *   2. **The policy**, over instances that have room.
 *   3. **Overflow.** `instance` allocates the next index up to the ceiling;
 *      `refuse` says the Map is full.
 *
 * `spilled` on the result is not decoration. It is the difference between
 * "you are with your colleagues" and "you are in a second copy of the room and
 * cannot see them", and `FR-8.10` requires that difference to be made
 * understandable rather than discovered.
 */
export function assignInstance(request: AssignmentRequest): Assignment {
  const { capacity, maxInstances } = request;
  const headroom = request.alreadyCounted ? 1 : 0;
  const hasRoom = (load: InstanceLoad): boolean => load.occupancy + 1 - headroom <= capacity;

  // 1 — the instance the caller asked for.
  if (request.preferredInstanceId) {
    const preferred = request.instances.find(
      (load) => load.instanceId === request.preferredInstanceId,
    );
    if (preferred && hasRoom(preferred)) {
      return { kind: 'existing', instanceId: preferred.instanceId, spilled: false };
    }
    // Not returning here is deliberate. A full preferred instance falls through
    // to the ordinary policy rather than refusing: `FR-8.14` says "go to a
    // member" reuses the assignment rules, and being put in the next copy of
    // their room — and told so — beats being told no.
  }

  // 2 — the Map's standing rule, over instances with room.
  const open = request.instances.filter(hasRoom);
  if (open.length > 0) {
    const chosen =
      request.policy === 'least-loaded'
        ? open.reduce((best, load) =>
            load.occupancy < best.occupancy ||
            (load.occupancy === best.occupancy && load.index < best.index)
              ? load
              : best,
          )
        : // `fill-then-spill`: the lowest index with room, so a Map that has
          // spilled and then emptied refills from the bottom rather than
          // scattering the next arrivals across half-empty copies.
          open.reduce((best, load) => (load.index < best.index ? load : best));

    // Spilled when they did not get the instance they asked for, or when they
    // landed anywhere but the first — both are cases where somebody may be
    // looking for people who are not there.
    const spilled = request.preferredInstanceId
      ? chosen.instanceId !== request.preferredInstanceId
      : false;
    return { kind: 'existing', instanceId: chosen.instanceId, spilled };
  }

  // 3 — everything is full.
  if (request.overflow === 'refuse') return { kind: 'refuse', reason: 'map-full' };
  if (request.instances.length >= maxInstances) return { kind: 'refuse', reason: 'map-full' };

  return {
    kind: 'allocate',
    // The lowest free index, not `length`: reaping leaves holes, and reusing the
    // lowest one keeps `Head Office (2)` meaning the same room across a quiet
    // afternoon rather than climbing forever.
    index: lowestFreeIndex(request.instances),
    // A brand-new instance is always a spill when there was already one — it is
    // by definition a copy of the room the person could not get into.
    spilled: request.instances.length > 0,
  };
}

function lowestFreeIndex(instances: readonly InstanceLoad[]): number {
  const taken = new Set(instances.map((load) => load.index));
  for (let index = 0; ; index++) {
    if (!taken.has(index)) return index;
  }
}
