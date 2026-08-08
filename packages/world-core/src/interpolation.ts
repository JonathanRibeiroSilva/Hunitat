/**
 * Remote transform interpolation.
 *
 * FR-1.13: remote motion must render smoothly so network gaps don't appear as
 * teleporting. AC-1.2 requires this to hold under normal jitter, defined in
 * specs/nfr.md as ±50 ms variance and up to 2% loss (NFR-21).
 *
 * The technique is deliberate lag: render remote participants
 * `bufferMs` behind the newest sample, so there is almost always a sample on
 * either side of the render time to interpolate between. At 20 Hz a 100 ms
 * buffer absorbs two consecutive missed updates.
 *
 * Timing is monotonic (performance.now / a supplied clock), never wall-clock —
 * clients are not assumed to agree on time, and a clock jump would tear the
 * motion apart.
 */

export interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * Movement flags from the transform frame (grounded / running / jumping).
   *
   * Carried through the buffer rather than read from the newest frame, so the
   * animation state a remote avatar is in belongs to the same moment as the
   * position it is being drawn at. Reading the live value instead would start a
   * jump animation `bufferMs` before the feet leave the ground (FR-4.2).
   */
  flags?: number;
}

export interface InterpolatedTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Speed in m/s in the XZ plane, for driving locomotion animation (FR-4.2). */
  speed: number;
  /**
   * Flags from the sample being interpolated *from*.
   *
   * Nearest-neighbour, never blended: these are discrete states, and half of
   * grounded is not a thing an animation graph can be in.
   */
  flags: number;
}

const MAX_SAMPLES = 32;

/**
 * How far back speed is measured.
 *
 * Not over the last pair, which is the obvious formulation and is unusable. A
 * pair is two centimetre-quantized positions divided by the gap between two
 * ARRIVALS — and that gap is not the sender's cadence, it is the sender's
 * cadence plus the network's jitter, which NFR-21 puts at ±50 ms against a
 * 50 ms tick. The distance is right and the time is wrong, so the quotient is
 * wrong by whatever the jitter was: measured on a participant walking a steady
 * 3 m/s, the last pair reported a standard deviation of 1.8 m/s and momentary
 * peaks of 33 m/s, which the locomotion state machine turned into ten state
 * changes a second and a visibly trembling avatar.
 *
 * Over several intervals the jitter is a fixed error on a much larger elapsed
 * time, and the quantization is one centimetre on a much larger distance, so
 * both shrink in proportion to the window. Long enough to be worth doing at
 * 20 Hz, short enough that stopping still reads as stopping.
 */
const SPEED_WINDOW_MS = 150;

/**
 * How much of the gap between where a sample landed and where the sender's
 * cadence says it should have landed is folded back in, per sample.
 *
 * A first-order tracking loop. Low enough to attenuate per-sample jitter twenty
 * times over, high enough to follow everything that is not jitter — a server
 * whose tick is a shade off its nominal rate, two clocks drifting apart, a
 * sender that has genuinely slowed down — within about a second.
 */
const CADENCE_TRACKING = 0.05;

export class TransformBuffer {
  private readonly samples: Sample[] = [];
  /** The newest sample as it landed and as it was filed. Both are meaningless
   *  while `samples` is empty, which is the only state `reset` has to restore. */
  private lastArrival = 0;
  private lastScheduled = 0;

  /**
   * @param bufferMs how far behind the newest sample to render
   * @param periodMs the sender's emission interval — one server tick. Zero
   *        disables the de-jittering below and takes arrival times as given,
   *        which is what a caller with no cadence to speak of wants.
   */
  constructor(
    private readonly bufferMs: number,
    private readonly periodMs = 0,
  ) {}

