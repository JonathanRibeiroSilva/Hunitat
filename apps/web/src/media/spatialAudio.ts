/**
 * Spatial audio — Web Audio in the browser, one graph per remote speaker.
 *
 * Attenuation and panning are **per-listener** values: the same speaker is loud
 * on your left and faint behind someone else. A server could only produce that
 * by mixing a separate stream per person, which turns the SFU into an MCU and
 * destroys the scaling property FR-2.17 exists to protect. So the SFU relays
 * untouched tracks and this positions them (ADR 0007).
 *
 *   LiveKit MediaStreamTrack
 *     → MediaStreamAudioSourceNode
 *     → PannerNode   distance falloff (FR-2.9) and direction (FR-2.10)
 *     → GainNode     zone overrides, and later moderation and per-user volume
 *     → destination
 *
 * The extra gain stage after the panner is where non-geometric rules land, so
 * they compose with distance instead of fighting it. A private zone sets it to
 * 1 and bypasses the panner's distance model entirely — that is FR-3.8's "regardless
 * of distance", expressed in the graph rather than in a special case.
 *
 * ── Two things that will waste a day if forgotten ───────────────────────────
 *
 * 1. **Chrome will not feed a WebRTC track into Web Audio** unless the track is
 *    also attached to a *playing* media element. So every remote track gets a
 *    muted, autoplaying, off-screen `<audio>` element alongside the graph. Without
 *    it the graph runs and produces silence, and it presents as a spatial-audio
 *    maths bug rather than a plumbing one.
 * 2. **`AudioContext` starts suspended** until a user gesture. `resume()` belongs
 *    in the join flow, which is a click.
 */

import type { ClientTuning } from '@hubitat/protocol';

/** How the audience says a speaker is reaching this listener. */
export type AudienceReason = 'proximity' | 'private-zone' | 'spotlight';

/**
 * One participant can publish two audio streams — their microphone and the audio
 * of a screen they are sharing. Both are positioned at the same place and both
 * obey the same audience decision, but they are separate graphs: keying only by
 * identity means the second one silently replaces the first, and the symptom is
 * "sharing a video muted them".
 */
export type AudioSource = 'mic' | 'screen';

interface SpeakerNode {
  readonly identity: string;
  readonly node: MediaStreamAudioSourceNode;
  readonly panner: PannerNode;
  readonly gain: GainNode;
  /** The Chrome workaround. Muted, so it contributes no sound of its own. */
  readonly element: HTMLAudioElement;
  readonly stream: MediaStream;
  reason: AudienceReason;
}

const keyFor = (identity: string, source: AudioSource): string => `${identity}#${source}`;
const AUDIO_SOURCES: readonly AudioSource[] = ['mic', 'screen'];

export class SpatialAudio {
  private context: AudioContext | null = null;
  private readonly speakers = new Map<string, SpeakerNode>();
  private tuning: ClientTuning | null = null;

  /**
   * Off-screen host for the media elements.
   *
   * One container rather than elements scattered through the React tree: their
   * lifetime is the track's, not any component's, and a re-render that unmounted
   * one would silence a speaker for reasons no one would connect to the render.
   */
  private container: HTMLDivElement | null = null;

  configure(tuning: ClientTuning): void {
    this.tuning = tuning;
  }

