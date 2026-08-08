/**
 * `FR-10.3`, `FR-10.5`–`FR-10.11` — the content panel.
 *
 * One prompt, one panel, five content types and three shared surfaces. The panel
 * is deliberately *modal over the world* rather than a window in it: `FR-10.3`
 * says closing "returns them to normal play", which is only a meaningful
 * transition if opening took control in the first place.
 *
 * ── Per-participant content never touches the network ───────────────────────
 *
 * The Rules: "per-participant content must not leak into others' views". Link,
 * image and document are rendered from configuration the client already has, and
 * open no socket at all. Only `shared: true` objects reach for a CRDT — so the
 * leak is not prevented by a check, it is prevented by there being no channel.
 *
 * ── The boundary `AC-10.6` asks to be confirmed ─────────────────────────────
 *
 * There is no iframe in this file, no `postMessage`, and no way to render
 * content whose type is not one of five. A link opens in a new tab, with an
 * explicit "leaving" affordance, which is the Rules' requirement that following
 * one is understood as an outbound action.
 */

import { useEffect, useState } from 'react';
import { Panel } from '@hubitat/ui';
import { parseContent, type PlacedObject } from '@hubitat/protocol';
import { useInteractStore } from '../state/interactStore.js';
import { Whiteboard } from './Whiteboard.jsx';
import { StickyNotes } from './StickyNotes.jsx';
import { SharedText } from './SharedText.jsx';
import { SharedVideo } from './SharedVideo.jsx';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export function InteractionPanel() {
  const open = useInteractStore((state) => state.open);
  const session = useInteractStore((state) => state.session);
  const close = useInteractStore((state) => state.closeObject);

  // Escape closes, like every other panel in this product. Registered while one
  // is open rather than always, so it does not swallow the key the editor and
  // the chat composer also use.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const interactive = open.interactive;
  const parsed = interactive ? parseContent(interactive.contentType, interactive.content) : null;

  return (
    <div className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-6">
      <Panel className="flex max-h-[80vh] w-[min(56rem,90vw)] flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">
            {titleOf(open)}
          </h2>
          {interactive?.shared && (
            <span
              className="shrink-0 rounded border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sky-200"
              title={
                interactive.persistShared
                  ? 'Shared, and kept — what you do here is here next time (FR-10.16)'
                  : 'Shared while people are here. Nothing is kept once everybody leaves.'
              }
            >
              shared{interactive.persistShared ? '' : ' · not kept'}
            </span>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10"
          >
            Close · Esc
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!parsed ? (
            <p className="text-sm text-slate-400">
              This object is configured with content this build cannot read. Its author can fix it
              in the editor.
            </p>
          ) : (
            <Content object={open} parsed={parsed} session={session} />
          )}
        </div>
      </Panel>
    </div>
  );
}

function Content({
  object,
  parsed,
  session,
}: {
  object: PlacedObject;
  parsed: NonNullable<ReturnType<typeof parseContent>>;
  session: ReturnType<typeof useInteractStore.getState>['session'];
}) {
  const shared = object.interactive?.shared === true;

  switch (parsed.type) {
    // ── FR-10.5 — a link, and it is clearly outbound ───────────────────────
    case 'link':
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            This takes you out of {location.host} to an external site.
          </p>
          <p className="break-all rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-400">
            {parsed.value.url}
          </p>
          <a
            href={parsed.value.url}
            target="_blank"
            // `noopener` is not optional: `target="_blank"` otherwise hands the
            // destination a handle to this window, and this window is a live 3D
            // session somebody is signed into.
            rel="noopener noreferrer"
            className="inline-block rounded-lg bg-sky-500/20 px-3 py-1.5 text-sm text-sky-100 hover:bg-sky-500/30"
          >
            {parsed.value.label ?? 'Open in a new tab'} ↗
          </a>
        </div>
      );

    // ── FR-10.6 — an image ─────────────────────────────────────────────────
    case 'image':
      return (
        <img
          src={absolute(parsed.value.url)}
          alt={parsed.value.alt ?? ''}
          className="mx-auto max-h-[60vh] rounded-lg object-contain"
        />
      );

    // ── FR-10.7, FR-10.10 — a video, together or alone ─────────────────────
    case 'video':
      return shared && session ? (
        <SharedVideo url={absolute(parsed.value.url)} session={session} />
      ) : (
        <video
          src={absolute(parsed.value.url)}
          controls
          autoPlay={parsed.value.autoplay}
          className="mx-auto max-h-[60vh] w-full rounded-lg bg-black"
        />
      );

    // ── FR-10.8, FR-10.11 — a note, or a surface people share ──────────────
    case 'note': {
      if (!shared) {
        return parsed.value.editable ? (
          <LocalNote initial={parsed.value.text} />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-sm text-slate-200">
            {parsed.value.text}
          </pre>
        );
      }
      if (!session) return <Loading />;

      // Which shared surface this is. Read from the *content* rather than from a
      // sixth content type, because a whiteboard is a note surface — and adding
      // a type to the closed enum is a schema bump three phases share.
      const surface = (object.interactive?.content as { surface?: string } | undefined)?.surface;
      if (surface === 'whiteboard') return <Whiteboard session={session} />;
      if (surface === 'notes') return <StickyNotes session={session} />;
      return <SharedText session={session} placeholder={parsed.value.text} />;
    }

    // ── FR-10.9 — a document ───────────────────────────────────────────────
    case 'document':
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">{parsed.value.title ?? 'Document'}</p>
          {/*
            An <object> rather than an <iframe>, and the difference is the point
            of `AC-10.6`: this renders a *document* the browser knows how to
            display, from this deployment's own storage. It is not a frame that
            hosts somebody else's application, and there is no bridge to one.
          */}
          <object
            data={absolute(parsed.value.url)}
            type="application/pdf"
            className="h-[60vh] w-full rounded-lg bg-slate-900"
          >
            <p className="p-4 text-sm text-slate-400">
              Your browser cannot display this inline.{' '}
              <a
                href={absolute(parsed.value.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-300 underline"
              >
                Open it in a new tab ↗
              </a>
            </p>
          </object>
        </div>
      );
  }
}

/**
 * `FR-10.8`, the un-shared half — editable text nobody else sees.
 *
 * Local to this participant and to this session, deliberately: an object that is
 * not `shared` has no shared state by definition, and quietly persisting one
 * person's edits into everybody's view is exactly the leak the Rules forbid. An
 * author who wants a note people can change together sets `shared`.
 */
function LocalNote({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="h-[50vh] w-full resize-none rounded-lg border border-white/10 bg-slate-950/60 p-3 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      />
      <p className="text-[11px] text-slate-500">
        This note is not shared — what you type here is yours and is not kept. Its author can make
        it a shared surface in the editor.
      </p>
    </div>
  );
}

/** Sharp edge nº4 — a dormant object's state is a database read, and an empty
 *  whiteboard shown while it loads reads as data loss. */
function Loading() {
  return <p className="py-8 text-center text-sm text-slate-500">Loading what is on this…</p>;
}

function titleOf(object: PlacedObject): string {
  const content = object.interactive?.content as { title?: string; label?: string } | undefined;
  return content?.title ?? content?.label ?? object.id;
}

function absolute(url: string): string {
  return url.startsWith('http') ? url : `${API_URL}${url}`;
}
