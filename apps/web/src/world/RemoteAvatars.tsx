/**
 * Remote participants.
 *
 * FR-1.13: motion must render smoothly despite network gaps. Each remote is
 * rendered ~100 ms behind the newest sample, interpolating between the two
 * samples that bracket the render time (see @hubitat/world-core).
 *
 * FR-1.17 asks for a clean appear/disappear as people cross the area of
 * interest, and specs/ux/phase-01-screens.md is specific about what clean looks
 * like: a short fade, not a pop. So a removed participant stays mounted until
 * their fade finishes — the roster drops them immediately, this does not.
 *
 * Phase 4 adds what the avatar needs to be a character rather than a marker:
 * the interpolated speed and the buffered movement flags drive locomotion
 * (`FR-4.2`), the camera distance drives the nameplate fade (`FR-4.9`), and the
 * speaking set drives the ring (`FR-4.12`).
 *
 * The roster comes from React state — it changes a few times a minute. The
 * transforms, the fade, the animation state and the speaking flag come from
 * refs, read and written inside `useFrame`. Routing any of them through state
 * would re-render the tree at 60 fps (ADR 0002).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Flags, TUNING, type ClientTuning } from '@hubitat/protocol';
import { spatialAudio } from '../media/spatialAudio.js';
import { useMediaStore } from '../state/mediaStore.js';
import { remoteBuffers, useStore, type RosterEntry } from '../state/store.js';
import { Avatar, type AvatarHandle } from './Avatar.jsx';

/** Long enough to read as motion, short enough that someone who left is gone
 *  before you think to look for them. */
const FADE_MS = 220;

/** Where a voice comes out of an avatar. Transforms are reported at the feet
 *  (coordinates-and-units.md), and a panner left down there tilts every voice
 *  toward the floor. */
const HEAD_HEIGHT_M = TUNING.AVATAR_HEIGHT_M;

/**
 * Reduced motion means no fade at all, not a faster one — the UX spec lists
 * avatar fade transitions among the things it must skip.
 *
 * Read once at module load: this does not change mid-session in practice, and
 * re-querying per frame would cost a style recalculation for nothing.
 */
const FADE_DURATION_MS = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ? 0
  : FADE_MS;

export function RemoteAvatars({ tuning }: { tuning: ClientTuning }) {
  const roster = useStore((state) => state.roster);
  const selfId = useStore((state) => state.joined?.localId);

  /**
   * Participants the roster has dropped who are still fading out.
   *
   * Their interpolation buffer is deleted with them, so they fade standing where
   * they were last seen rather than drifting toward a position nobody sent.
   */
  const [leaving, setLeaving] = useState<Map<number, RosterEntry>>(() => new Map());
  const previousRef = useRef(roster);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = roster;

    setLeaving((current) => {
      let next: Map<number, RosterEntry> | null = null;

      for (const entry of previous.values()) {
        if (roster.has(entry.localId) || current.has(entry.localId)) continue;
        next ??= new Map(current);
        next.set(entry.localId, entry);
      }

      // Someone who left and came straight back is present again: the live
      // roster outranks a half-finished fade-out, or they would be rendered
      // twice under the same key.
      for (const localId of current.keys()) {
        if (!roster.has(localId)) continue;
        next ??= new Map(current);
        next.delete(localId);
      }

      // Same reference when nothing changed, so this does not re-render on every
      // roster update.
      return next ?? current;
    });
  }, [roster]);

  const onFaded = useCallback((localId: number) => {
    setLeaving((current) => {
      if (!current.has(localId)) return current;
      const next = new Map(current);
      next.delete(localId);
      return next;
    });
  }, []);

  return (
    <>
      {[...roster.values()]
        .filter((entry) => entry.localId !== selfId)
        .map((entry) => (
          <RemoteAvatar key={entry.localId} entry={entry} tuning={tuning} leaving={false} />
        ))}

      {[...leaving.values()]
        .filter((entry) => entry.localId !== selfId && !roster.has(entry.localId))
        .map((entry) => (
          <RemoteAvatar
            key={entry.localId}
            entry={entry}
            tuning={tuning}
            leaving
            onFaded={onFaded}
          />
        ))}
    </>
  );
}

