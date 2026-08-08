/**
 * Generates the phase 4 avatar: assets/avatars/avatar.glb
 *
 * ADR 0010 chose VRM + retargeted Mixamo animations, and that remains the
 * destination. This generator is what stands in for it until a VRM is dropped
 * in, for the same reason `build-world.mjs` stands in for a modelled world: it
 * produces a real glTF 2.0 binary with a real node hierarchy and real animation
 * samplers, so the client exercises `GLTFLoader`, `AnimationMixer`, cross-fades
 * and additive blending against an actual asset rather than against primitives
 * assembled in code.
 *
 * What it is NOT is a skinned mesh. The figure is built from boxes parented to
 * the joint nodes — rigid segments, no `skins`, no joint weights. The animation
 * path is identical either way (channels drive node rotations; the mixer does
 * not care what is attached to them), and the part that would differ is exactly
 * the part a real VRM brings with it.
 *
 * Swapping in a VRM later is a file replacement plus `@pixiv/three-vrm`, as long
 * as the replacement carries the clip names this file writes:
 *
 *   idle · walk · run · jump          locomotion, driven by planar speed
 *   wave · point · clap · dance · cheer · think    emotes, additive, upper body
 *
 * and the material names the customizer recolours:
 *
 *   Skin · Hair · Top · Bottom · Detail
 *
 * Both lists are declared in packages/protocol/src/avatar.ts, and the client
 * warns loudly when a loaded model is missing any of them.
 *
 * Emote clips animate the upper body ONLY, and start and end at the rest pose.
 * That is what lets them play additively over walking without stopping the legs
 * (FR-4.16) and without leaving the avatar permanently bent.
 *
 * Run:  node assets/avatars/build-avatars.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/**
 * Total height, from specs/conventions/coordinates-and-units.md via
 * `AVATAR_HEIGHT_M`. The proportions below are laid out against it, so a change
 * there is a change here — the physics capsule, the camera target and the
 * nameplate anchor all assume 1.7 m.
 */
const HEIGHT_M = 1.7;

/**
 * Ground speed each locomotion clip is authored at.
 *
 * Mirrors `CLIP_REFERENCE_SPEED_MPS` in packages/protocol/src/avatar.ts. The
 * client divides actual speed by these to set the playback rate, which is what
 * keeps feet from skating (FR-4.3).
 */
const WALK_REFERENCE_MPS = 3.0;
const RUN_REFERENCE_MPS = 6.0;

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton
//
// Local translations, metres, relative to the parent joint. The root sits at the
// feet because that is where transforms are reported.
//
// The character faces -Z at yaw 0, so its own right side is +X.
// ─────────────────────────────────────────────────────────────────────────────

const JOINTS = [
  { name: 'Hips', parent: null, t: [0, 0.92, 0] },
  { name: 'Spine', parent: 'Hips', t: [0, 0.1, 0] },
  { name: 'Chest', parent: 'Spine', t: [0, 0.16, 0] },
  // Chain length is chosen so the top of the hair lands exactly on HEIGHT_M and
  // the soles on y = 0. Both matter: the capsule, the camera target and the
  // nameplate anchor are all derived from that height, and a figure that floats
  // a centimetre above the floor is the first thing anyone notices.
  { name: 'Neck', parent: 'Chest', t: [0, 0.2, 0] },
  { name: 'Head', parent: 'Neck', t: [0, 0.06, 0] },

  { name: 'ArmR', parent: 'Chest', t: [0.21, 0.18, 0] },
  { name: 'ForeArmR', parent: 'ArmR', t: [0, -0.27, 0] },
  { name: 'HandR', parent: 'ForeArmR', t: [0, -0.25, 0] },

  { name: 'ArmL', parent: 'Chest', t: [-0.21, 0.18, 0] },
  { name: 'ForeArmL', parent: 'ArmL', t: [0, -0.27, 0] },
  { name: 'HandL', parent: 'ForeArmL', t: [0, -0.25, 0] },

  { name: 'LegR', parent: 'Hips', t: [0.095, -0.02, 0] },
  { name: 'ShinR', parent: 'LegR', t: [0, -0.44, 0] },
  { name: 'FootR', parent: 'ShinR', t: [0, -0.38, 0] },

  { name: 'LegL', parent: 'Hips', t: [-0.095, -0.02, 0] },
  { name: 'ShinL', parent: 'LegL', t: [0, -0.44, 0] },
  { name: 'FootL', parent: 'ShinL', t: [0, -0.38, 0] },
];

const HIPS_REST_Y = JOINTS[0].t[1];

/**
 * Leg geometry, derived from the chain above rather than restated, so the two
 * cannot drift.
 *
 * A straight leg is a rigid pendulum: swinging the thigh by θ raises the ankle
 * by `LEG_M · (1 − cos θ)`. At the walk's 26° that is 8 cm, which is why a
 * locomotion clip has to drop the hips to keep the planted foot on the floor —
 * and why a fixed sinusoidal bob cannot do it.
 */
const LEG_ROOT_Y = JOINTS.find((joint) => joint.name === 'LegR').t[1];
const THIGH_M = -JOINTS.find((joint) => joint.name === 'ShinR').t[1];
const SHIN_M = -JOINTS.find((joint) => joint.name === 'FootR').t[1];
const ANKLE_REST_Y = HIPS_REST_Y + LEG_ROOT_Y - THIGH_M - SHIN_M;

/** How far an ankle hangs below the leg root, for one thigh/shin pair. */
function ankleDrop(thighDeg, shinDeg) {
  return (
    THIGH_M * Math.cos(thighDeg * DEG) + SHIN_M * Math.cos((thighDeg + shinDeg) * DEG)
  );
}

/**
 * How wide the changeover between stance legs is blended, in metres of ankle
 * depth. See `softMax`.
 *
 * Paid for in float: the blend can only raise the hips, by at most half of this,
 * so at the moment the legs swap the lower foot hovers. 3 cm of blend buys the
 * run's changeover down from a 10x kink to a 4x one and lifts the walk's lowest
 * foot 1.8 mm off the floor — two millimetres nobody can see against a jolt
 * everybody can. Widening it further stops helping (3.1x at 4.5 cm) and starts
 * costing visible float.
 */
