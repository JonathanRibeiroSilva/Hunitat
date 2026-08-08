/**
 * Locomotion and emote playback for one avatar — FR-4.2, FR-4.3, FR-4.16.
 *
 * Two layers on one `AnimationMixer`:
 *
 *   base       idle / walk / run / jump, cross-faded, exactly one at full weight
 *   additive   the current emote, layered on top
 *
 * The layering is what makes `FR-4.16`'s "does not block normal movement" true
 * rather than aspirational. Emote clips animate the upper body only and are made
 * additive against their own rest pose, so a wave adds shoulder and elbow
 * rotation to whatever the legs are already doing. Playing them as a second
 * normal action instead would have the mixer average the two, and an avatar
 * half-waving while half-walking looks like neither.
 *
 * Nothing here calls `setState`. It is driven from `useFrame` and mutates
 * three.js objects directly (ADR 0002).
 */

import * as THREE from 'three';
import {
  CLIP_REFERENCE_SPEED_MPS,
  Flags,
  LOCOMOTION_CLIPS,
  type ClientTuning,
  type LocomotionClip,
} from '@hubitat/protocol';

/**
 * Below this, a participant is standing still.
 *
 * Interpolated speed is a finite difference over quantized positions, so it is
 * never exactly zero — one centimetre of jitter over a 50 ms tick reads as
 * 0.2 m/s. Without a floor, a stationary avatar walks on the spot forever.
 */
const IDLE_SPEED_MPS = 0.35;

/**
 * How far a threshold moves once it has been crossed, as a fraction of itself.
 *
 * Every threshold in this file separates two clips, and crossing one restarts
 * the destination clip from its first frame. A bare comparison against a noisy
 * speed therefore does not "sometimes pick the wrong state" — it restarts the
 * walk cycle several times a second, which is the same failure the AOI radii,
 * the zone volumes and the audio ranges all carry an explicit hysteresis band to
 * avoid. This is that band, one layer up.
 *
 * Applied symmetrically, so `RUN_ANIMATION_THRESHOLD_MPS` still means what it
 * says: 4 m/s becomes "start running above 4.4, stop below 3.6" rather than
 * moving the whole boundary.
 */
const STATE_HYSTERESIS = 0.1;

/**
 * How long the flags must say airborne before a jump is drawn.
 *
 * Rapier's character controller reports one or two frames of `!grounded` while
 * walking over ordinary flat geometry — measured against `office.glb`'s own
 * collision meshes at 1.9 stretches per second walking and 2.0 running, none
 * longer than two frames. Believing them costs a state change every time: the
 * jump clip is cut in and the walk cycle restarts from zero, four times a
 * second, which is exactly what "the avatar trembles" looks like.
 *
 * A real jump is airborne for 857 ms at the default gravity and jump height, so
 * this sits an order of magnitude above the noise and well inside the signal.
 * The cost is that the take-off pose starts this late; landing is not delayed,
 * because a grounded frame during a fall is not a thing the controller reports.
 */
const AIRBORNE_CONFIRM_SECONDS = 0.1;

/**
 * Time constant for the speed the animation is driven from.
 *
 * Remote speed arrives as one number per server tick, and both the state above
 * and the playback rate below are recomputed from it every frame — so any noise
 * left in it is applied to the legs sixty times a second. `interpolation.ts`
 * measures it over a window, which removes the outliers; this removes the step
 * between one measurement and the next.
 *
 * Short enough not to be felt: a standing start reaches walking speed within a
 * frame (the idle threshold is 0.35 m/s of a 3 m/s step) and the run threshold
 * in about 130 ms, which reads as breaking into a run rather than as lag.
 */
const SPEED_SMOOTHING_SECONDS = 0.08;

/**
 * How far playback rate may be stretched to match actual speed.
 *
 * The rate keeps feet in step with the ground (FR-4.3), but only within reason:
 * a clip played at a fifth speed is a slideshow, and at triple it is a blur. Out
 * past these the animation is wrong either way, and a wrong animation at a
 * watchable rate is the better wrong.
 */
const MIN_RATE = 0.55;
const MAX_RATE = 1.75;

