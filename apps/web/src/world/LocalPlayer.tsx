/**
 * The local participant: movement, collision and the third-person camera.
 *
 * The client is authoritative here (ADR 0004) — input resolves against Rapier
 * locally and the result is reported to the server. No round-trip, which is
 * what makes FR-1.11 and NFR-5 (under one frame) achievable at all.
 *
 * Everything in this file runs inside `useFrame` and mutates refs directly.
 * Nothing calls `setState`.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ClientTuning } from '@hubitat/protocol';
import { Flags, TUNING } from '@hubitat/protocol';
import { spatialAudio } from '../media/spatialAudio.js';
import { net } from '../net/client.js';
import { useMediaStore } from '../state/mediaStore.js';
import { useStore } from '../state/store.js';
import { Avatar, type AvatarHandle } from './Avatar.jsx';
import { applyKeyboardCameraOrbit, input } from './input.js';
import { clampCameraDistance, type PhysicsWorld } from './physics.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Camera geometry, from specs/conventions/coordinates-and-units.md.
 *
 * Imported rather than pushed through `ClientTuning`: that document holds what
 * is *structural* — changing it invalidates assets — while tuning-defaults.md
 * holds what is tunable, and it lists no `CAMERA_*` key at all. So `NFR-39` does
 * not reach these, but the rule in constants.ts does: nothing may hard-code them
 * at a call site.
 *
 * Degrees there, radians here. Converted once at module load rather than inside
 * a clamp that runs sixty times a second.
 */
const PITCH_MIN_RAD = (TUNING.CAMERA_PITCH_MIN_DEG * Math.PI) / 180;
const PITCH_MAX_RAD = (TUNING.CAMERA_PITCH_MAX_DEG * Math.PI) / 180;
const PITCH_DEFAULT_RAD = (TUNING.CAMERA_PITCH_DEFAULT_DEG * Math.PI) / 180;

