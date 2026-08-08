/**
 * `FR-10.11`, `FR-10.12`, `FR-10.13` — the collaborative whiteboard.
 *
 * ── Why strokes are a `Y.Array` and not a bitmap ────────────────────────────
 *
 * A bitmap merged by last-write-wins loses whichever stroke arrived second, and
 * two people drawing at once is the case this exists for. A `Y.Array` of strokes
 * converges by construction: two clients appending concurrently end with both
 * strokes in a stable order, whatever order the updates arrived in. `FR-10.12`
 * is a property of the structure, not something checked here.
 *
 * ── Why points are 0..1 ─────────────────────────────────────────────────────
 *
 * Board space, not pixels. Two people on different screen sizes are drawing on
 * the same board, and storing pixels would mean the drawing is a different
 * drawing on every window.
 *
 * ── Why a stroke is written once, on release ────────────────────────────────
 *
 * A CRDT update per mouse-move would be forty updates a second per person, each
 * relayed to everybody and each marking the document dirty. The stroke is
 * accumulated locally, drawn locally so it is never laggy for its author, and
 * committed when the pen lifts — which is also the granularity somebody means by
 * "that stroke".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { YJS_KEYS } from '@hubitat/protocol';
import type { CollabSession } from './collabClient.js';
import { useCollab } from './useCollab.js';

interface Stroke {
  color: string;
  width: number;
  /** Flat `[x, y, x, y…]` in 0..1 board space. Flat rather than `{x,y}[]`
   *  because it is the shape that survives a CRDT cheaply and the shape a canvas
   *  wants. */
  points: number[];
}

const COLORS = ['#e2e8f0', '#38bdf8', '#f472b6', '#facc15', '#4ade80'];

export function Whiteboard({ session }: { session: CollabSession }) {
  const { status } = useCollab(session);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);

  const strokes = session.doc.getArray<Stroke>(YJS_KEYS.strokes);

  const redraw = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;

    context.clearRect(0, 0, element.width, element.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const paint = (stroke: Stroke): void => {
      if (stroke.points.length < 4) return;
      context.strokeStyle = stroke.color;
      context.lineWidth = stroke.width;
      context.beginPath();
      context.moveTo(stroke.points[0]! * element.width, stroke.points[1]! * element.height);
      for (let index = 2; index < stroke.points.length; index += 2) {
        context.lineTo(
          stroke.points[index]! * element.width,
          stroke.points[index + 1]! * element.height,
        );
      }
      context.stroke();
    };

    for (const stroke of strokes.toArray()) paint(stroke);
    // The stroke in progress, drawn on top. Its author sees their own line
    // without waiting for a round trip — the difference between a pen and a
    // network request.
    if (drawing.current) paint(drawing.current);
  }, [strokes]);

  // Re-paint on every remote change. `useCollab` has already re-rendered us; the
  // canvas is imperative, so it needs telling separately.
  useEffect(() => {
    redraw();
  });

  // Match the backing store to the element, so lines are not blurry on a
  // high-density display and coordinates map 1:1.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    const resize = (): void => {
      const rect = element.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(rect.width * ratio);
      element.height = Math.round(rect.height * ratio);
      redraw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [redraw]);

  const pointFrom = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  };

  if (status !== 'ready') {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {status === 'refused'
          ? (session.refusal ?? 'You cannot open this board from here.')
          : 'Loading what is on this board…'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Draw in ${swatch}`}
            onClick={() => setColor(swatch)}
            style={{ backgroundColor: swatch }}
            className={`h-6 w-6 rounded-full ${color === swatch ? 'ring-2 ring-white' : ''}`}
          />
        ))}
        <input
          type="range"
          min={1}
          max={12}
          value={width}
          aria-label="Pen width"
          onChange={(event) => setWidth(Number(event.target.value))}
          className="ml-2 w-24"
        />
        <button
          type="button"
          onClick={() => {
            // Deleting the whole array is one CRDT operation and converges like
            // any other: somebody drawing at the same instant keeps their stroke,
            // which is correct — they drew it after the clear as far as the
            // document is concerned.
            session.mutate(() => strokes.delete(0, strokes.length));
          }}
          className="ml-auto rounded px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400 hover:bg-white/10"
        >
          clear
        </button>
      </div>

      <canvas
        ref={canvas}
        className="h-[55vh] w-full cursor-crosshair rounded-lg bg-slate-900 touch-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const [x, y] = pointFrom(event);
          drawing.current = { color, width, points: [x, y] };
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const [x, y] = pointFrom(event);
          drawing.current.points.push(x, y);
          redraw();
        }}
        onPointerUp={() => {
          const stroke = drawing.current;
          drawing.current = null;
          if (!stroke || stroke.points.length < 4) return;
          // One update per stroke — see the header.
          session.mutate(() => strokes.push([stroke]));
          redraw();
        }}
        onPointerLeave={() => {
          // Leaving the canvas mid-stroke commits what was drawn rather than
          // discarding it: a line that vanishes because the pointer clipped an
          // edge is the kind of loss people stop trusting a tool over.
          const stroke = drawing.current;
          drawing.current = null;
          if (stroke && stroke.points.length >= 4) {
            session.mutate(() => strokes.push([stroke]));
          }
          redraw();
        }}
      />

      <p className="text-[11px] text-slate-500">
        Everybody here draws on the same board. Strokes appear as they are finished.
      </p>
    </div>
  );
}