  /**
   * Start (or resume) the audio context. Must be called from a user gesture.
   *
   * Returns false when the browser has no Web Audio at all — NFR-28 lists it as
   * required, so this is a hard failure the caller surfaces rather than hides.
   */
  async resume(): Promise<boolean> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as WebkitWindow).webkitAudioContext;
      if (!Ctor) return false;
      this.context = new Ctor();
    }
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        return false;
      }
    }
    return this.context.state === 'running';
  }

  get running(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * Route one remote audio track through the graph.
   *
   * Idempotent per (identity, source): re-attaching the same track is a no-op,
   * and a different track replaces the old graph rather than stacking a second
   * one on top of it — which would play the speaker twice, at double volume.
   */
  attach(
    identity: string,
    source: AudioSource,
    track: MediaStreamTrack,
    reason: AudienceReason,
  ): void {
    const context = this.context;
    if (!context || !this.tuning) return;

    const key = keyFor(identity, source);
    const existing = this.speakers.get(key);
    if (existing) {
      if (existing.stream.getAudioTracks()[0] === track) {
        existing.reason = reason;
        return;
      }
      this.detachSource(identity, source);
    }

    const stream = new MediaStream([track]);

    const element = document.createElement('audio');
    element.autoplay = true;
    element.muted = true;
    element.srcObject = stream;
    // Some browsers refuse `play()` on a detached element, so it must be in the
    // document even though nothing renders it.
    this.host().appendChild(element);
    void element.play().catch(() => {
      /* muted autoplay is permitted everywhere we support; nothing to recover */
    });

    const node = context.createMediaStreamSource(stream);

    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = this.tuning.audioRefDistanceM;
    panner.rolloffFactor = this.tuning.audioRolloffFactor;
    // Web Audio does not silence beyond maxDistance, it clamps the falloff
    // there. Silence past the threshold is FR-2.11's job and is enforced by
    // dropping the subscription, not by this number.
    panner.maxDistance = this.tuning.maxAudibleDistanceM;

    const gain = context.createGain();
    gain.gain.value = 1;

    node.connect(panner);
    panner.connect(gain);
    gain.connect(context.destination);

    this.speakers.set(key, {
      identity,
      node,
      panner,
      gain,
      element,
      stream,
      reason,
    });
  }

  /**
   * Tear one stream down completely.
   *
   * Nodes, the element and its `srcObject` all go. NFR-14 counts audio nodes
   * among the things that must be released when a participant leaves; an
   * `<audio>` still holding a MediaStream keeps the whole track alive.
   */
  detachSource(identity: string, source: AudioSource): void {
    const key = keyFor(identity, source);
    const speaker = this.speakers.get(key);
    if (!speaker) return;
    this.speakers.delete(key);

    try {
      speaker.node.disconnect();
      speaker.panner.disconnect();
      speaker.gain.disconnect();
    } catch {
      /* already disconnected */
    }

    speaker.element.pause();
    speaker.element.srcObject = null;
    speaker.element.remove();
  }

  /** Everything this participant is publishing. Used when they leave the
   *  audience or the room — both of which are about the person, not a track. */
  detach(identity: string): void {
    this.detachSource(identity, 'mic');
    this.detachSource(identity, 'screen');
  }

  has(identity: string): boolean {
    return (
      this.speakers.has(keyFor(identity, 'mic')) || this.speakers.has(keyFor(identity, 'screen'))
    );
  }

  get attachedIdentities(): string[] {
    return [...new Set([...this.speakers.values()].map((speaker) => speaker.identity))];
  }

  /**
   * Apply the server's decision for one speaker.
   *
   * `proximity` leaves the panner in charge — the distance model reproduces the
   * gain the server advertised, computed from live positions rather than from a
   * value that is one network hop old.
   *
   * `private-zone` and `spotlight` defeat distance by design (FR-3.8, FR-3.12).
   * The panner is neutralised by placing the speaker at the listener rather than
   * by bypassing the node, so a participant crossing a zone boundary does not
   * have their graph rewired mid-sentence.
   */
  setReason(identity: string, reason: AudienceReason, gain: number): void {
    const context = this.context;
    if (!context) return;

    // Every stream this participant publishes, because the audience decides
    // about the person. A shared screen going quiet while its owner stays audible
    // would be a rule nobody wrote.
    for (const source of AUDIO_SOURCES) {
      const speaker = this.speakers.get(keyFor(identity, source));
      if (!speaker) continue;
      speaker.reason = reason;
      // Short ramp rather than a step: an abrupt gain change is an audible
      // click, and zone transitions happen mid-conversation.
      speaker.gain.gain.setTargetAtTime(gain, context.currentTime, 0.02);
    }
  }

  /**
   * Position one speaker in the world.
   *
   * Called per frame for anyone with an avatar on screen. A zone override wins:
   * the speaker is pinned to the listener instead, so distance attenuation
   * resolves to `refDistance` — no attenuation at all, which is what "regardless
   * of distance" means once it is expressed as geometry rather than as a special
   * case in the graph.
   */
  setSpeakerPosition(identity: string, x: number, y: number, z: number): void {
    const context = this.context;
    if (!context) return;

    for (const source of AUDIO_SOURCES) {
      const speaker = this.speakers.get(keyFor(identity, source));
      if (!speaker || speaker.reason !== 'proximity') continue;
      applyPosition(speaker.panner, x, y, z, context.currentTime);
    }
  }

  private listenerPosition = { x: 0, y: 0, z: 0 };

  /**
   * Keep zone-overridden speakers pinned to the listener as the listener moves.
   *
   * They are the ones with no avatar to drive them: a spotlighted speaker can be
   * 100 m away and outside the area of interest entirely, so nothing else in the
   * client knows where they are — and by FR-3.12 it does not matter.
   */
  private pinOverrides(now: number): void {
    for (const speaker of this.speakers.values()) {
      if (speaker.reason === 'proximity') continue;
      const { x, y, z } = this.listenerPosition;
      applyPosition(speaker.panner, x, y, z, now);
    }
  }

  /**
   * Move the listener. Called every frame from `useFrame`, never through React
   * state (ADR 0002 / ADR 0007).
   *
   * Orientation comes from the avatar's facing rather than the camera's: the
   * camera orbits freely while standing still, and tying the listener to it
   * would swing everyone's voices around the room whenever the user looked
   * about. FR-4.4 promises avatar facing is accurate; this is what depends on it.
   */
  setListener(x: number, y: number, z: number, yaw: number): void {
    const context = this.context;
    if (!context) return;

    this.listenerPosition = { x, y, z };

    const listener = context.listener;
    const now = context.currentTime;
    this.pinOverrides(now);

    // Same convention as the avatar: yaw 0 faces -Z (coordinates-and-units.md).
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);

    if (listener.positionX) {
      listener.positionX.setValueAtTime(x, now);
      listener.positionY.setValueAtTime(y, now);
      listener.positionZ.setValueAtTime(z, now);
      listener.forwardX.setValueAtTime(forwardX, now);
      listener.forwardY.setValueAtTime(0, now);
      listener.forwardZ.setValueAtTime(forwardZ, now);
      listener.upX.setValueAtTime(0, now);
      listener.upY.setValueAtTime(1, now);
      listener.upZ.setValueAtTime(0, now);
      return;
    }

    // Safari, historically. NFR-27 calls out verifying spatial audio there
    // specifically, and this branch is why.
    const legacy = listener as unknown as LegacyListener;
    legacy.setPosition?.(x, y, z);
    legacy.setOrientation?.(forwardX, 0, forwardZ, 0, 1, 0);
  }

  /** Release everything. Called when leaving the world (NFR-14). */
  dispose(): void {
    for (const identity of this.attachedIdentities) this.detach(identity);
    this.container?.remove();
    this.container = null;
    void this.context?.close().catch(() => {
      /* closing a closed context is not an error worth reporting */
    });
    this.context = null;
  }

  private host(): HTMLDivElement {
    if (!this.container) {
      const div = document.createElement('div');
      div.setAttribute('aria-hidden', 'true');
      div.style.position = 'absolute';
      div.style.width = '0';
      div.style.height = '0';
      div.style.overflow = 'hidden';
      document.body.appendChild(div);
      this.container = div;
    }
    return this.container;
  }
}

function applyPosition(panner: PannerNode, x: number, y: number, z: number, now: number): void {
  if (panner.positionX) {
    panner.positionX.setValueAtTime(x, now);
    panner.positionY.setValueAtTime(y, now);
    panner.positionZ.setValueAtTime(z, now);
    return;
  }
  (panner as unknown as LegacyPanner).setPosition?.(x, y, z);
}

interface LegacyListener {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}

interface LegacyPanner {
  setPosition?(x: number, y: number, z: number): void;
}

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

export const spatialAudio = new SpatialAudio();