/**
 * Clips are shared between every avatar in the room, so making one additive
 * must happen once.
 *
 * The current asset authors emotes from the rest pose, which makes the
 * conversion arithmetically a no-op — but a replacement model (a VRM with a
 * different rest pose, say) would not, and running the subtraction fifteen times
 * would compound it.
 */
const additiveClips = new WeakSet<THREE.AnimationClip>();

export interface LocomotionInput {
  /** Planar speed, m/s. */
  speed: number;
  /** Transform frame flags — `Flags.GROUNDED` and friends. */
  flags: number;
}

export class AvatarAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly base = new Map<LocomotionClip, THREE.AnimationAction>();
  private readonly byName = new Map<string, THREE.AnimationClip>();

  private current: LocomotionClip | null = null;
  /** Low-passed `input.speed` — see `SPEED_SMOOTHING_SECONDS`. */
  private speed = 0;
  /** Seconds the flags have said airborne without interruption. */
  private airborneFor = 0;
  private emote: THREE.AnimationAction | null = null;
  /** Wall-clock deadline for the running emote, so a clip that outlives its
   *  server-stated duration is still stopped (FR-4.16). */
  private emoteEndsAt = 0;

  private readonly crossfadeSeconds: number;
  private readonly runThresholdMps: number;

  constructor(
    private readonly root: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    tuning: ClientTuning,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.crossfadeSeconds = Math.max(0, tuning.animationCrossfadeMs) / 1000;
    this.runThresholdMps = tuning.runAnimationThresholdMps;

    for (const clip of clips) this.byName.set(clip.name, clip);

    for (const name of LOCOMOTION_CLIPS) {
      const clip = this.byName.get(name);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      if (name === 'jump') {
        // Held on its last frame while airborne. Looping it would make a long
        // fall read as repeated jumping.
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.base.set(name, action);
    }

    // Starting from idle rather than from nothing: an avatar whose first frame
    // is the untouched rest pose snaps into its first animation, and the first
    // frame is exactly when someone is looking at them appear.
    const idle = this.base.get('idle');
    if (idle) {
      idle.play();
      this.current = 'idle';
    }
  }

  /** Drive locomotion. Call once per frame with the participant's own motion. */
  update(delta: number, input: LocomotionInput): void {
    // Exponential, against delta rather than against a frame count, so the same
    // motion looks the same at 30 fps as at 144.
    this.speed += (input.speed - this.speed) * (1 - Math.exp(-delta / SPEED_SMOOTHING_SECONDS));
    this.airborneFor = (input.flags & Flags.GROUNDED) === 0 ? this.airborneFor + delta : 0;

    const next = this.stateFor();

    if (next !== this.current) {
      this.transitionTo(next);
      this.current = next;
    }

    // FR-4.3 — the clip is authored at one speed, so play it at the ratio of
    // the real one. This is the whole of "feet match speed"; without it a
    // walking avatar at 1 m/s takes three-metre strides on the spot.
    const reference = CLIP_REFERENCE_SPEED_MPS[next as 'walk' | 'run'];
    const action = this.base.get(next);
    if (action && reference) {
      action.timeScale = clamp(this.speed / reference, MIN_RATE, MAX_RATE);
    } else if (action) {
      action.timeScale = 1;
    }

    if (this.emote && performance.now() >= this.emoteEndsAt) this.stopEmote();

    this.mixer.update(delta);
  }

  /**
   * FR-4.14, FR-4.15 — play an emote, for exactly as long as the server said.
   *
   * `durationMs` comes off the `EMOTE_PLAY` frame rather than from the local
   * catalogue: the server clamps it to `EMOTE_MAX_DURATION_MS`, and fifteen
   * clients each deciding for themselves when the dance stops is fifteen
   * chances to disagree.
   */
  play(clipName: string, durationMs: number): void {
    const clip = this.byName.get(clipName);
    if (!clip || durationMs <= 0) return;

    // A second emote replaces the first rather than stacking. Two additive
    // clips both reaching for the same shoulder produce a pose neither of them
    // describes.
    this.stopEmote();

    if (!additiveClips.has(clip)) {
      THREE.AnimationUtils.makeClipAdditive(clip);
      additiveClips.add(clip);
    }

    const action = this.mixer.clipAction(clip, undefined, THREE.AdditiveAnimationBlendMode);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    // Not clamped: the clip's last frame IS the rest pose, so letting it finish
    // and switch itself off is what leaves the avatar unaltered afterwards.
    action.clampWhenFinished = false;
    action.setEffectiveWeight(1);
    // Fit the clip into the duration the server allowed, rather than truncating
    // it: a wave cut off at 60% ends with the arm in the air.
    action.timeScale = clip.duration / (durationMs / 1000);
    action.play();

    this.emote = action;
    this.emoteEndsAt = performance.now() + durationMs;
  }

  get isEmoting(): boolean {
    return this.emote !== null;
  }

  /**
   * NFR-14 — release the mixer's bindings.
   *
   * `uncacheRoot` is the part that is easy to miss: the mixer keeps a property
   * binding per animated node per root, and without this they outlive every
   * avatar that has ever walked past. Fifteen people arriving and leaving for an
   * hour is exactly the scenario the requirement bounds.
   */
  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.base.clear();
    this.byName.clear();
    this.emote = null;
  }

  // ───────────────────────────────────────────────────────────────────────────

  private stateFor(): LocomotionClip {
    // Airborne outranks speed: someone running off a ledge is jumping, not
    // running, and the flags are the only thing that knows the difference.
    if (this.airborneFor >= AIRBORNE_CONFIRM_SECONDS && this.base.has('jump')) return 'jump';

    const moving = this.current === 'walk' || this.current === 'run';
    const idleThreshold = band(IDLE_SPEED_MPS, moving);
    const runThreshold = band(this.runThresholdMps, this.current === 'run');

    if (this.speed < idleThreshold) return 'idle';
    if (this.speed >= runThreshold && this.base.has('run')) return 'run';
    return this.base.has('walk') ? 'walk' : 'idle';
  }

  /** FR-4.3 — cross-fade, never a cut. */
  private transitionTo(next: LocomotionClip): void {
    const to = this.base.get(next);
    if (!to) return;

    const from = this.current === next ? undefined : this.base.get(this.current ?? 'idle');

    to.reset().setEffectiveWeight(1).play();

    /**
     * Everything that is not the destination or the clip being faded out is
     * stopped outright.
     *
     * This is the part that is easy to leave out and expensive to find. A
     * `LoopOnce` action that has finished with `clampWhenFinished` is **paused,
     * not stopped**: three.js leaves it `enabled` at full weight, and a
     * paused-but-enabled action still accumulates into the blend. `jump` is
     * exactly that action, and any fall longer than its 0.8 s clip leaves it
     * clamped in the air — so without this, that jump leaves the final pose
     * averaging 50/50 with walk and idle for the rest of the session. The
     * symptom is an avatar that shuffles at half stride with its arms
     * half-raised, and it never recovers.
     *
     * `AIRBORNE_CONFIRM_SECONDS` narrowed the window rather than closing it:
     * an ordinary 857 ms jump now starts its clip 100 ms in and lands with
     * 57 ms of it left to play. A drop from any height still finishes it.
     *
     * `crossFadeFrom` cannot rescue it either: a fade *from* a non-running
     * action leaves both weights where they were.
     */
    for (const [name, action] of this.base) {
      if (name === next || action === from) continue;
      action.stop();
    }

    if (!from || !from.isRunning()) {
      if (from) from.stop();
      return;
    }

    // `warp: false`, deliberately. Warping ramps one clip's playback rate into
    // the other's over the fade — and it records that ramp as a ratio against
    // whatever `timeScale` held at the moment of the call, which `update()`
    // then overwrites on the very next frame. The two multiply: a walk entered
    // from idle starts at half rate, a walk entered from run starts at 1.5x,
    // and a second jump inherits the leftover from the first and plays nearly
    // four times too fast. Since the rate is already driven from real speed
    // every frame (FR-4.3), the warp has nothing to contribute and everything
    // to corrupt.
    to.crossFadeFrom(from, this.crossfadeSeconds, false);
  }

  private stopEmote(): void {
    if (!this.emote) return;
    this.emote.stop();
    this.emote = null;
    this.emoteEndsAt = 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A threshold, moved out of the way of the state already playing. */
function band(threshold: number, engaged: boolean): number {
  return threshold * (engaged ? 1 - STATE_HYSTERESIS : 1 + STATE_HYSTERESIS);
}
