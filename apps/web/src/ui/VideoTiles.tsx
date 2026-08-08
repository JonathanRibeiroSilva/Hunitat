/**
 * Remote video and the self-view — FR-2.4, FR-2.12, FR-2.13, FR-2.20.
 *
 * The tile strip is a direct rendering of the audience's `visible` set: a face
 * appears when you walk into visible range and is gone when you walk out, with
 * no call and no accept step anywhere in the flow (FR-2.14, AC-2.3). Membership
 * is the server's decision; this only draws it.
 *
 * A screen share gets a wide tile of its own rather than a slot in the strip.
 * `FR-2.20` only asks for one obvious presenter stream, and a shared screen
 * shown at head-and-shoulders size is unreadable, which makes it pointless.
 *
 * The two are separate exports because they live in different docks: faces go
 * in the left rail, a share goes in the top-centre stack under the connection
 * banner. Rendering both from one component forced the share to pin itself to
 * the top centre, which is the same spot the reconnect banner and the transient
 * notice claim — three panels, one anchor, drawn on top of each other. Neither
 * positions itself now; `Hud` places them.
 */

import { useEffect, useRef } from 'react';
import type { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
import { Panel, cn } from '@hubitat/ui';
import { useMediaStore, type RemoteVideo } from '../state/mediaStore.js';

/**
 * `FR-2.20` — the presenter's screen, in the top-centre stack.
 *
 * Capped and scrollable rather than free to grow: two people sharing at once is
 * two 16:9 panels, which is taller than the viewport, and the overflow would
 * otherwise run down over the world and the bottom dock.
 */
export function ScreenShareTiles() {
  const videos = useMediaStore((state) => state.videos);
  const screens = [...videos.values()].filter((video) => video.source === 'screen');

  if (screens.length === 0) return null;

  return (
    <div className="pointer-events-auto flex max-h-[60vh] w-full flex-col gap-2 overflow-y-auto">
      {screens.map((video) => (
        <Panel key={video.identity} className="shrink-0 overflow-hidden">
          <RemoteTrackVideo
            track={video.track}
            className="aspect-video w-full bg-black object-contain"
          />
          <div className="px-3 py-1.5 text-xs text-slate-300">
            {video.displayName} is sharing a screen
          </div>
        </Panel>
      ))}
    </div>
  );
}

/**
 * The face strip — self-view first, then everyone visible.
 *
 * `MAX_CONCURRENT_VIDEO` allows up to twelve remote cameras
 * ([tuning-defaults.md](../../../../specs/conventions/tuning-defaults.md)), which
 * is around 1900px of tiles: taller than any viewport this targets. The strip
 * scrolls inside whatever height the left rail gives it, so a crowded room
 * pushes the earlier tiles out of sight rather than running off the bottom of
 * the screen and under the chat panel.
 */
export function VideoTiles() {
  const videos = useMediaStore((state) => state.videos);
  const selfVideo = useMediaStore((state) => state.selfVideo);
  const speaking = useMediaStore((state) => state.speaking);

  const faces = [...videos.values()].filter((video) => video.source === 'camera');

  if (!selfVideo && faces.length === 0) return null;

  return (
    <div className="pointer-events-auto flex w-40 flex-col gap-2">
      {/* FR-2.4 — the local track, never routed through the SFU. Mirrored,
          because an unmirrored self-view reads as somebody else. */}
      {selfVideo && (
        <Tile label="You" self>
          <LocalTrackVideo track={selfVideo} className="h-full w-full -scale-x-100 object-cover" />
        </Tile>
      )}

      {faces.map((video) => (
        <Tile
          key={video.identity}
          label={video.displayName}
          speaking={speaking.has(video.identity)}
        >
          <RemoteTrackVideo track={video.track} className="h-full w-full object-cover" />
        </Tile>
      ))}
    </div>
  );
}

/**
 * FR-2.21's signal, made visible.
 *
 * A ring rather than a colour change alone, and the label carries "speaking" in
 * text so the state survives being unable to distinguish the ring.
 */
function Tile({
  label,
  speaking = false,
  self = false,
  children,
}: {
  label: string;
  speaking?: boolean;
  self?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Panel
      className={cn(
        // `shrink-0` so a full strip scrolls rather than squashing every face
        // into a letterbox.
        'shrink-0 overflow-hidden p-0 transition-shadow duration-150',
        speaking && 'ring-2 ring-emerald-400',
      )}
    >
      <div className="aspect-[4/3] w-full bg-slate-800">{children}</div>
      <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-300">
        <span className="truncate">{label}</span>
        {speaking && <span className="ml-auto shrink-0 text-emerald-300">speaking</span>}
        {self && <span className="ml-auto shrink-0 text-slate-500">you</span>}
      </div>
    </Panel>
  );
}

/**
 * Attach a LiveKit track to a `<video>` element.
 *
 * `attach`/`detach` rather than assigning `srcObject`: LiveKit tracks how many
 * elements a track is attached to and stops paying for layers nobody is
 * rendering. Assigning the stream directly leaves it publishing at full quality
 * into a detached node.
 */
function RemoteTrackVideo({ track, className }: { track: RemoteVideoTrack; className?: string }) {
  return <TrackVideo track={track} className={className} />;
}

function LocalTrackVideo({ track, className }: { track: LocalVideoTrack; className?: string }) {
  return <TrackVideo track={track} className={className} />;
}

function TrackVideo({
  track,
  className,
}: {
  track: RemoteVideoTrack | LocalVideoTrack;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    // Detaching on unmount is not optional: a track left attached to a removed
    // element keeps its layers subscribed, which is bandwidth spent on pixels
    // nobody can see (NFR-20).
    return () => {
      track.detach(element);
    };
  }, [track]);

  return <video ref={ref} autoPlay playsInline muted className={className} />;
}

export type { RemoteVideo };
