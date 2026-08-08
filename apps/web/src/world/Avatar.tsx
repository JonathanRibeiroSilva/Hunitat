/**
 * A participant's avatar — phase 4.
 *
 * Phase 1 shipped a capsule with a facing cone. This replaces it with the
 * animated figure from `assets/avatars` (ADR 0010), plus everything that hangs
 * off an avatar rather than off the HUD: the nameplate (`FR-4.9`), the presence
 * status (`FR-4.10`), the speaking ring (`FR-4.12`) and the emote burst
 * (`FR-4.14`).
 *
 * All of it is drawn by the renderer, not by the DOM. drei's `<Html>` is the
 * obvious way to put a name over someone's head and costs a layout
 * recalculation per avatar per frame; with the fifteen visible participants
 * `NFR-11` targets, that is measurable. Troika text goes through the same
 * machinery as the rest of the scene.
 *
 * The model is built, mutated and disposed imperatively rather than through
 * React. A `<primitive>` swapped on every appearance change would tear down the
 * animation mixer with it and restart everyone's walk cycle whenever anybody
 * moved a colour slider.
 *
 * Emotes are consumed here, for both the local participant and remote ones —
 * one path, so a wave looks the same to the person who sent it as to everyone
 * who received it.
 */

import { Billboard, Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { TUNING, type AvatarAppearance, type ClientTuning } from '@hubitat/protocol';
import { emoteSignals } from '../state/store.js';
import { AvatarAnimator } from './avatarAnimator.js';
import {
  applyAppearance,
  avatarModel,
  createAvatarInstance,
  disposeAvatarInstance,
  type AvatarInstance,
} from './avatarModel.js';

const HEIGHT = TUNING.AVATAR_HEIGHT_M;

/**
 * What troika's text mesh exposes beyond a plain `Mesh`.
 *
 * `fillOpacity` and `text` are set imperatively from `useFrame` — routing a
 * per-frame fade or an emoji change through React props would re-render the
 * scene at frame rate, which is the whole thing this client is arranged to
 * avoid. `sync()` is what makes a changed string reach the GPU.
 */
interface TroikaText extends THREE.Mesh {
  fillOpacity: number;
  /**
   * The outline is a SECOND draw pass with its own opacity, and it defaults to
   * 1. Fading only `fillOpacity` makes a nameplate dissolve into a dark halo of
   * itself which then pops out of existence at the hide radius — the exact
   * "vanish instead of fade" that `NAMEPLATE_HIDE_M` is validated against.
   */
  outlineOpacity: number;
  text: string;
  sync(): void;
}

/** How solid an idle participant looks. Exported because remote avatars set
 *  opacity per frame to fade in and out (FR-1.17), and the two paths disagreeing
 *  would make idle remotes visibly change on the frame their fade completes. */
export const IDLE_OPACITY = 0.55;

/** Nameplate baseline, a little above the crown. */
const PLATE_Y = HEIGHT + 0.26;

/** How long the emoji burst rises for, independent of the clip: a glyph that
 *  hangs around for a five-second dance stops reading as a reaction. */
const BURST_MS = 1800;

export type PresenceStatus = 'available' | 'away' | 'do-not-disturb';

export interface AvatarHandle {
  /** The transform group, positioned and rotated by the owning component. */
  readonly group: THREE.Group | null;
  /** Locomotion. Null until the shared model has finished loading. */
  readonly animator: AvatarAnimator | null;
}

export interface AvatarProps {
  /** Instance-local id — the key emotes arrive under. */
  localId: number;
  displayName: string;
  appearance: AvatarAppearance;
  tuning: ClientTuning;
  /** The local participant gets a floor ring, because picking yourself out of a
   *  crowd in third person is otherwise guesswork. */
  isSelf?: boolean;
  idle?: boolean;
  status?: PresenceStatus;
  /**
   * FR-4.12 — the Phase 2 speaking signal.
   *
   * `FR-4.13` (a muted participant never shows it) rests on the SFU dropping a
   * muted publisher from its active-speaker set. That is a **behaviour, not a
   * structure**: `setMicrophoneEnabled(false)` mutes the track rather than
   * unpublishing it — livekit-client only unpublishes for screen share — so the
   * publication survives and a delayed or missed `ActiveSpeakersChanged` would
   * leave a ring on somebody who is muted. Callers therefore gate this ref on
   * their own `micEnabled` where they can know it.
   *
   * A ref, not a prop value: LiveKit re-emits on every level change, and routing
   * that through React would re-render the scene several times a second.
   */
  speakingRef?: { current: boolean };
  /** Metres to the camera, for the nameplate fade. Written per frame by the
   *  owner, which already has the interpolated position — a second traversal
   *  per avatar per frame is the cost this file exists to avoid. */
  distanceRef?: { current: number };
  /**
   * 0..1 opacity for the whole avatar — the area-of-interest fade of `FR-1.17`.
   *
   * Owned by the caller (only remote avatars fade) and applied here, because
   * here is what knows which materials belong to this instance. A caller
   * traversing the group instead would also catch the nameplate, whose opacity
   * is already being driven by distance, and the two would multiply twice.
   */
  fadeRef?: { current: number };
}

export const Avatar = forwardRef<AvatarHandle, AvatarProps>(function Avatar(
  {
    localId,
    displayName,
    appearance,
    tuning,
    isSelf = false,
    idle = false,
    status = 'available',
    speakingRef,
    distanceRef,
    fadeRef,
  },
  ref,
) {
  const groupRef = useRef<THREE.Group>(null);
  const instanceRef = useRef<AvatarInstance | null>(null);
  const animatorRef = useRef<AvatarAnimator | null>(null);

  // Read by the build effect, so a first render that already carries a
  // customization never draws one frame of the default.
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  useImperativeHandle(
    ref,
    () => ({
      get group() {
        return groupRef.current;
      },
      get animator() {
        return animatorRef.current;
      },
    }),
    [],
  );

  /**
   * Build the instance once, and tear it down completely.
   *
   * Phase 4 risk nº3: fifteen avatars appearing and disappearing without
   * disposal breaches `NFR-14` inside the hour. The materials are this
   * instance's and are freed; the geometry belongs to the shared model and must
   * survive, or disposing one avatar blanks the room.
   */
  useEffect(() => {
    const group = groupRef.current;
    const model = avatarModel();
    if (!group) return;
    if (!model) {
      // Not expected to be reachable: `loadWorld` awaits the model before the
      // scene is ever shown, and the model is retained across a map transfer so
      // that the world being left cannot pull it out from under the world being
      // entered. Said out loud anyway, because the failure is otherwise a
      // nameplate floating over nothing — which reads as a driver or renderer
      // fault, and nothing else in the client reports it.
      console.error(
        '[avatar] the shared model was not loaded when an avatar mounted; the figure ' +
          'will be missing. This is a world-lifecycle bug, not a problem with the asset.',
      );
      return;
    }

    const instance = createAvatarInstance(model, appearanceRef.current);
    instanceRef.current = instance;
    group.add(instance.root);

    const animator = new AvatarAnimator(instance.root, instance.clips, tuning);
    animatorRef.current = animator;

    return () => {
      animator.dispose();
      group.remove(instance.root);
      disposeAvatarInstance(instance);
      animatorRef.current = null;
      instanceRef.current = null;
    };
    // Appearance is applied in place below, never by rebuilding: FR-4.7 permits
    // a respawn, and not needing one keeps the mixer's state.
    //
    // Depends on the two values the animator actually reads, not on the tuning
    // object. `JOINED` mints a fresh object on every join INCLUDING a resume, so
    // a two-second reconnect blip would otherwise dispose and rebuild every
    // avatar in the room — restarting every walk cycle and dropping any emote in
    // flight, which is precisely what building imperatively was meant to avoid.
  }, [tuning.animationCrossfadeMs, tuning.runAnimationThresholdMps]);

  // FR-4.6, FR-4.7 — an instant swap that keeps the animation running.
  useEffect(() => {
    if (instanceRef.current) applyAppearance(instanceRef.current, appearance);
  }, [appearance]);

  /**
   * FR-1.17 fade and FR-4.10 idle dimming, applied to this instance's materials.
   *
   * Five materials, not a traversal of twenty-five meshes: the instance already
   * knows which materials are its own, and they are shared across its parts by
   * construction.
   */
  const wasTransparent = useRef(false);
  useFrame(() => {
    const instance = instanceRef.current;
    if (!instance) return;

    const opacity = (fadeRef?.current ?? 1) * (idle ? IDLE_OPACITY : 1);
    const transparent = opacity < 1;

    for (const material of instance.materials.values()) {
      // `transparent` decides which render list the mesh lands in and how the
      // shader is compiled, so it needs `needsUpdate` — but only on the frames
      // it actually flips, which is twice per fade rather than sixty times a
      // second. `opacity` alone is a uniform and needs nothing.
      if (wasTransparent.current !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      material.opacity = opacity;
    }
    wasTransparent.current = transparent;
  });

  return (
    <group ref={groupRef}>
      {/* The figure itself is added imperatively by the effect above. */}
      {isSelf && <SelfMarker />}

      <Nameplate
        name={displayName}
        idle={idle}
        status={status}
        speakingRef={speakingRef}
        distanceRef={distanceRef}
        fadeRef={fadeRef}
        fadeStartM={tuning.nameplateFadeStartM}
        hideM={tuning.nameplateHideM}
      />

      <EmoteBurst localId={localId} animatorRef={animatorRef} />
    </group>
  );
});

/**
 * A soft ring on the floor under the local participant.
 *
 * Under rather than around: an outline shell on a figure made of boxes shows
 * every seam, and the question being answered — "which one am I" — is answered
 * by the floor without touching the character at all.
 */
function SelfMarker() {
  return (
    <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.34, 0.42, 32]} />
      <meshBasicMaterial color="#f8fafc" transparent opacity={0.35} depthWrite={false} />
    </mesh>
  );
}