const STANCE_BLEND_M = 0.03;

/**
 * A maximum with a continuous derivative.
 *
 * `Math.max` has a corner wherever its arguments cross, and the hips ride this
 * value, so every crossing is a kink in the body's vertical motion. The two
 * ankle depths cross twice per stride — once per changeover of stance leg —
 * which puts two kinks a stride into a curve that is otherwise smooth.
 *
 * The identity is `(a + b + |a − b|) / 2`; softening the absolute value is what
 * rounds the corner. It is deliberately the version that rounds UPWARD: the
 * square root is never smaller than `|a − b|`, so the result is never smaller
 * than `Math.max`, so the hips are never lower than the height that keeps the
 * deeper foot out of the floor. Rounding the other way would trade a kink for a
 * sole through the ground, which `checkFootContact` would (rightly) refuse.
 */
function softMax(a, b, blend) {
  return (a + b + Math.sqrt((a - b) ** 2 + blend * blend)) / 2;
}

/**
 * Hips height that puts the LOWEST of the two ankles exactly on the floor.
 *
 * Not "the height for a straight stance leg", which is the obvious formulation
 * and is wrong: a bending knee does not raise the ankle monotonically. Fold a
 * thigh that is 23° forward by 19° and the shin comes back to near-vertical,
 * which hangs the ankle *lower* than the straight leg it is swinging past — by
 * about a centimetre, right before the foot strikes. Taking the deeper of the
 * two removes the whole class of error rather than the case anyone thought of.
 */
function hipsOverLowestFoot(legs) {
  const deepest = legs
    .map(([thigh, shin]) => ankleDrop(thigh, shin))
    .reduce((a, b) => softMax(a, b, STANCE_BLEND_M));
  return ANKLE_REST_Y - LEG_ROOT_Y + deepest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Body parts
//
// One box each, parented to a joint. `BODY_` marks the parts whose girth the
// build variants scale — the head is deliberately not among them, because heads
// do not vary with build and a scaled one reads as a different species.
// ─────────────────────────────────────────────────────────────────────────────

const PARTS = [
  { name: 'BODY_Pelvis', joint: 'Hips', offset: [0, -0.04, 0], size: [0.3, 0.16, 0.19], material: 'Bottom' },
  { name: 'BODY_Torso', joint: 'Spine', offset: [0, 0.07, 0], size: [0.31, 0.18, 0.19], material: 'Top' },
  { name: 'BODY_Chest', joint: 'Chest', offset: [0, 0.1, 0], size: [0.35, 0.26, 0.21], material: 'Top' },
  { name: 'BODY_Neck', joint: 'Neck', offset: [0, 0.03, 0], size: [0.1, 0.08, 0.1], material: 'Skin' },

  { name: 'Head_Skull', joint: 'Head', offset: [0, 0.11, 0], size: [0.2, 0.24, 0.21], material: 'Skin' },
  { name: 'Head_Hair', joint: 'Head', offset: [0, 0.215, 0.005], size: [0.215, 0.09, 0.225], material: 'Hair' },
  { name: 'Head_Fringe', joint: 'Head', offset: [0, 0.16, -0.1], size: [0.215, 0.06, 0.03], material: 'Hair' },
  { name: 'Head_EyeR', joint: 'Head', offset: [0.05, 0.12, -0.104], size: [0.035, 0.035, 0.01], material: 'Detail' },
  { name: 'Head_EyeL', joint: 'Head', offset: [-0.05, 0.12, -0.104], size: [0.035, 0.035, 0.01], material: 'Detail' },

  { name: 'BODY_UpperArmR', joint: 'ArmR', offset: [0, -0.14, 0], size: [0.1, 0.28, 0.11], material: 'Top' },
  { name: 'BODY_ForeArmR', joint: 'ForeArmR', offset: [0, -0.12, 0], size: [0.09, 0.26, 0.1], material: 'Skin' },
  { name: 'BODY_HandR', joint: 'HandR', offset: [0, -0.05, 0], size: [0.09, 0.11, 0.1], material: 'Skin' },

  { name: 'BODY_UpperArmL', joint: 'ArmL', offset: [0, -0.14, 0], size: [0.1, 0.28, 0.11], material: 'Top' },
  { name: 'BODY_ForeArmL', joint: 'ForeArmL', offset: [0, -0.12, 0], size: [0.09, 0.26, 0.1], material: 'Skin' },
  { name: 'BODY_HandL', joint: 'HandL', offset: [0, -0.05, 0], size: [0.09, 0.11, 0.1], material: 'Skin' },

  { name: 'BODY_ThighR', joint: 'LegR', offset: [0, -0.21, 0], size: [0.14, 0.42, 0.16], material: 'Bottom' },
  { name: 'BODY_ShinR', joint: 'ShinR', offset: [0, -0.19, 0], size: [0.12, 0.38, 0.14], material: 'Bottom' },
  { name: 'BODY_FootR', joint: 'FootR', offset: [0, -0.04, -0.04], size: [0.13, 0.08, 0.24], material: 'Detail' },

  { name: 'BODY_ThighL', joint: 'LegL', offset: [0, -0.21, 0], size: [0.14, 0.42, 0.16], material: 'Bottom' },
  { name: 'BODY_ShinL', joint: 'ShinL', offset: [0, -0.19, 0], size: [0.12, 0.38, 0.14], material: 'Bottom' },
  { name: 'BODY_FootL', joint: 'FootL', offset: [0, -0.04, -0.04], size: [0.13, 0.08, 0.24], material: 'Detail' },
];

/**
 * Accessories, shipped hidden.
 *
 * `ACC_<id>` matches the accessory ids in packages/protocol/src/avatar.ts; the
 * client shows the ones the appearance names and hides the rest. Present in the
 * file rather than loaded on demand: three small boxes cost less than a second
 * request, and an accessory that arrives late pops onto the head.
 */
const ACCESSORIES = [
  { name: 'ACC_cap', joint: 'Head', offset: [0, 0.225, 0], size: [0.23, 0.07, 0.235], material: 'Top' },
  { name: 'ACC_cap_peak', joint: 'Head', offset: [0, 0.21, -0.16], size: [0.2, 0.03, 0.1], material: 'Top' },
  { name: 'ACC_glasses', joint: 'Head', offset: [0, 0.12, -0.108], size: [0.19, 0.045, 0.012], material: 'Detail' },
  { name: 'ACC_backpack', joint: 'Chest', offset: [0, 0.09, 0.14], size: [0.26, 0.28, 0.1], material: 'Bottom' },
];

const MATERIALS = [
  // Base colours are placeholders — every one of the four customizable slots is
  // overwritten per participant from the palettes in avatar.ts. `Detail` is not
  // customizable and is the colour it renders.
  { name: 'Skin', color: [0.89, 0.71, 0.56, 1], roughness: 0.85 },
  { name: 'Hair', color: [0.17, 0.13, 0.09, 1], roughness: 0.7 },
  { name: 'Top', color: [0.22, 0.74, 0.97, 1], roughness: 0.75 },
  { name: 'Bottom', color: [0.12, 0.16, 0.23, 1], roughness: 0.8 },
  { name: 'Detail', color: [0.09, 0.11, 0.15, 1], roughness: 0.5 },
];

const MATERIAL_INDEX = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i]));

