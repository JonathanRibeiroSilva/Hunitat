/**
 * The media client — LiveKit room lifecycle and subscription control.
 *
 * The division of labour that makes phase 2 work (ADR 0006):
 *
 *   the server decides WHO      →  `resolveAudience()` on the 20 Hz tick,
 *                                  shipped as the AUDIENCE frame
 *   this file APPLIES it        →  `setSubscribed()` per track, against the SFU
 *   `spatialAudio` PLAYS it     →  PannerNode gain and direction, per frame
 *
 * Subscription churn is a client operation against the SFU, so walking past
 * someone costs no server round-trip (FR-2.14, FR-2.15). Nothing here decides
 * who may be heard — a client that ignored the audience could only reach people
 * the server had already told it about, and Phase 7's force-mute lives in the
 * token's `canPublish`, not in a check on this side.
 *
 * Lives outside React entirely, like the world socket. It pushes rare changes
 * into `mediaStore`; per-frame work never comes through here.
 */

import {
  ConnectionState,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { AudienceEntryPayload, ClientTuning, MediaGrant } from '@hubitat/protocol';
import { useMediaStore, videoKey, type MediaFault } from '../state/mediaStore.js';
import { spatialAudio } from './spatialAudio.js';

/**
 * Simulcast layer by distance (FR-2.18).
 *
 * Someone across the room does not need the same pixels as someone you are
 * talking to. The thresholds are fractions of the visible range rather than
 * absolute metres, so retuning `MAX_VISIBLE_DISTANCE_M` moves them with it.
 */
const HIGH_QUALITY_FRACTION = 0.35;
const MEDIUM_QUALITY_FRACTION = 0.7;

class MediaClient {
  private room: Room | null = null;
  private tuning: ClientTuning | null = null;
  /** The last audience applied, so a reconnect can re-apply it. */
  private audience: AudienceEntryPayload[] = [];

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Join the room for this world instance.
   *
   * `grant` is null when the server has no SFU configured — a supported state,
   * not an error. Presence carries on and the controls render as unavailable,
   * which is the FR-2.5 rule about not breaking presence applied to the SFU
   * rather than to a device.
   */
  async connect(grant: MediaGrant | null, tuning: ClientTuning): Promise<void> {
    const store = useMediaStore.getState();
    this.tuning = tuning;
    spatialAudio.configure(tuning);

    if (!grant) {
      store.setStatus('unavailable');
      return;
    }

    // getUserMedia is unavailable outside a secure context, and the error it
    // throws names nothing useful. Saying so up front is the difference between
    // "media is broken" and "open this over https or localhost".
    if (!window.isSecureContext) {
      store.setStatus('failed');
      store.setFault('insecure-context', 'Microphone and camera need HTTPS or localhost.');
      return;
    }

    // A resume reissues JOINED with a fresh token for the same session. Tearing
    // the room down and rebuilding it would drop every track and every audio
    // node for a two-second network blip — the glitch FR-2.15 forbids, self
    // inflicted. Already in the right room as the right person is nothing to do.
    if (
      this.room?.state === ConnectionState.Connected &&
      this.room.localParticipant.identity === grant.identity &&
      this.room.name === grant.room
    ) {
      store.setStatus('ready');
      this.applyAudience(this.audience);
      return;
    }

    if (this.room) await this.disconnect();
    store.setStatus('connecting');

    const room = new Room({
      // Nothing arrives until the audience says so. This is FR-2.16 at the
      // transport level: with autoSubscribe on, a room of 50 would deliver 50
      // streams and the audience would only ever be able to turn them off after
      // the bandwidth had already been spent.
      adaptiveStream: false,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
    });
    this.room = room;
    this.bind(room);

    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
    } catch (error) {
      this.room = null;
      store.setStatus('failed');
      store.setFault('connect-failed', describe(error));
      return;
    }

    // The context needs a user gesture, and joining is one — but the click is
    // several frames behind us by now, so a browser that refuses is reported
    // rather than left as silence with no explanation.
    if (!(await spatialAudio.resume())) {
      store.setFault('audio-blocked', 'Click anywhere to enable audio playback.');
    }

    store.setStatus('ready');
    await this.refreshDevices();
    this.applyAudience(this.audience);
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.audience = [];

    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    spatialAudio.dispose();
    useMediaStore.getState().reset();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Local capture (FR-2.1 – FR-2.4)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * FR-2.3 — mute and unmute.
   *
   * `setMicrophoneEnabled(false)` **mutes** the track; livekit-client only
   * unpublishes for screen share. So no audio leaves the machine, which is what
   * the Phase 2 Rules require, but the publication itself survives — and the
   * speaking signal is therefore suppressed by the SFU dropping a muted
   * publisher from its active-speaker set rather than by there being nothing to
   * measure.
   *
   * A behaviour, not a structure. FR-2.21 / AC-2.5 / FR-4.13 hold on it, so
   * anything drawing a speaking indicator gates on `micEnabled` as well wherever
   * it can know it.
   */
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const store = useMediaStore.getState();
    // `FR-7.5` — a force-mute overrides the target's own unmute. The permission
    // is revoked at the SFU, so this is not what enforces it; this is what stops
    // the button flickering on and then off again while LiveKit refuses the
    // publish, which reads as a broken microphone rather than as a moderation.
    if (enabled && store.forcedMute.micMuted) return;
    // Optimistic: the Rules ask for immediate local feedback, and the round-trip
    // to the SFU is not instant. Reverted below if the device refuses.
    store.setPublishing({ micEnabled: enabled });

    try {
      await this.room?.localParticipant.setMicrophoneEnabled(enabled);
      if (enabled) store.setFault(null);
    } catch (error) {
      store.setPublishing({ micEnabled: false });
      store.setFault(faultFor(error), describe(error));
    }
    await this.refreshDevices();
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    const store = useMediaStore.getState();
    // `FR-7.6`, the same reasoning as the microphone above.
    if (enabled && store.forcedMute.cameraDisabled) return;
    store.setPublishing({ cameraEnabled: enabled });

    try {
      await this.room?.localParticipant.setCameraEnabled(enabled);
      if (enabled) store.setFault(null);

      // FR-2.4 — the self-view is the local track, rendered without going
      // through the SFU. There is no reason to pay a round-trip to see yourself.
      const publication = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
      store.setSelfVideo(enabled ? ((publication?.track as LocalVideoTrack) ?? null) : null);
    } catch (error) {
      store.setPublishing({ cameraEnabled: false });
      store.setSelfVideo(null);
      store.setFault(faultFor(error), describe(error));
    }
    await this.refreshDevices();
  }

  /**
   * `FR-7.5`, `FR-7.6` — a moderator took something away, or gave it back.
   *
   * Stops publishing immediately rather than waiting for the SFU to refuse:
   * the permission is revoked server-side either way, so this is not what makes
   * the mute hold. It is what makes the microphone light on the target's own
   * machine go out at the same moment everybody else stops hearing them, which
   * is the difference between "I was muted" and "my microphone broke".
   *
   * Restoring a permission deliberately does **not** turn anything back on. The
   * moderator gave permission; whether to speak again is the person's own
   * decision, and a camera that switched itself back on would be a worse
   * surprise than the mute was.
   */
  async applyModeration(state: { micMuted: boolean; cameraDisabled: boolean }): Promise<void> {
    const store = useMediaStore.getState();
    store.setForcedMute(state);

    if (state.micMuted && store.micEnabled) await this.setMicrophoneEnabled(false);
    if (state.cameraDisabled) {
      if (store.cameraEnabled) await this.setCameraEnabled(false);
      if (store.screenShareEnabled) await this.setScreenShareEnabled(false);
    }
  }

  /** FR-2.19, FR-2.20 — one presenter stream, subject to the same audience. */
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    const store = useMediaStore.getState();
    // `FR-7.6` — camera and screen share are one permission on the SFU, so
    // disabling video disables both.
    if (enabled && store.forcedMute.cameraDisabled) return;
    try {
      await this.room?.localParticipant.setScreenShareEnabled(enabled);
      store.setPublishing({ screenShareEnabled: enabled });
    } catch (error) {
      // No fault is raised here on purpose. Screen capture always goes through
      // the browser's own picker, so the overwhelmingly common rejection is
      // "the user closed it" — and browsers report that with the same
      // `NotAllowedError` as a real block. Telling someone their permissions are
      // broken because they changed their mind is worse than saying nothing;
      // the button springing back is the feedback.
      store.setPublishing({ screenShareEnabled: false });
      if (!(error instanceof Error) || faultFor(error) !== 'permission-denied') {
        store.setFault(faultFor(error), describe(error));
      }
    }
  }

  /** FR-2.2 — switch input device while connected. */
  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    const store = useMediaStore.getState();
    try {
      await this.room?.switchActiveDevice(kind, deviceId);
      store.setActiveDevice(kind as 'audioinput' | 'videoinput', deviceId);
    } catch (error) {
      store.setFault(faultFor(error), describe(error));
    }
  }

  /**
   * Enumerate inputs.
   *
   * Labels are blank until a permission has been granted once, which is a browser
   * privacy rule rather than a bug — so this runs again after every capture
   * attempt, when the list is finally nameable.
   */
  async refreshDevices(): Promise<void> {
    try {
      const [microphones, cameras] = await Promise.all([
        Room.getLocalDevices('audioinput'),
        Room.getLocalDevices('videoinput'),
      ]);
      useMediaStore.getState().setDevices(microphones, cameras);
    } catch {
      /* enumeration failing is not worth a fault state; the pickers stay empty */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Applying the server's decision
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * FR-2.11, FR-2.12, FR-2.14, FR-2.16 — subscribe exactly the audience.
   *
   * Everyone not in it is unsubscribed, which is what makes absence mean "not
   * consumed" rather than "consumed and silenced". Gain reaching zero would still
   * cost the bandwidth this exists to save (ADR 0007).
   */
  applyAudience(targets: AudienceEntryPayload[]): void {
    this.audience = targets;
    useMediaStore.getState().setAudience(targets);

    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;

    const wanted = new Map(targets.map((target) => [target.sessionId, target]));

    for (const [identity, participant] of room.remoteParticipants) {
      const target = wanted.get(identity);

      for (const publication of participant.trackPublications.values()) {
        const audio =
          publication.source === Track.Source.Microphone ||
          publication.source === Track.Source.ScreenShareAudio;

        // Video follows the visible flag, audio follows membership. A single
        // rule would either blast video across the audible range or cut audio at
        // the visible one, and FR-2.7 exists precisely because the two differ.
        const subscribe = target !== undefined && (audio || target.visible);

        if (publication.isSubscribed !== subscribe) publication.setSubscribed(subscribe);
        if (subscribe && !audio && target) this.applyQuality(publication, target.distanceM);
      }

      // The zone override, applied to whatever is already playing. Doing it here
      // rather than on subscribe means someone who walks into a private zone
      // mid-sentence has their gain corrected on the next audience frame instead
      // of on their next reconnect.
      if (target && spatialAudio.has(identity)) {
        spatialAudio.setReason(identity, target.reason, target.gain);
      }
    }

    // A participant who left the audience while their track was still attached
    // must be released, not merely unsubscribed — the graph node and its
    // `<audio>` element are ours to free (NFR-14).
    for (const identity of spatialAudio.attachedIdentities) {
      if (!wanted.has(identity)) spatialAudio.detach(identity);
    }

    this.pruneVideos(wanted);
  }

  /** FR-2.18 — distant video costs fewer pixels before it costs nothing. */
  private applyQuality(publication: RemoteTrackPublication, distanceM: number): void {
    const range = this.tuning?.maxVisibleDistanceM ?? 8;
    const ratio = range > 0 ? distanceM / range : 1;

    publication.setVideoQuality(
      ratio <= HIGH_QUALITY_FRACTION
        ? VideoQuality.HIGH
        : ratio <= MEDIUM_QUALITY_FRACTION
          ? VideoQuality.MEDIUM
          : VideoQuality.LOW,
    );
  }

  private pruneVideos(wanted: Map<string, AudienceEntryPayload>): void {
    const store = useMediaStore.getState();
    for (const [key, video] of store.videos) {
      const target = wanted.get(video.identity);
      if (!target || !target.visible) store.removeVideo(key);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Room events
  // ───────────────────────────────────────────────────────────────────────────

  private bind(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) =>
      this.onSubscribed(track, publication, participant),
    );
    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) =>
      this.onUnsubscribed(track, publication, participant),
    );

    // A participant who joins after the audience was computed still has to be
    // caught up, or they stay silent until the next time the set happens to
    // change — which, standing still, is never.
    room.on(RoomEvent.TrackPublished, () => this.applyAudience(this.audience));
    room.on(RoomEvent.ParticipantConnected, () => this.applyAudience(this.audience));

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      spatialAudio.detach(participant.identity);
      const store = useMediaStore.getState();
      store.removeVideo(videoKey(participant.identity, 'camera'));
      store.removeVideo(videoKey(participant.identity, 'screen'));
    });

    // FR-2.21 — the signal other phases consume. LiveKit derives it from the
    // published track, so a muted mic cannot produce one: there is no track.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const localIdentity = room.localParticipant.identity;
      // Self is split out rather than dropped. The video tiles have no use for
      // it, but phase 4 does: in third person you are looking at your own
      // avatar, and a speaking ring that appears on everyone but you reads as a
      // broken microphone (FR-4.12).
      useMediaStore.getState().setSpeaking(
        speakers
          .filter((speaker) => speaker.identity !== localIdentity)
          .map((speaker) => speaker.identity),
        speakers.some((speaker) => speaker.identity === localIdentity),
      );
    });

    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === Track.Source.Camera) {
        useMediaStore.getState().setSelfVideo((publication.track as LocalVideoTrack) ?? null);
      }
    });

    room.on(RoomEvent.MediaDevicesError, (error: Error) => {
      useMediaStore.getState().setFault(faultFor(error), describe(error));
    });

    room.on(RoomEvent.Disconnected, () => {
      useMediaStore.getState().setStatus('connecting');
    });

    room.on(RoomEvent.Reconnected, () => {
      useMediaStore.getState().setStatus('ready');
      this.applyAudience(this.audience);
    });
  }

  private onSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (track instanceof RemoteAudioTrack) {
      const target = useMediaStore.getState().audience.get(participant.identity);
      // Routed through Web Audio rather than played by an element. The element
      // exists only to satisfy Chrome; it is muted (see spatialAudio).
      spatialAudio.attach(
        participant.identity,
        publication.source === Track.Source.ScreenShareAudio ? 'screen' : 'mic',
        track.mediaStreamTrack,
        target?.reason ?? 'proximity',
      );
      spatialAudio.setReason(
        participant.identity,
        target?.reason ?? 'proximity',
        target?.gain ?? 1,
      );
      return;
    }

    if (track instanceof RemoteVideoTrack) {
      useMediaStore.getState().addVideo({
        identity: participant.identity,
        displayName: participant.name || participant.identity.slice(0, 8),
        track,
        publication,
        source: publication.source === Track.Source.ScreenShare ? 'screen' : 'camera',
      });
    }
  }

  private onUnsubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (track instanceof RemoteAudioTrack) {
      // Only the stream that went away. Detaching the participant wholesale
      // would silence their voice when they stopped sharing a screen.
      spatialAudio.detachSource(
        participant.identity,
        publication.source === Track.Source.ScreenShareAudio ? 'screen' : 'mic',
      );
      return;
    }
    useMediaStore
      .getState()
      .removeVideo(
        videoKey(
          participant.identity,
          publication.source === Track.Source.ScreenShare ? 'screen' : 'camera',
        ),
      );
  }
}

/**
 * FR-2.5 — the two failures that need distinct wording.
 *
 * `NotAllowedError` means the user said no and can say yes; `NotFoundError`
 * means there is nothing to say yes to. Collapsing them produces a message that
 * is wrong half the time.
 */
function faultFor(error: unknown): MediaFault {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  return 'connect-failed';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const media = new MediaClient();