/**
 * FR-4.9, FR-4.10, FR-4.12 — name, status and speaking, above the head.
 *
 * Fades with distance rather than shrinking to an unreadable speck, and is gone
 * past `NAMEPLATE_HIDE_M`. The Phase 4 Rules ask for readability in crowds and
 * rule out full de-overlap layout, which is expensive and jitters — so the far
 * ones fade and the near ones win, which is the sort by distance the rule asks
 * for and nothing more.
 */
function Nameplate({
  name,
  idle,
  status,
  speakingRef,
  distanceRef,
  fadeRef,
  fadeStartM,
  hideM,
}: {
  name: string;
  idle: boolean;
  status: PresenceStatus;
  speakingRef?: { current: boolean };
  distanceRef?: { current: number };
  fadeRef?: { current: number };
  fadeStartM: number;
  hideM: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const textRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const glyphRef = useRef<THREE.Mesh>(null);

  const pulse = useRef(0);

  useFrame((_, delta) => {
    const group = groupRef.current;
    if (!group) return;

    const distance = distanceRef?.current ?? 0;
    const span = Math.max(0.001, hideM - fadeStartM);
    const byDistance = distance <= fadeStartM ? 1 : Math.max(0, 1 - (distance - fadeStartM) / span);
    const fade = byDistance * (fadeRef?.current ?? 1);

    group.visible = fade > 0.02;
    if (!group.visible) return;

    // Idle dims the plate as well as the body, so the two never disagree about
    // whether someone is really here.
    const opacity = fade * (idle ? IDLE_OPACITY : 1);

    const text = textRef.current as TroikaText | null;
    if (text) {
      text.fillOpacity = opacity;
      text.outlineOpacity = opacity;
    }

    const glyph = glyphRef.current;
    if (glyph) (glyph.material as THREE.Material).opacity = opacity;

    // FR-4.12 — driven by the live signal with a short decay, never by a timer.
    // A timer is how a speaking indicator ends up stuck on.
    const ring = ringRef.current;
    if (ring) {
      pulse.current = speakingRef?.current
        ? Math.min(1, pulse.current + delta * 8)
        : Math.max(0, pulse.current - delta * 6);
      ring.visible = pulse.current > 0.01;
      (ring.material as THREE.Material).opacity = pulse.current * opacity * 0.9;
      ring.scale.setScalar(1 + Math.sin(performance.now() / 150) * 0.07 * pulse.current);
    }
  });

  return (
    <Billboard ref={groupRef} position={[0, PLATE_Y, 0]}>
      {/* Speaking ring, behind the text. */}
      <mesh ref={ringRef} visible={false} position={[0, 0, -0.01]}>
        <ringGeometry args={[0.21, 0.25, 28]} />
        <meshBasicMaterial color="#4ade80" transparent opacity={0} depthWrite={false} />
      </mesh>

      <StatusGlyph ref={glyphRef} status={status} />

      <Text
        ref={textRef}
        fontSize={0.2}
        color="#f8fafc"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.014}
        outlineColor="#0f172a"
        maxWidth={4}
      >
        {name}
      </Text>
    </Billboard>
  );
}