export function LocalPlayer({ physics, tuning }: { physics: PhysicsWorld; tuning: ClientTuning }) {
  const camera = useThree((state) => state.camera);
  const avatarRef = useRef<AvatarHandle>(null);

  const displayName = useStore((state) => state.displayName);
  const localId = useStore((state) => state.joined?.localId ?? 0);
  // The local copy, not the roster's: the customizer edits it optimistically and
  // a control bound to the echoed value would lag every click by a round trip.
  const appearance = useStore((state) => state.appearance);
  const status = useStore((state) => {
    const self = state.roster.get(state.joined?.localId ?? -1);
    return self?.status ?? 'available';
  });

  // Written per frame, read inside the avatar. Refs, because both change far
  // more often than the tree should re-render.
  const speakingRef = useRef(false);
  const distanceRef = useRef(0);

  // Camera orbit state. Refs, not state: these change every frame.
  const cameraYaw = useRef(0);
  const cameraPitch = useRef(PITCH_DEFAULT_RAD);
  // Annotated: TUNING is `as const`, so the initialiser would otherwise narrow
  // the ref to the literal 4 and every zoom would be a type error.
  const cameraDistance = useRef<number>(TUNING.CAMERA_DISTANCE_M);

  const velocityY = useRef(0);
  const avatarYaw = useRef(0);
  /** Planar speed actually achieved last frame, for the locomotion blend. The
   *  input magnitude would claim full speed while walking into a wall. */
  const groundSpeed = useRef(0);
  const isIdle = useStore((state) => {
    const self = state.roster.get(state.joined?.localId ?? -1);
    return self?.activity === 'idle';
  });

  // Scratch vectors, allocated once. Allocating inside useFrame is how a smooth
  // scene turns into a garbage-collection stutter.
  const scratch = useRef({
    desired: new THREE.Vector3(),
    target: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    cameraPos: new THREE.Vector3(),
  }).current;

  /**
   * FR-3.14 / FR-7.9 — the server can override our position. Applied
   * immediately, and the interpolation history is cleared, or the avatar
   * visibly slides across the map to the new spot.
   */
  useEffect(() => {
    net.onForceTransform = (payload) => {
      physics.body.setNextKinematicTranslation({
        x: payload.transform.x,
        y: payload.transform.y + tuning.avatarHeightM / 2,
        z: payload.transform.z,
      });
      velocityY.current = 0;
      avatarYaw.current = payload.transform.yaw;
      net.resetBuffers();
    };
    return () => {
      net.onForceTransform = null;
    };
  }, [physics, tuning.avatarHeightM]);

  useFrame((_, rawDelta) => {
    // A tab returning from the background reports a huge delta; integrating it
    // teleports the avatar through walls.
    const delta = Math.min(rawDelta, 0.1);

    applyKeyboardCameraOrbit(delta);

    // ── camera orbit ────────────────────────────────────────────────────────
    cameraYaw.current += input.yawDelta;
    cameraPitch.current = clamp(
      cameraPitch.current + input.pitchDelta,
      PITCH_MIN_RAD,
      PITCH_MAX_RAD,
    );
    cameraDistance.current = clamp(
      cameraDistance.current + input.zoomDelta,
      TUNING.CAMERA_MIN_DISTANCE_M,
      TUNING.CAMERA_MAX_DISTANCE_M,
    );
    input.yawDelta = 0;
    input.pitchDelta = 0;
    input.zoomDelta = 0;

    // ── movement, relative to the camera ────────────────────────────────────
    // specs/ux/phase-01-screens.md: while the connection is down, movement input
    // is ignored. There is nowhere to send it, and walking on regardless means
    // reappearing somewhere nobody saw you walk to — the resume restores a
    // position the server never heard about.
    //
    // Gravity still runs, so a disconnect mid-jump lands instead of freezing in
    // the air, and camera orbit stays live: looking around costs nothing and the
    // scene is still on screen, dimmed.
    //
    // Read rather than subscribed. A hook here would re-render the tree on a
    // state change this file exists to keep out of React.
    const connected = useStore.getState().appState === 'in-world';

    const speed = connected && input.run ? tuning.runSpeedMps : tuning.walkSpeedMps;
    const forwardInput = connected ? input.forward : 0;
    const rightInput = connected ? input.right : 0;
    const forwardX = -Math.sin(cameraYaw.current);
    const forwardZ = -Math.cos(cameraYaw.current);
    const rightX = -forwardZ;
    const rightZ = forwardX;

    let moveX = forwardX * forwardInput + rightX * rightInput;
    let moveZ = forwardZ * forwardInput + rightZ * rightInput;
    const magnitude = Math.hypot(moveX, moveZ);
    if (magnitude > 0) {
      moveX = (moveX / magnitude) * speed;
      moveZ = (moveZ / magnitude) * speed;
    }

    const grounded = physics.controller.computedGrounded();
    if (grounded && velocityY.current < 0) velocityY.current = 0;
    if (connected && input.jump && grounded) {
      velocityY.current = Math.sqrt(2 * Math.abs(tuning.gravityMps2) * tuning.jumpHeightM);
    }
    // Consumed either way, so a jump pressed during the outage does not fire the
    // moment the connection returns.
    input.jump = false;
    velocityY.current += tuning.gravityMps2 * delta;

    scratch.desired.set(moveX * delta, velocityY.current * delta, moveZ * delta);

    // Rapier resolves the collision: sliding along surfaces, step offset and
    // slope limit all come from the controller (FR-1.10, FR-1.19, FR-3.5).
    physics.controller.computeColliderMovement(physics.collider, scratch.desired);
    const corrected = physics.controller.computedMovement();

    const current = physics.body.translation();
    physics.body.setNextKinematicTranslation({
      x: current.x + corrected.x,
      y: current.y + corrected.y,
      z: current.z + corrected.z,
    });
    physics.world.step();

    const position = physics.body.translation();
    const feetY = position.y - tuning.avatarHeightM / 2;

    // ── avatar facing follows movement, not the camera ──────────────────────
    // Standing still and orbiting must not spin the avatar: it would spin every
    // listener's spatial audio panning in phase 2 for no reason.
    if (magnitude > 0) {
      const targetYaw = Math.atan2(-moveX, -moveZ);
      avatarYaw.current = lerpAngle(avatarYaw.current, targetYaw, 1 - Math.exp(-12 * delta));
    }

    const group = avatarRef.current?.group;
    if (group) {
      group.position.set(position.x, feetY, position.z);
      group.rotation.y = avatarYaw.current;
    }

    // ── report to the server ────────────────────────────────────────────────
    net.localTransform.x = position.x;
    net.localTransform.y = feetY;
    net.localTransform.z = position.z;
    net.localTransform.yaw = avatarYaw.current;
    net.localFlags =
      (grounded ? Flags.GROUNDED : 0) |
      (input.run && magnitude > 0 ? Flags.RUNNING : 0) |
      (!grounded ? Flags.JUMPING : 0);

    // ── animation (FR-4.2, FR-4.3) ──────────────────────────────────────────
    // Driven by the movement Rapier actually resolved, not by the input. Walking
    // into a wall reports full stick deflection and zero metres, and animating
    // from the intent would leave the avatar jogging on the spot against it.
    //
    // Fed the same flags that were just written to the wire, so the local avatar
    // and every remote copy of it are in the same animation state rather than in
    // two that happen to agree.
    groundSpeed.current = delta > 0 ? Math.hypot(corrected.x, corrected.z) / delta : 0;
    avatarRef.current?.animator?.update(delta, {
      speed: groundSpeed.current,
      flags: net.localFlags,
    });

    // FR-4.12 — read rather than subscribed, for the same reason remote avatars
    // read it: LiveKit re-emits on every level change.
    //
    // Gated on `micEnabled`, because FR-4.13 does not hold on its own. Muting
    // does not unpublish the track (livekit-client only does that for screen
    // share), so the guarantee that a muted participant never shows the
    // indicator rests on the SFU dropping them from the active-speaker set — a
    // behaviour, not a structure. Locally we know the answer for certain, so we
    // use it.
    const mediaState = useMediaStore.getState();
    speakingRef.current = mediaState.micEnabled && mediaState.localSpeaking;

    // ── spatial audio listener (FR-2.10) ────────────────────────────────────
    // Positioned at the head, and oriented by the AVATAR's facing rather than
    // the camera's. Standing still and orbiting must not swing everyone's voices
    // around the room — which is also why the avatar's yaw is decoupled from the
    // camera's above.
    spatialAudio.setListener(
      position.x,
      feetY + tuning.avatarHeightM,
      position.z,
      avatarYaw.current,
    );

    // ── camera placement ────────────────────────────────────────────────────
    scratch.target.set(position.x, feetY + TUNING.CAMERA_TARGET_HEIGHT_M, position.z);

    const cosPitch = Math.cos(cameraPitch.current);
    scratch.direction
      .set(
        Math.sin(cameraYaw.current) * cosPitch,
        Math.sin(cameraPitch.current),
        Math.cos(cameraYaw.current) * cosPitch,
      )
      .normalize();

    const distance = clampCameraDistance(
      physics.world,
      scratch.target,
      scratch.direction,
      cameraDistance.current,
      physics.collider,
    );

    scratch.cameraPos.copy(scratch.target).addScaledVector(scratch.direction, distance);
    camera.position.lerp(scratch.cameraPos, 1 - Math.exp(-18 * delta));
    camera.up.copy(UP);
    camera.lookAt(scratch.target);

    // FR-4.9 — your own nameplate fades on the same rule as everyone else's. It
    // is never far, but zooming the camera all the way out should not leave one
    // name at full strength while the rest have gone.
    distanceRef.current = camera.position.distanceTo(scratch.target);
  });

  return (
    <Avatar
      ref={avatarRef}
      localId={localId}
      displayName={displayName || 'You'}
      appearance={appearance}
      tuning={tuning}
      isSelf
      idle={isIdle}
      status={status}
      speakingRef={speakingRef}
      distanceRef={distanceRef}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}