// ─────────────────────────────────────────────────────────────────────────────
// Poses
//
// Authored as functions of a normalised phase rather than as keyframe tables,
// then sampled. Hand-written keys for ten clips across seventeen joints is a
// table nobody can review; a sine is legible and its derivative is continuous,
// which is what stops a linear-interpolated clip looking like a stop-motion.
//
// Each returns local Euler angles in DEGREES per joint, plus optional local
// translations in metres.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ease that reaches zero at both ends of the clip.
 *
 * Load-bearing for emotes: an additive clip whose first and last frame are the
 * rest pose adds nothing at its boundaries, which is how it starts and stops
 * without a jump and why `FR-4.16`'s "does not permanently alter the avatar"
 * holds by construction rather than by a cleanup step.
 */
function envelope(phase, sharpness = 8) {
  return Math.min(1, Math.min(phase, 1 - phase) * sharpness);
}

/**
 * Knee flexion across the swing half of a gait cycle: 1 at `centre`, 0 at a
 * quarter cycle either side of it, and flat at both ends.
 *
 * Replaces `Math.max(0, Math.cos(p · τ))`, which has the same peak, the same
 * support and the same phase — and a slope where it meets zero. That slope is
 * the expensive part. The hips ride the knee (`hipsOverLowestFoot`), so a
 * derivative that steps at the moment the knee straightens is a step in the
 * body's vertical VELOCITY, twice per stride: measured on the shipped asset at
 * 0.87 m/s in the walk and 2.46 m/s in the run, which at a run's cadence is
 * three whole-body jolts a second. It reads as trembling, it is invisible in the
 * pose at any single frame, and no amount of extra keyframes removes it —
 * sampling a corner more finely just reproduces the corner.
 *
 * A raised cosine over the same quarter-cycle has zero slope at both ends and
 * at the peak, so the whole chain from knee to hip height is C¹.
 */
function swingFlex(phase, centre = 0) {
  const offset = phase - centre;
  const toCentre = Math.abs(offset - Math.round(offset));
  return toCentre >= 0.25 ? 0 : 0.5 * (1 + Math.cos(toCentre * 4 * Math.PI));
}

/** Rotation about +X swings a limb FORWARD (toward -Z), because a point below
 *  the joint maps to negative z. Every sign below depends on that. */