const STATUS_COLOR: Record<PresenceStatus, string> = {
  available: '#4ade80',
  away: '#fbbf24',
  'do-not-disturb': '#f87171',
};

/**
 * FR-4.10 — presence status on the avatar.
 *
 * Shape as well as colour: available is a filled dot, away a hollow ring,
 * do-not-disturb a bar. The UX rule that colour is never the only signal does
 * not stop applying because the pixels are in the world instead of the HUD.
 *
 * Placed beside the name rather than centred on it, so a long name and a status
 * never compete for the same pixels.
 */
const StatusGlyph = forwardRef<THREE.Mesh, { status: PresenceStatus }>(function StatusGlyph(
  { status },
  ref,
) {
  return (
    <mesh ref={ref} position={[-0.44, 0.15, 0]}>
      {status === 'do-not-disturb' ? (
        <planeGeometry args={[0.15, 0.05]} />
      ) : status === 'away' ? (
        <ringGeometry args={[0.036, 0.062, 18]} />
      ) : (
        <circleGeometry args={[0.055, 18]} />
      )}
      <meshBasicMaterial color={STATUS_COLOR[status]} transparent opacity={1} depthWrite={false} />
    </mesh>
  );
});

/**
 * FR-4.14, FR-4.15 — the emote, played on the avatar and burst above it.
 *
 * The whole emote path lives here: the signal map is read inside `useFrame`,
 * the animation clip is started on the animator, and the glyph rises and fades.
 * Nothing goes through React state — an emote is a per-frame event and someone
 * leaning on a key would otherwise re-render the scene on every press.
 *
 * `at` is what makes two identical emotes in a row distinguishable. Comparing
 * the emote id instead would silently swallow the second wave.
 */
