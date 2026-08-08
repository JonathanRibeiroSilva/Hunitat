/**
 * Media state (phase 2).
 *
 * Separate from the world store on purpose. The world store's discipline is that
 * React holds only what changes rarely; media state changes rarely too, but for
 * an unrelated reason — device lists, mute flags and which tiles are on screen.
 * Keeping them apart means a mute toggle does not re-render the presence list
 * and a participant walking past does not re-render the device menu.
 *
 * Nothing here runs per frame. The per-frame work — panner and listener
 * positions — lives in `spatialAudio` and is driven from `useFrame` (ADR 0007).
 */

import { create } from 'zustand';
import type { LocalVideoTrack, RemoteTrackPublication, RemoteVideoTrack } from 'livekit-client';
import {
  NO_MODERATION,
  type AudienceEntryPayload,
  type ParticipantModeration,
} from '@hubitat/protocol';

/**
 * Why media is not usable, when it is not.
 *
 * FR-2.5 requires a clear state for a denied permission or a missing device, and
 * requires presence to survive it. These are the states that surface; none of
 * them affects the world connection.
 */
export type MediaFault =
  'permission-denied' | 'no-device' | 'insecure-context' | 'connect-failed' | 'audio-blocked';

export type MediaStatus =
  /** No SFU configured on the server. Phase 1's development flow. */
  'unavailable' | 'connecting' | 'ready' | 'failed';

export interface RemoteVideo {
  identity: string;
  displayName: string;
  track: RemoteVideoTrack;
  publication: RemoteTrackPublication;
  source: 'camera' | 'screen';
}

interface MediaState {
  status: MediaStatus;
  fault: MediaFault | null;
  /** Detail behind `fault`, for the technical line the UX spec allows. */
  faultDetail: string | null;

  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;

  /**
   * Phase 7, `FR-7.5` / `FR-7.6` — what a moderator has taken away.
   *
   * Separate from the three flags above, and the separation is the point: those
   * are what the person *chose*, this is what they are *allowed*. Collapsing
   * them would make a force-mute look like the user having muted themselves, so
   * unmuting would appear to be one click away — and the click would silently do
   * nothing, which is the failure `FR-7.5` exists to prevent.
   *
   * Mirrored here as well as in the world store because the media controls read
   * only this store, and a control that had to reach into two of them to decide
   * whether it is enabled is a control that will eventually consult one.
   */
  forcedMute: ParticipantModeration;

  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  activeMicrophoneId: string | null;
  activeCameraId: string | null;

  /** FR-2.4 — the local camera, rendered without going through the SFU. */
  selfVideo: LocalVideoTrack | null;

  /** FR-2.21 — identities currently speaking, for other phases and the tiles. */
  speaking: Set<string>;
  /**
   * Whether the LOCAL participant is speaking.
   *
   * Held apart from the set above because the tiles deliberately exclude self —
   * you do not need a video tile of yourself to know you are there. Phase 4 does
   * need it: in third person you watch your own avatar, and a speaking ring that
   * appears on everyone except you reads as a broken microphone (FR-4.12).
   */
  localSpeaking: boolean;

  /** The server's latest decision, keyed by session id (FR-2.6). */
  audience: Map<string, AudienceEntryPayload>;

  /** FR-2.13 — what is on screen right now, keyed by `identity:source`. */
  videos: Map<string, RemoteVideo>;

  setStatus: (status: MediaStatus) => void;
  setFault: (fault: MediaFault | null, detail?: string) => void;
  setPublishing: (
    patch: Partial<Pick<MediaState, 'micEnabled' | 'cameraEnabled' | 'screenShareEnabled'>>,
  ) => void;
  /** `FR-7.5` — the server's word on what this participant may publish. */
  setForcedMute: (forcedMute: ParticipantModeration) => void;
  setDevices: (microphones: MediaDeviceInfo[], cameras: MediaDeviceInfo[]) => void;
  setActiveDevice: (kind: 'audioinput' | 'videoinput', deviceId: string) => void;
  setSelfVideo: (track: LocalVideoTrack | null) => void;
  setSpeaking: (identities: string[], local: boolean) => void;
  setAudience: (targets: AudienceEntryPayload[]) => void;
  addVideo: (video: RemoteVideo) => void;
  removeVideo: (key: string) => void;
  reset: () => void;
}

export const videoKey = (identity: string, source: 'camera' | 'screen'): string =>
  `${identity}:${source}`;

export const useMediaStore = create<MediaState>((set) => ({
  status: 'unavailable',
  fault: null,
  faultDetail: null,

  micEnabled: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  forcedMute: NO_MODERATION,

  microphones: [],
  cameras: [],
  activeMicrophoneId: null,
  activeCameraId: null,

  selfVideo: null,
  speaking: new Set(),
  localSpeaking: false,
  audience: new Map(),
  videos: new Map(),

  setStatus: (status) => set({ status }),
  setFault: (fault, faultDetail) => set({ fault, faultDetail: faultDetail ?? null }),
  setPublishing: (patch) => set(patch),
  setForcedMute: (forcedMute) => set({ forcedMute }),

  setDevices: (microphones, cameras) => set({ microphones, cameras }),
  setActiveDevice: (kind, deviceId) =>
    set(kind === 'audioinput' ? { activeMicrophoneId: deviceId } : { activeCameraId: deviceId }),

  setSelfVideo: (selfVideo) => set({ selfVideo }),

  setSpeaking: (identities, local) =>
    set((state) => {
      // Same-content sets are common — LiveKit re-emits on every level change —
      // and a new Set reference would re-render every subscriber for nothing.
      const unchanged =
        state.speaking.size === identities.length &&
        identities.every((id) => state.speaking.has(id));
      if (unchanged && state.localSpeaking === local) return state;
      return {
        ...(unchanged ? {} : { speaking: new Set(identities) }),
        localSpeaking: local,
      };
    }),

  setAudience: (targets) =>
    set(() => {
      const audience = new Map<string, AudienceEntryPayload>();
      for (const target of targets) audience.set(target.sessionId, target);
      return { audience };
    }),

  addVideo: (video) =>
    set((state) => {
      const videos = new Map(state.videos);
      videos.set(videoKey(video.identity, video.source), video);
      return { videos };
    }),

  removeVideo: (key) =>
    set((state) => {
      if (!state.videos.has(key)) return state;
      const videos = new Map(state.videos);
      videos.delete(key);
      return { videos };
    }),

  reset: () =>
    set({
      status: 'unavailable',
      fault: null,
      faultDetail: null,
      micEnabled: false,
      cameraEnabled: false,
      screenShareEnabled: false,
      // Cleared with the rest: a mute belongs to a session, and the next
      // `JOINED` re-states it (the server re-sends `MODERATION_STATE` for a
      // participant who is still moderated).
      forcedMute: NO_MODERATION,
      selfVideo: null,
      speaking: new Set(),
      localSpeaking: false,
      audience: new Map(),
      videos: new Map(),
    }),
}));