const POSES = {
  idle(p) {
    const breath = Math.sin(p * TAU);
    // A FULL period. At half a period the value matches across the loop seam but
    // the derivative flips sign, and the head visibly snaps its sway direction
    // once every three seconds — the sort of thing you notice without being able
    // to say what you noticed.
    const sway = Math.sin(p * TAU);
    return {
      rotations: {
        Spine: [breath * 1.2, 0, 0],
        Chest: [breath * 1.6, 0, 0],
        Neck: [-breath * 0.8, 0, 0],
        Head: [-breath * 0.8, sway * 3.5, 0],
        ArmR: [breath * 2.2, 0, 3 + Math.abs(breath) * 1.5],
        ArmL: [breath * 2.2, 0, -3 - Math.abs(breath) * 1.5],
        // Never negative — an elbow does not hyperextend, and the self-check
        // below holds every clip to that.
        ForeArmR: [3 + breath * 3, 0, 0],
        ForeArmL: [3 + breath * 3, 0, 0],
      },
      translations: { Hips: [0, HIPS_REST_Y + breath * 0.008, 0] },
    };
  },

  walk(p) {
    // Thigh swing. Positive is forward, so the leg reaches furthest forward at
    // p = 0.25 (contact) and trails furthest back at p = 0.75 (toe-off). Which
    // makes the STANCE half 0.25 → 0.75 — the half where the foot is on the
    // ground travelling backwards under the body — and the SWING half 0.75 →
    // 1.25.
    const swing = Math.sin(p * TAU);

    // Knees flex during the swing half and are straight at both ends of stance.
    //
    // This phase is what tells a viewer which way the character is going.
    // `swingFlex` is zero at exactly 0.25 and 0.75 and peaks at p = 0, mid-swing:
    // the knee lifts the foot only while the foot is travelling forwards. Bend
    // it during stance instead and the planted foot slides forward under the
    // body, which is precisely what walking backwards looks like — the whole
    // gait reverses without a single sign changing anywhere else.
    const kneeR = swingFlex(p);
    const kneeL = swingFlex(p, 0.5);

    const thighR = swing * 26;
    const thighL = -swing * 26;
    // Knees bend BACKWARDS: negative X. The opposite of an elbow.
    const shinR = -kneeR * 45;
    const shinL = -kneeL * 45;

    return {
      rotations: {
        LegR: [thighR, 0, 0],
        LegL: [thighL, 0, 0],
        ShinR: [shinR, 0, 0],
        ShinL: [shinL, 0, 0],
        // The ankle CANCELS the leg's accumulated rotation, then adds a small
        // heel-to-toe roll on top.
        //
        // Authoring it as a plain "toes up at heel strike" is the obvious thing
        // and puts the sole 8 cm into the floor: the rotation is local to the
        // shin, so at contact the foot is already carrying the thigh's 26° and
        // the roll adds to it rather than being it. +X lifts the toe, because
        // the foot mesh extends toward -Z.
        FootR: [-(thighR + shinR) + swing * 5, 0, 0],
        FootL: [-(thighL + shinL) - swing * 5, 0, 0],
        ArmR: [-swing * 22, 0, 4],
        ArmL: [swing * 22, 0, -4],
        // Elbows flex FORWARD: positive X, since a hanging forearm rotated +X
        // brings the hand toward -Z. Negative hyperextends the arm backwards,
        // which reads as a marionette rather than a person.
        //
        // The extra flex belongs to the half of the cycle the arm is swinging
        // forward, which `Math.max(0, ∓sin)` also says — and says with a corner
        // at each end, for the same reason the knee had one. Same fix, and the
        // same half: the right arm leads at p = 0.75, opposite the right leg.
        ForeArmR: [14 + swingFlex(p, 0.75) * 16, 0, 0],
        ForeArmL: [14 + swingFlex(p, 0.25) * 16, 0, 0],
        Spine: [2, -swing * 3, 0],
        Chest: [1, swing * 5, 0],
        Head: [0, swing * 2, 0],
      },
      // The hips ride the planted leg rather than following a fixed sine.
      //
      // The old bob was a `cos(2p·τ)` term, and it was inverted on top of being
      // approximate: it lifted the hips at the stride extremes and dropped them
      // at mid-stance, when the geometry needs exactly the opposite. The feet
      // sank ~3.7 cm through the floor on one side of the cycle and floated
      // ~4.4 cm on the other. Deriving the height from the stance angle removes
      // both, and costs one cosine.
      translations: {
        Hips: [
          0,
          hipsOverLowestFoot([
            [thighR, shinR],
            [thighL, shinL],
          ]),
          0,
        ],
      },
    };
  },

  run(p) {
    const swing = Math.sin(p * TAU);
    // Same phase relationship as the walk — see the note there, it is the one
    // thing in this file that is easy to get backwards and impossible to spot
    // by reading.
    const kneeR = swingFlex(p);
    const kneeL = swingFlex(p, 0.5);

    // A shorter stride than the walk's proportions would suggest, deliberately.
    // The hips have to ride the planted leg, and a rigid straight leg swinging
    // 42° drops them 21 cm — a pogo stick, not a run. 32° keeps the bounce near
    // the ~10 cm a real sprint has. Stride length is not load-bearing anyway:
    // the client matches feet to ground speed by playback rate, not by the
    // clip's literal geometry (FR-4.3).
    const thighR = swing * 32;
    const thighL = -swing * 32;
    const shinR = -kneeR * 78;
    const shinL = -kneeL * 78;

    return {
      rotations: {
        LegR: [thighR, 0, 0],
        LegL: [thighL, 0, 0],
        ShinR: [shinR, 0, 0],
        ShinL: [shinL, 0, 0],
        // Same cancellation as the walk — see the note there.
        FootR: [-(thighR + shinR) + swing * 7, 0, 0],
        FootL: [-(thighL + shinL) - swing * 7, 0, 0],
        ArmR: [-swing * 38, 0, 6],
        ArmL: [swing * 38, 0, -6],
        // Held bent, the way arms are carried at a run.
        ForeArmR: [72, 0, 0],
        ForeArmL: [72, 0, 0],
        // Leaning into the run is most of what separates it from a fast walk.
        Spine: [7, -swing * 4, 0],
        Chest: [5, swing * 7, 0],
        Head: [-6, swing * 2, 0],
      },
      translations: {
        Hips: [
          0,
          hipsOverLowestFoot([
            [thighR, shinR],
            [thighL, shinL],
          ]),
          0,
        ],
      },
    };
  },

  jump(p) {
    // One arc: launch, tuck, reach for the ground. Played once and clamped, so
    // the last frame is what an avatar that never lands is left holding.
    const arc = Math.sin(Math.min(1, p) * Math.PI);
    return {
      rotations: {
        LegR: [10 + arc * 22, 0, 0],
        LegL: [-6 - arc * 12, 0, 0],
        ShinR: [-arc * 62, 0, 0],
        ShinL: [-arc * 34, 0, 0],
        FootR: [arc * 16, 0, 0],
        FootL: [arc * 10, 0, 0],
        ArmR: [-20 - arc * 95, 0, 8],
        ArmL: [-20 - arc * 95, 0, -8],
        ForeArmR: [arc * 30, 0, 0],
        ForeArmL: [arc * 30, 0, 0],
        Spine: [arc * 5, 0, 0],
        Chest: [arc * 4, 0, 0],
        Head: [-arc * 6, 0, 0],
      },
      translations: { Hips: [0, HIPS_REST_Y - 0.035 * arc, 0] },
    };
  },

  // ── Emotes. Upper body only, so the legs keep walking (FR-4.16). ───────────

  wave(p) {
    const e = envelope(p);
    const flap = Math.sin(p * TAU * 3);
    return {
      rotations: {
        ArmR: [0, 0, (112 + flap * 6) * e],
        ForeArmR: [0, 0, (-12 + flap * 30) * e],
        HandR: [0, 0, flap * 12 * e],
        Chest: [0, -5 * e, 0],
        Head: [0, -8 * e, -4 * e],
      },
    };
  },

  point(p) {
    const e = envelope(p, 6);
    const bump = Math.sin(p * TAU * 2);
    return {
      rotations: {
        ArmR: [(48 + bump * 6) * e, 0, 16 * e],
        ForeArmR: [72 * e, 0, -10 * e],
        HandR: [0, 0, -20 * e],
        Chest: [-3 * e, -4 * e, 0],
        Head: [-4 * e, 0, 0],
      },
    };
  },

  clap(p) {
    const e = envelope(p, 6);
    const beat = Math.abs(Math.sin(p * TAU * 3));
    return {
      rotations: {
        ArmR: [55 * e, 0, 20 * e],
        ForeArmR: [40 * e, 0, (-14 - beat * 24) * e],
        ArmL: [55 * e, 0, -20 * e],
        ForeArmL: [40 * e, 0, (14 + beat * 24) * e],
        Chest: [(3 + beat * 4) * e, 0, 0],
        Head: [(2 + beat * 3) * e, 0, 0],
      },
    };
  },

  dance(p) {
    const e = envelope(p, 5);
    const a = Math.sin(p * TAU * 4);
    const b = Math.cos(p * TAU * 4);
    return {
      rotations: {
        // Spine and above only. Reaching down to the Hips would fight the
        // locomotion clip's own hip track and make walking look broken.
        Spine: [0, a * 10, b * 6],
        Chest: [b * 5, -a * 12, 0],
        Head: [0, a * 9, b * 5],
        ArmR: [0, 0, (92 + a * 38) * e],
        ArmL: [0, 0, (-92 + a * 38) * e],
        ForeArmR: [0, 0, (-28 + a * 30) * e],
        ForeArmL: [0, 0, (28 + a * 30) * e],
      },
      scale: e,
    };
  },

  cheer(p) {
    const e = envelope(p, 6);
    const shake = Math.sin(p * TAU * 5);
    return {
      rotations: {
        ArmR: [0, 0, (158 + shake * 10) * e],
        ArmL: [0, 0, (-158 - shake * 10) * e],
        ForeArmR: [0, 0, shake * 16 * e],
        ForeArmL: [0, 0, -shake * 16 * e],
        Chest: [-(6 + shake * 3) * e, 0, 0],
        Head: [-10 * e, 0, 0],
      },
    };
  },

  think(p) {
    const e = envelope(p, 6);
    const nod = Math.sin(p * TAU * 2);
    return {
      rotations: {
        ArmR: [26 * e, 0, 16 * e],
        ForeArmR: [108 * e, 0, -26 * e],
        HandR: [10 * e, 0, 0],
        Chest: [3 * e, -6 * e, 0],
        Head: [(7 + nod * 3) * e, -11 * e, 4 * e],
      },
    };
  },
};