  push(sample: Sample): void {
    // Out-of-order arrivals are dropped rather than sorted in. At 20 Hz over a
    // single ordered WebSocket this should not happen; if it does, the newer
    // sample is already rendered and reordering would visibly rewind the avatar.
    //
    // Tested on the arrival rather than on the scheduled time below, which is
    // always made to increase: order is a property of how they landed.
    if (this.samples.length > 0 && sample.t <= this.lastArrival) return;

    const t = this.schedule(sample.t);
    this.lastArrival = sample.t;
    this.lastScheduled = t;

    this.samples.push({ ...sample, t });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /**
   * When a sample was *sent*, inferred from the sender's cadence, rather than
   * when it happened to arrive.
   *
   * This is the difference between interpolating along a straight line and
   * interpolating along one the network has crumpled. The positions in the
   * buffer are right; the times attached to them are arrival times, and NFR-21
   * allows ±50 ms of jitter on a 50 ms tick — so a segment that covers one
   * tick's worth of ground is asked to cover it in anything from no time at all
   * to twice as long. The avatar then surges and stalls its way across the room
   * at a mean speed that is perfectly correct. Measured on a steady 3 m/s walk,
   * the rendered body's own speed had a standard deviation of 1.3 m/s and turned
   * over eight times a second, peaking at 590 m/s² — thirty times the
   * acceleration a person can produce. That is the remote half of "the avatar is
   * not fluid", and it is a defect in the POSITION: no amount of work on the
   * animation reaches it.
   *
   * The sender emits on a fixed interval, so the fix is to count intervals
   * instead of measuring them: round the observed gap to whole periods, advance
   * the timeline by that many, and fold a little of the residual back so the
   * estimate follows a cadence that is not exactly nominal. Rounding is what
   * makes a dropped frame advance by two periods rather than compressing two
   * ticks of movement into one; rounding to at least one keeps the timeline
   * strictly increasing, which everything downstream assumes.
   *
   * A long silence needs no special case: a sender that stalled for a minute
   * comes back twelve hundred periods later, and twelve hundred periods is what
   * this counts.
   */
  private schedule(arrival: number): number {
    if (this.periodMs <= 0 || this.samples.length === 0) return arrival;

    const periods = Math.max(1, Math.round((arrival - this.lastScheduled) / this.periodMs));
    const expected = this.lastScheduled + periods * this.periodMs;
    return expected + (arrival - expected) * CADENCE_TRACKING;
  }

  /**
   * Position at `now`, rendered `bufferMs` in the past.
   *
   * Returns null until there is anything to show. When the buffer runs dry —
   * a stalled sender — it holds the last known sample rather than extrapolating.
   * A frozen avatar reads as "their connection hiccuped"; an extrapolated one
   * walks through a wall and then snaps back.
   */
  sample(now: number): InterpolatedTransform | null {
    if (this.samples.length === 0) return null;

    const renderTime = now - this.bufferMs;

    if (this.samples.length === 1) return withSpeed(this.samples[0]!, this.samples[0]!, 0);

    const oldest = this.samples[0]!;
    if (renderTime <= oldest.t) return withSpeed(oldest, oldest, 0);

    const newest = this.samples[this.samples.length - 1]!;
    if (renderTime >= newest.t) {
      const prior = this.samples[this.samples.length - 2] ?? newest;
      // The buffer has run dry, so the position is held — but the SPEED must
      // decay to zero or the avatar walks on the spot for as long as the sender
      // is stalled, which with the stale-session sweep is up to thirty seconds.
      // "A frozen avatar reads as their connection hiccuped" is only true if the
      // legs freeze with it.
      //
      // One missed sample is not a stall, though, and dropping to zero on
      // ordinary jitter would flick the locomotion state to idle and back. So
      // the threshold is the sender's own observed cadence: past one whole
      // interval with nothing new, they have stopped sending.
      const interval = newest.t - prior.t;
      const starved = interval > 0 && renderTime - newest.t > interval;
      return {
        x: newest.x,
        y: newest.y,
        z: newest.z,
        yaw: newest.yaw,
        speed: starved ? 0 : this.speedEndingAt(this.samples.length - 1),
        flags: newest.flags ?? 0,
      };
    }

    for (let i = this.samples.length - 1; i > 0; i--) {
      const to = this.samples[i]!;
      const from = this.samples[i - 1]!;
      if (renderTime >= from.t && renderTime <= to.t) {
        const span = to.t - from.t;
        const alpha = span > 0 ? (renderTime - from.t) / span : 1;
        return {
          x: lerp(from.x, to.x, alpha),
          y: lerp(from.y, to.y, alpha),
          z: lerp(from.z, to.z, alpha),
          yaw: lerpAngle(from.yaw, to.yaw, alpha),
          speed: this.speedEndingAt(i),
          flags: from.flags ?? 0,
        };
      }
    }

    return withSpeed(newest, newest, 0);
  }

  /**
   * Ground speed over the last `SPEED_WINDOW_MS` of samples ending at `index`.
   *
   * Path length rather than the straight line between the ends: a participant
   * walking a curve covers the same ground either way, and the chord would tell
   * the animation they had slowed down for the corner. Falls back to the single
   * preceding interval when the window holds nothing else, which is the state
   * the buffer is in for its first few frames.
   */
  private speedEndingAt(index: number): number {
    const to = this.samples[index]!;
    let first = index;
    while (first > 0 && to.t - this.samples[first - 1]!.t <= SPEED_WINDOW_MS) first--;
    if (first === index) first = Math.max(0, index - 1);

    const from = this.samples[first]!;
    const dt = (to.t - from.t) / 1000;
    if (dt <= 0) return 0;

    let distance = 0;
    for (let i = first; i < index; i++) {
      distance += planarDistance(this.samples[i]!, this.samples[i + 1]!);
    }
    return distance / dt;
  }

  /** Drop buffered history. Required after FORCE_TRANSFORM (portal, respawn) —
   *  without it the avatar visibly slides across the map to its new position. */
  reset(): void {
    this.samples.length = 0;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

function withSpeed(at: Sample, prior: Sample, fallback: number): InterpolatedTransform {
  return {
    x: at.x,
    y: at.y,
    z: at.z,
    yaw: at.yaw,
    speed: at === prior ? fallback : planarSpeed(prior, at),
    flags: at.flags ?? 0,
  };
}

function planarSpeed(from: Sample, to: Sample): number {
  const dt = (to.t - from.t) / 1000;
  if (dt <= 0) return 0;
  return planarDistance(from, to) / dt;
}

function planarDistance(from: Sample, to: Sample): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate angles the short way around.
 *
 * Plain lerp from 350° to 10° spins 340° the wrong way — the avatar whips around
 * every time it crosses zero, which is both wrong and, with directional audio,
 * audible.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}