function EmoteBurst({
  localId,
  animatorRef,
}: {
  localId: number;
  animatorRef: React.MutableRefObject<AvatarAnimator | null>;
}) {
  const textRef = useRef<THREE.Mesh>(null);
  const consumedAt = useRef(0);
  const startedAt = useRef(0);

  useFrame(() => {
    const text = textRef.current as TroikaText | null;
    if (!text) return;

    const signal = emoteSignals.get(localId);
    if (signal && signal.at !== consumedAt.current) {
      consumedAt.current = signal.at;
      startedAt.current = signal.at;
      text.text = signal.glyph;
      // Troika rasterises on sync, not on assignment. Without this the glyph
      // changes only the next time some other prop happens to change.
      text.sync();
      // The animator may still be null on the frame an emote lands — the model
      // loads before the world is shown, but a participant can be added in the
      // same frame their avatar mounts. The burst plays either way, which is the
      // half that reads at a distance anyway.
      animatorRef.current?.play(signal.clip, signal.durationMs);
    }

    if (startedAt.current === 0) {
      text.visible = false;
      return;
    }

    const progress = (performance.now() - startedAt.current) / BURST_MS;
    if (progress >= 1) {
      startedAt.current = 0;
      text.visible = false;
      return;
    }

    text.visible = true;
    // LOCAL to the billboard, which already sits at PLATE_Y + 0.3. Adding the
    // anchor height again here put the glyph 4.5 m above the feet — nearly three
    // metres over the avatar's head and usually out of frame, which reads as
    // "the emoji sometimes doesn't appear".
    text.position.y = progress * 0.55;
    // Quick in, slow out — a reaction that fades as fast as it appears reads as
    // a glitch.
    text.fillOpacity = progress < 0.12 ? progress / 0.12 : 1 - (progress - 0.12) / 0.88;
  });

  return (
    <Billboard position={[0, PLATE_Y + 0.3, 0]}>
      {/* Empty until an emote arrives; the glyph is set imperatively above. */}
      <Text ref={textRef} fontSize={0.34} anchorX="center" anchorY="middle" visible={false}>
        {''}
      </Text>
    </Billboard>
  );
}

/**
 * Stable per-participant colour, retained from phase 1.
 *
 * Still used where a HUD element needs to stand for someone and an appearance
 * is not the right thing to show — the presence list is a list of names, not of
 * avatars.
 */
export function colorForId(localId: number): string {
  const hue = (localId * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 62%, 58%)`;
}