/**
 * `scale` in a pose result multiplies every rotation, which `dance` uses to fade
 * a continuous oscillation in and out. Applied here rather than inside the pose
 * so the pose stays readable.
 */
function sampled(clip, phase) {
  const pose = POSES[clip](phase);
  if (pose.scale === undefined) return pose;
  const rotations = {};
  for (const [joint, euler] of Object.entries(pose.rotations)) {
    rotations[joint] = euler.map((v) => v * pose.scale);
  }
  return { ...pose, rotations };
}

// `keys` is a sampling rate, not a set of poses: everything above is a
// continuous function of phase, and this is how finely it is written down.
// Locomotion is sampled twice as densely as the rest because the samplers are
// LINEAR — between two keys the hips travel in a straight line, so the body's
// vertical velocity steps once per key, and the size of that step is what the
// key spacing buys down. 48 is where it stops paying: past there the remaining
// vertical acceleration is the bob itself rather than the sampling of it
// (measured 0.30 m/s of step at 48 keys against 0.36 at 32 and 0.23 at 64,
// for 7 KB a doubling).
const CLIPS = [
  { name: 'idle', duration: 3.0, keys: 24, additive: false },
  { name: 'walk', duration: 1.0, keys: 48, additive: false },
  { name: 'run', duration: 0.62, keys: 48, additive: false },
  { name: 'jump', duration: 0.8, keys: 16, additive: false },
  { name: 'wave', duration: 2.2, keys: 30, additive: true },
  { name: 'point', duration: 1.8, keys: 24, additive: true },
  { name: 'clap', duration: 2.4, keys: 32, additive: true },
  { name: 'dance', duration: 4.8, keys: 48, additive: true },
  { name: 'cheer', duration: 2.6, keys: 36, additive: true },
  { name: 'think', duration: 3.0, keys: 24, additive: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// Self-check
//
// This exists because the gait bug shipped once and was invisible to review.
// The knee flexed during stance instead of during swing, which slides the
// planted foot forward under the body — an avatar walking backwards — and every
// individual sign in the file was defensible on its own. Nothing about reading
// the code catches that; measuring the foot does.
//
// So the generator refuses to emit an asset that fails, the same way the api
// refuses to boot on a contradictory configuration. The legs are a planar chain
// of X rotations, so the forward kinematics is two lines and needs no
// dependency.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ankle position in world space, from a pose's X rotations.
 *
 * Shares `THIGH_M` / `SHIN_M` / `LEG_ROOT_Y` with the pose authoring above, so
 * the check measures the same skeleton the clips are written against rather
 * than a restatement of it that can drift.
 */
function ankleOf(pose, side) {
  const thigh = (pose.rotations[`Leg${side}`]?.[0] ?? 0) * DEG;
  const shin = (pose.rotations[`Shin${side}`]?.[0] ?? 0) * DEG;
  const hipsY = pose.translations?.Hips?.[1] ?? HIPS_REST_Y;
  return {
    z: -THIGH_M * Math.sin(thigh) - SHIN_M * Math.sin(thigh + shin),
    y: hipsY + LEG_ROOT_Y - THIGH_M * Math.cos(thigh) - SHIN_M * Math.cos(thigh + shin),
  };
}

/**
 * A foot in contact with the ground must travel BACKWARDS relative to the body.
 *
 * Forward is -Z, so that means +Z. A planted foot moving toward -Z is the
 * definition of walking backwards, whatever the rest of the pose is doing.
 */
function checkGaitDirection(clipName) {
  const STEPS = 64;
  const samples = [];
  for (let i = 0; i < STEPS; i++) {
    const pose = sampled(clipName, i / STEPS);
    samples.push({ R: ankleOf(pose, 'R'), L: ankleOf(pose, 'L') });
  }

  for (const side of ['R', 'L']) {
    // The lower half of the foot's travel is its stance; no ground plane is
    // needed, only which half of the cycle it is nearer the floor.
    const heights = samples.map((s) => s[side].y).sort((a, b) => a - b);
    const median = heights[heights.length >> 1];

    let planted = 0;
    for (let i = 0; i < STEPS; i++) {
      const from = samples[i][side];
      const to = samples[(i + 1) % STEPS][side];
      if (from.y <= median) planted += to.z - from.z;
    }

    if (planted <= 0) {
      throw new Error(
        `${clipName}: the planted ${side === 'R' ? 'right' : 'left'} foot travels ` +
          `${planted.toFixed(3)} m toward -Z — forwards — while it is on the ground. ` +
          `That is a backwards walk. The knee flexion belongs in the SWING half of ` +
          `the cycle (foot travelling forward, off the ground), not in stance.`,
      );
    }
  }
}

/** Knees bend backwards, elbows bend forwards. Neither joint hyperextends. */
function checkJointDirections() {
  for (const clip of CLIPS) {
    for (let i = 0; i <= clip.keys; i++) {
      const { rotations } = sampled(clip.name, i / clip.keys);
      for (const side of ['R', 'L']) {
        const knee = rotations[`Shin${side}`]?.[0] ?? 0;
        if (knee > 0.001) {
          throw new Error(
            `${clip.name}: Shin${side} rotates +${knee.toFixed(1)}° about X. A knee bends ` +
              `backwards, so this must never be positive.`,
          );
        }
        const elbow = rotations[`ForeArm${side}`]?.[0] ?? 0;
        if (elbow < -0.001) {
          throw new Error(
            `${clip.name}: ForeArm${side} rotates ${elbow.toFixed(1)}° about X. An elbow bends ` +
              `forwards, so this must never be negative — negative hyperextends the arm.`,
          );
        }
      }
    }
  }
}

/**
 * Emote clips are made additive by the client. Two properties have to hold or
 * `FR-4.16` quietly stops being true.
 */
function checkEmotesAdditiveSafe() {
  const LOWER_BODY = /^(Hips|Leg|Shin|Foot)/;

  for (const clip of CLIPS.filter((entry) => entry.additive)) {
    // Ends at rest, or the additive offset is baked in and the avatar stays bent
    // for the rest of the session.
    for (const phase of [0, 1]) {
      const pose = sampled(clip.name, phase);
      for (const [joint, euler] of Object.entries(pose.rotations)) {
        const worst = Math.max(...euler.map(Math.abs));
        if (worst > 0.5) {
          throw new Error(
            `${clip.name}: ${joint} is ${worst.toFixed(1)}° from rest at phase ${phase}. ` +
              `An additive clip must start and end at the rest pose, or it permanently ` +
              `alters the avatar (FR-4.16).`,
          );
        }
      }
      if (pose.translations) {
        throw new Error(`${clip.name}: emote clips must not translate joints, only rotate them.`);
      }
    }

    // Upper body only, or the additive layer fights the locomotion clip's own
    // leg tracks and walking visibly stops mid-emote.
    for (let i = 0; i <= clip.keys; i++) {
      for (const joint of Object.keys(sampled(clip.name, i / clip.keys).rotations)) {
        if (LOWER_BODY.test(joint)) {
          throw new Error(
            `${clip.name}: animates ${joint}. Emote clips are upper body only — anything ` +
              `from the hips down stops the legs while the emote plays (FR-4.16).`,
          );
        }
      }
    }
  }
}

/**
 * The SOLE — not the ankle — must stay out of the floor.
 *
 * Checking the ankle is the tempting simplification and it is not enough: an
 * ankle held perfectly at rest height still buries the foot if the foot is
 * tilted, and the foot inherits the whole leg's rotation. That exact mistake
 * put the sole 8 cm under the floor while every ankle measured correct.
 *
 * So this walks the real foot box from `PARTS`, rotated by the accumulated
 * thigh + shin + ankle angle. The tolerance is 2.5 cm: some penetration is
 * unavoidable with a rigid box for a foot, and this is the other half of
 * `FR-4.3`'s "feet match speed/direction reasonably" — the foot may leave the
 * ground, it may not sink into it noticeably.
 */
const FOOT_TOLERANCE_M = 0.025;

function soleCorners() {
  const foot = PARTS.find((part) => part.name === 'BODY_FootR');
  const [, offsetY, offsetZ] = foot.offset;
  const [, sizeY, sizeZ] = foot.size;
  // Relative to the ankle joint: the two bottom corners are what can dig in.
  return [
    [offsetY - sizeY / 2, offsetZ - sizeZ / 2],
    [offsetY - sizeY / 2, offsetZ + sizeZ / 2],
  ];
}

function checkFootContact(clipName) {
  const STEPS = 96;
  const corners = soleCorners();
  let worst = 0;

  for (let i = 0; i < STEPS; i++) {
    const pose = sampled(clipName, i / STEPS);
    for (const side of ['R', 'L']) {
      const thigh = pose.rotations[`Leg${side}`]?.[0] ?? 0;
      const shin = pose.rotations[`Shin${side}`]?.[0] ?? 0;
      const ankle = pose.rotations[`Foot${side}`]?.[0] ?? 0;
      const tilt = (thigh + shin + ankle) * DEG;
      const ankleY = ankleOf(pose, side).y;
      for (const [y, z] of corners) {
        worst = Math.min(worst, ankleY + y * Math.cos(tilt) - z * Math.sin(tilt));
      }
    }
  }

  if (worst < -FOOT_TOLERANCE_M) {
    throw new Error(
      `${clipName}: a sole reaches ${(-worst * 100).toFixed(1)} cm below the floor, past the ` +
        `${(FOOT_TOLERANCE_M * 100).toFixed(1)} cm tolerance. Either the hips are not following ` +
        `the lowest leg (hipsOverLowestFoot) or the ankle is not cancelling the leg's ` +
        `accumulated rotation — the foot's rotation is LOCAL to the shin, not to the world.`,
    );
  }
}

/**
 * A gait curve must not turn a corner.
 *
 * The second bug in this file that every individual line survives review. A
 * clip whose values are all correct and whose DERIVATIVE steps looks fine in
 * any single frame and trembles in motion — the joint reverses direction
 * between one frame and the next, and the hips carry the whole body with them.
 * It arrives by one route: an authored curve built out of `Math.max` or
 * `Math.abs`. `Math.max(0, cos)` for a knee, `Math.max(0, −sin)` for an elbow
 * and `Math.max(a, b)` for the stance leg all look like the obvious way to say
 * "only during this half" or "whichever is lower", and all three keep the value
 * they were reaching for and destroy the slope.
 *
 * Nothing about the value detects it, so this measures the SHAPE: sample the
 * curve finely and compare its worst second difference against its typical one.
 * Real curvature — and a hip bob has a great deal of it — is spread across the
 * cycle, so the ratio stays near one; a corner concentrates almost all of it
 * into a single sample, so the ratio grows without bound as sampling gets finer.
 * At 2048 samples the shipped clamped cosines scored 512 on the knees, 433 on
 * the ankles and 114 on the hip height. Everything here now scores under 5.
 *
 * Not a check on how much the avatar bounces: a rigid-legged figure has to drop
 * its hips to keep a foot down, and how far is a decision (see the note in
 * `run`). This is a check on whether it does so smoothly.
 */
const KINK_RATIO = 8;

/** Second-difference concentration of a closed curve — see `checkSmoothness`. */
function kinkRatio(samples) {
  const n = samples.length;
  const curvature = samples.map((value, i) =>
    Math.abs(samples[(i + 1) % n] - 2 * value + samples[(i - 1 + n) % n]),
  );
  const mean = curvature.reduce((a, b) => a + b, 0) / n;
  const worst = Math.max(...curvature);
  return { ratio: mean > 0 ? worst / mean : 0, at: curvature.indexOf(worst) / n };
}

function checkSmoothness(clipName) {
  const STEPS = 2048;
  const poses = [];
  for (let i = 0; i < STEPS; i++) poses.push(sampled(clipName, i / STEPS));

  // The hip height, plus every angle the clip animates. The hips are the one
  // that moves the whole figure; the joints are where the corner is authored,
  // and a knee that snaps is visible on its own even when the hips absorb it.
  const curves = new Map([['Hips height', poses.map((p) => p.translations?.Hips?.[1] ?? HIPS_REST_Y)]]);
  for (const joint of Object.keys(poses[0].rotations)) {
    for (const axis of [0, 1, 2]) {
      curves.set(`${joint} ${'XYZ'[axis]}`, poses.map((p) => p.rotations[joint]?.[axis] ?? 0));
    }
  }

  for (const [name, samples] of curves) {
    // A curve that never moves has no shape to judge.
    if (Math.max(...samples) - Math.min(...samples) < 1e-9) continue;

    const { ratio, at } = kinkRatio(samples);
    if (ratio > KINK_RATIO) {
      throw new Error(
        `${clipName}: ${name} turns a corner at phase ${at.toFixed(3)} — ${ratio.toFixed(0)}x the ` +
          `curvature it carries anywhere else, against a limit of ${KINK_RATIO}. A joint whose ` +
          `velocity steps reverses direction between one frame and the next, which reads as ` +
          `trembling however correct every pose is. Look for a Math.max or a Math.abs: clamping ` +
          `a smooth function keeps its value and destroys its slope. \`swingFlex\` is the ` +
          `continuous way to say "only during this half of the cycle", \`softMax\` the ` +
          `continuous way to say "whichever is lower".`,
      );
    }
  }
}

checkGaitDirection('walk');
checkGaitDirection('run');
checkFootContact('walk');
checkFootContact('run');
checkSmoothness('walk');
checkSmoothness('run');
checkJointDirections();
checkEmotesAdditiveSafe();

// ─────────────────────────────────────────────────────────────────────────────
// Maths
// ─────────────────────────────────────────────────────────────────────────────

/** Euler XYZ (degrees) → quaternion [x, y, z, w], matching THREE.Euler's
 *  default order so what is authored here is what the mixer produces. */
function quaternionFromEulerDegrees([xDeg, yDeg, zDeg]) {
  const x = xDeg * DEG;
  const y = yDeg * DEG;
  const z = zDeg * DEG;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — one unit cube, instanced by node transform
//
// 24 vertices rather than 8, so flat shading gets a distinct normal per face.
// Identical to build-world.mjs on purpose: this is the same trick, and the whole
// figure is one cube drawn twenty-odd times.
// ─────────────────────────────────────────────────────────────────────────────

function unitCube() {
  const faces = [
    { normal: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { normal: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { normal: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { normal: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { normal: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];

  const positions = [];
  const normals = [];
  const indices = [];

  faces.forEach((face, faceIndex) => {
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    const base = faceIndex * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return { positions, normals, indices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer assembly
// ─────────────────────────────────────────────────────────────────────────────

const chunks = [];
let bufferOffset = 0;

function append(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const byteOffset = bufferOffset;
  chunks.push(bytes);
  bufferOffset += bytes.byteLength;
  // Every bufferView must start on a 4-byte boundary, or accessors of 4-byte
  // components read misaligned data.
  const padding = (4 - (bufferOffset % 4)) % 4;
  if (padding > 0) {
    chunks.push(new Uint8Array(padding));
    bufferOffset += padding;
  }
  return { byteOffset, byteLength: bytes.byteLength };
}

const gltf = {
  asset: { version: '2.0', generator: 'hubitat build-avatars.mjs' },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
  animations: [],
};

/** Adds a bufferView + accessor pair and returns the accessor index. */
function addAccessor(typedArray, componentType, type, count, extra = {}) {
  const view = append(typedArray);
  gltf.bufferViews.push({
    buffer: 0,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
    ...(extra.target ? { target: extra.target } : {}),
  });
  gltf.accessors.push({
    bufferView: gltf.bufferViews.length - 1,
    componentType,
    count,
    type,
    ...(extra.min ? { min: extra.min } : {}),
    ...(extra.max ? { max: extra.max } : {}),
  });
  return gltf.accessors.length - 1;
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// ── shared cube ──────────────────────────────────────────────────────────────

const cube = unitCube();
const positionAccessor = addAccessor(
  Float32Array.from(cube.positions),
  FLOAT,
  'VEC3',
  cube.positions.length / 3,
  { target: ARRAY_BUFFER, min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
);
const normalAccessor = addAccessor(
  Float32Array.from(cube.normals),
  FLOAT,
  'VEC3',
  cube.normals.length / 3,
  { target: ARRAY_BUFFER },
);
const indexAccessor = addAccessor(
  Uint16Array.from(cube.indices),
  UNSIGNED_SHORT,
  'SCALAR',
  cube.indices.length,
  { target: ELEMENT_ARRAY_BUFFER },
);

for (const material of MATERIALS) {
  gltf.materials.push({
    name: material.name,
    pbrMetallicRoughness: {
      baseColorFactor: material.color,
      metallicFactor: 0,
      roughnessFactor: material.roughness,
    },
    doubleSided: false,
  });
  gltf.meshes.push({
    name: `Box_${material.name}`,
    primitives: [
      {
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: gltf.materials.length - 1,
      },
    ],
  });
}

// ── nodes ────────────────────────────────────────────────────────────────────

const nodeIndex = new Map();

function addNode(node) {
  gltf.nodes.push(node);
  const index = gltf.nodes.length - 1;
  if (node.name) nodeIndex.set(node.name, index);
  return index;
}

// The armature root. Everything hangs off it, so one node carries the whole
// figure and the client can clone or dispose it as a unit.
const rootIndex = addNode({ name: 'AvatarRoot', children: [] });
gltf.scenes[0].nodes.push(rootIndex);

for (const joint of JOINTS) {
  const index = addNode({ name: joint.name, translation: joint.t, children: [] });
  const parentIndex = joint.parent === null ? rootIndex : nodeIndex.get(joint.parent);
  gltf.nodes[parentIndex].children.push(index);
}

for (const part of [...PARTS, ...ACCESSORIES]) {
  const index = addNode({
    name: part.name,
    mesh: MATERIAL_INDEX[part.material],
    translation: part.offset,
    scale: part.size,
  });
  gltf.nodes[nodeIndex.get(part.joint)].children.push(index);
}

// ── animations ───────────────────────────────────────────────────────────────

/**
 * Time accessors are deduplicated by their key count and duration.
 *
 * Ten clips would otherwise write ten near-identical ramps, and the input
 * accessor is the one glTF requires `min`/`max` on — one place to get right
 * rather than ten.
 */
const timeAccessors = new Map();

function timeAccessorFor(duration, keyCount) {
  const cacheKey = `${duration}:${keyCount}`;
  const cached = timeAccessors.get(cacheKey);
  if (cached !== undefined) return cached;

  const times = new Float32Array(keyCount + 1);
  for (let i = 0; i <= keyCount; i++) times[i] = (i / keyCount) * duration;

  const accessor = addAccessor(times, FLOAT, 'SCALAR', times.length, {
    min: [0],
    max: [duration],
  });
  timeAccessors.set(cacheKey, accessor);
  return accessor;
}

for (const clip of CLIPS) {
  const samples = [];
  for (let i = 0; i <= clip.keys; i++) samples.push(sampled(clip.name, i / clip.keys));

  const rotatedJoints = new Set();
  const translatedJoints = new Set();
  for (const sample of samples) {
    for (const joint of Object.keys(sample.rotations ?? {})) rotatedJoints.add(joint);
    for (const joint of Object.keys(sample.translations ?? {})) translatedJoints.add(joint);
  }

  const input = timeAccessorFor(clip.duration, clip.keys);
  const samplers = [];
  const channels = [];

  for (const joint of rotatedJoints) {
    const values = new Float32Array(samples.length * 4);
    samples.forEach((sample, i) => {
      const euler = sample.rotations?.[joint] ?? [0, 0, 0];
      values.set(quaternionFromEulerDegrees(euler), i * 4);
    });
    const output = addAccessor(values, FLOAT, 'VEC4', samples.length);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: nodeIndex.get(joint), path: 'rotation' },
    });
  }

  for (const joint of translatedJoints) {
    const values = new Float32Array(samples.length * 3);
    samples.forEach((sample, i) => {
      const rest = JOINTS.find((j) => j.name === joint).t;
      values.set(sample.translations?.[joint] ?? rest, i * 3);
    });
    const output = addAccessor(values, FLOAT, 'VEC3', samples.length);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: nodeIndex.get(joint), path: 'translation' },
    });
  }

  gltf.animations.push({ name: clip.name, samplers, channels });
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB container
// ─────────────────────────────────────────────────────────────────────────────

const binary = new Uint8Array(bufferOffset);
{
  let cursor = 0;
  for (const chunk of chunks) {
    binary.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
}
gltf.buffers.push({ byteLength: binary.byteLength });

const encoder = new TextEncoder();

function padTo4(bytes, padByte) {
  const remainder = bytes.byteLength % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.byteLength + (4 - remainder));
  padded.set(bytes);
  padded.fill(padByte, bytes.byteLength);
  return padded;
}

// JSON pads with spaces, BIN pads with zeros — required by the GLB spec.
const jsonChunk = padTo4(encoder.encode(JSON.stringify(gltf)), 0x20);
const binChunk = padTo4(binary, 0x00);

const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
const glb = new Uint8Array(totalLength);
const view = new DataView(glb.buffer);

let cursor = 0;
view.setUint32(cursor, 0x46546c67, true); // 'glTF'
view.setUint32(cursor + 4, 2, true);
view.setUint32(cursor + 8, totalLength, true);
cursor += 12;

view.setUint32(cursor, jsonChunk.byteLength, true);
view.setUint32(cursor + 4, 0x4e4f534a, true); // 'JSON'
cursor += 8;
glb.set(jsonChunk, cursor);
cursor += jsonChunk.byteLength;

view.setUint32(cursor, binChunk.byteLength, true);
view.setUint32(cursor + 4, 0x004e4942, true); // 'BIN\0'
cursor += 8;
glb.set(binChunk, cursor);

const outPath = join(OUT_DIR, 'avatar.glb');
writeFileSync(outPath, glb);

const additive = CLIPS.filter((c) => c.additive).length;
console.log(
  `Wrote ${outPath}\n` +
    `  ${(totalLength / 1024).toFixed(1)} KB · ${gltf.nodes.length} nodes ` +
    `(${JOINTS.length} joints, ${PARTS.length} parts, ${ACCESSORIES.length} accessories)\n` +
    `  ${gltf.animations.length} clips (${additive} additive) · ` +
    `${gltf.materials.length} materials · ${HEIGHT_M} m tall\n` +
    `  locomotion reference speeds: walk ${WALK_REFERENCE_MPS} m/s, run ${RUN_REFERENCE_MPS} m/s ` +
    `— must match CLIP_REFERENCE_SPEED_MPS in packages/protocol/src/avatar.ts`,
);