function RemoteAvatar({
  entry,
  tuning,
  leaving,
  onFaded,
}: {
  entry: RosterEntry;
  tuning: ClientTuning;
  leaving: boolean;
  onFaded?: (localId: number) => void;
}) {
  const camera = useThree((state) => state.camera);
  const avatarRef = useRef<AvatarHandle>(null);

  // Start invisible. Rendering at the origin for one frame before the first
  // sample arrives makes people appear to teleport in from the middle of the
  // world.
  const seenRef = useRef(false);

  // Written here, read inside the avatar. Plain objects rather than state:
  // all three change every frame.
  const fadeRef = useRef(0);
  const distanceRef = useRef(0);
  const speakingRef = useRef(false);

  useFrame((_, delta) => {
    const group = avatarRef.current?.group;
    if (!group) return;

    const sample = remoteBuffers.get(entry.localId)?.sample(performance.now());

    // FR-4.2 — locomotion from the interpolated speed and the flags buffered
    // alongside it, so the animation belongs to the moment being drawn.
    //
    // Outside the sample check on purpose. A participant who has left the area
    // of interest keeps their avatar mounted for the fade, and their buffer is
    // deleted with them — so this is the only path left to tick their mixer.
    // Skipping it freezes them mid-stride during the fade and, because the
    // emote deadline is checked inside `update`, leaves an emote in flight
    // permanently unfinished.
    avatarRef.current?.animator?.update(delta, {
      speed: sample?.speed ?? 0,
      flags: sample?.flags ?? Flags.GROUNDED,
    });

    if (sample) {
      seenRef.current = true;
      group.position.set(sample.x, sample.y, sample.z);
      // FR-4.4 — facing comes from the replicated yaw, the same value that pans
      // this participant's voice. One source, so the body and the sound agree
      // about which way they are turned.
      group.rotation.y = sample.yaw;

      // FR-2.9, FR-2.10 — the voice comes from where the avatar is, from the
      // same interpolated position that is being drawn. Reading the raw network
      // sample instead would put the sound 100 ms ahead of the body.
      //
      // Head height, not feet: a panner at ankle level against a listener at eye
      // level tilts every voice downward.
      spatialAudio.setSpeakerPosition(
        entry.sessionId,
        sample.x,
        sample.y + HEAD_HEIGHT_M,
        sample.z,
      );
    }

    if (!seenRef.current) {
      // Never drawn, so there is nothing to fade out — but they must still be
      // released, or a participant who arrived and left without ever sending a
      // transform stays in the leaving set for the rest of the session.
      if (leaving) onFaded?.(entry.localId);
      return;
    }

    // FR-4.9 — distance to the camera, not to the local avatar. The nameplate
    // is being read by whoever is behind the lens.
    distanceRef.current = camera.position.distanceTo(group.position);

    // FR-4.12 — read rather than subscribed. LiveKit re-emits the active
    // speaker set on every level change, and a hook here would re-render the
    // scene several times a second while anyone is talking.
    speakingRef.current = useMediaStore.getState().speaking.has(entry.sessionId);

    const target = leaving ? 0 : 1;
    if (FADE_DURATION_MS === 0) {
      fadeRef.current = target;
    } else {
      const step = (delta * 1000) / FADE_DURATION_MS;
      fadeRef.current =
        target > fadeRef.current
          ? Math.min(target, fadeRef.current + step)
          : Math.max(target, fadeRef.current - step);
    }

    group.visible = fadeRef.current > 0.001;

    if (leaving && fadeRef.current === 0) onFaded?.(entry.localId);
  });

  return (
    <Avatar
      ref={avatarRef}
      localId={entry.localId}
      displayName={entry.displayName}
      appearance={entry.appearance}
      tuning={tuning}
      idle={entry.activity === 'idle'}
      status={entry.status}
      speakingRef={speakingRef}
      distanceRef={distanceRef}
      fadeRef={fadeRef}
    />
  );
}
