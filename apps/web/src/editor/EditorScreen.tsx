/**
 * The editor — `FR-9.1`–`FR-9.22`, as a screen.
 *
 *     ┌──────────────────────────────────────────────────────────────┐
 *     │ map · tools · undo/redo · play · save · publish        close  │
 *     ├────────────┬────────────────────────────────────┬────────────┤
 *     │ library    │                                    │ inspector  │
 *     │ (FR-9.11)  │            the scene               │ (FR-9.5–9) │
 *     │ outliner   │            (FR-9.1, 9.3)           │ environment│
 *     │ (FR-9.2)   │                                    │ (FR-9.16)  │
 *     ├────────────┴────────────────────────────────────┴────────────┤
 *     │ versions · draft state · document size            (FR-9.17–19)│
 *     └──────────────────────────────────────────────────────────────┘
 *
 * ── It takes the lock and holds it ──────────────────────────────────────────
 *
 * `FR-9.22` — the lock is taken on open, beaten on while it is open, and
 * released on close. Losing it is not fatal: the revision check refuses a
 * conflicting save regardless, so a lock that expired while somebody read their
 * email costs them a reload rather than their work.
 *
 * ── It stops the author's avatar walking around ─────────────────────────────
 *
 * The socket stays connected — chat and presence keep working, and an admin
 * being asked a question mid-edit is a normal thing. But the transform send loop
 * is paused: play-mode drives the same character controller participants use, so
 * without this an author testing a draft would be steering their real avatar
 * around the live map at the same time.
 */

import { useCallback, useEffect, useState } from 'react';
import { Panel, cn } from '@hubitat/ui';
import { EDITOR_LOCK_HEARTBEAT_MS, type ClientTuning, type ZoneType } from '@hubitat/protocol';
import { auth } from '../auth/authClient.js';
import { net } from '../net/client.js';
import { EditorScene } from './EditorScene.jsx';
import { EnvironmentPanel, Inspector, LibraryPanel, Outliner, VersionBar } from './panels.jsx';
import {
  addSpawn,
  addZone,
  documentBytes,
  isDirty,
  isLarge,
  useEditorStore,
  type EditorMode,
} from './editorStore.js';

/** `FR-9.22` — a third of the lock's life, so two missed beats are survivable.
 *  From the shared constant, so the two cannot drift into a lock that expires
 *  between beats. */
const HEARTBEAT_MS = EDITOR_LOCK_HEARTBEAT_MS;

export function EditorScreen({
  mapId,
  spaceSlug,
  tuning,
  onClose,
}: {
  mapId: string;
  spaceSlug: string;
  tuning: ClientTuning;
  onClose: () => void;
}) {
  const store = useEditorStore();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  // ── Open, lock, and hold the lock ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // `lock` returns the same state document `state` does, so opening is one
        // round trip rather than two — and taking the lock *first* means an
        // author who cannot have it finds out before they start editing.
        const state = await auth.lockMap(spaceSlug, mapId);
        if (cancelled) return;
        useEditorStore.getState().open(state, spaceSlug);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof Error ? error.message : String(error));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mapId, spaceSlug]);

  useEffect(() => {
    if (loading || failure) return;
    const timer = window.setInterval(() => {
      void auth
        .lockMap(spaceSlug, mapId)
        .then((state) => useEditorStore.getState().adopt(state))
        .catch(() => {
          // Somebody else has it now, or the network hiccupped. Not fatal — the
          // revision check is the guarantee — so this only stops the courtesy
          // from being claimed twice.
          useEditorStore.getState().notify('The editor lock could not be renewed.');
        });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [loading, failure, mapId, spaceSlug]);

  // The avatar stands still while the editor is open. See the header.
  useEffect(() => {
    net.pauseSending();
    return () => net.resumeSending();
  }, []);

  const close = useCallback(() => {
    void auth.unlockMap(spaceSlug, mapId).catch(() => undefined);
    useEditorStore.getState().close();
    onClose();
  }, [mapId, spaceSlug, onClose]);

  // ── FR-9.2 — undo/redo on the keys everybody already knows ────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Not while typing into the inspector: ⌘Z in a text field is the field's.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) useEditorStore.getState().redo();
        else useEditorStore.getState().undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void useEditorStore.getState().save();
        return;
      }
      if (useEditorStore.getState().mode === 'play') return;
      // The gizmo modes, on the keys every 3D tool in the world uses.
      if (event.key === 'g') useEditorStore.getState().setMode('translate');
      if (event.key === 'r') useEditorStore.getState().setMode('rotate');
      if (event.key === 's') useEditorStore.getState().setMode('scale');
      if (event.key === 'Escape') useEditorStore.getState().select(null);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading) {
    return (
      <Shell>
        <p className="text-sm text-slate-400">Opening the editor…</p>
      </Shell>
    );
  }

  if (failure || !store.document) {
    return (
      <Shell>
        <div className="max-w-md space-y-3 text-center">
          <p className="text-sm text-rose-300">{failure ?? 'This map could not be opened.'}</p>
          <button
            onClick={close}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5"
          >
            Back to the world
          </button>
        </div>
      </Shell>
    );
  }

  const dirty = isDirty(store);

  return (
    <div className="absolute inset-0 flex flex-col bg-slate-950">
      <Toolbar dirty={dirty} onClose={close} />

      <div className="relative flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r border-white/10 p-2">
          <LibraryPanel spaceSlug={spaceSlug} />
          <Outliner />
        </aside>

        <div className="relative min-w-0 flex-1">
          <EditorScene tuning={tuning} />
          {store.mode === 'play' && <PlayBanner />}
        </div>

        <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-l border-white/10 p-2">
          <Inspector />
          <EnvironmentPanel />
        </aside>
      </div>

      <VersionBar dirty={dirty} />
      <Toasts />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-slate-950">{children}</div>
  );
}

/**
 * Everything that acts on the map as a whole.
 *
 * The tools are radio buttons rather than toggles, because the modes are
 * mutually exclusive by construction: the gizmo has one mode and play-mode
 * replaces the camera entirely.
 */
function Toolbar({ dirty, onClose }: { dirty: boolean; onClose: () => void }) {
  const store = useEditorStore();
  const document = store.document!;

  const place = useCallback((type: ZoneType) => {
    // In front of the origin rather than at it: a zone created inside the floor
    // is invisible, and the author's first act would be to hunt for it.
    useEditorStore.getState().apply((current) => addZone(current, type, { x: 0, y: 1.5, z: 0 }));
  }, []);

  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 text-sm">
      <span className="font-medium text-slate-100">{store.mapName}</span>
      <span className="text-xs text-slate-500">
        v{store.publishedVersion}
        {dirty && <span className="ml-1 text-amber-400">· unsaved</span>}
      </span>

      <span className="mx-1 h-5 w-px bg-white/10" />

      {(['select', 'translate', 'rotate', 'scale'] as EditorMode[]).map((mode) => (
        <ToolButton
          key={mode}
          active={store.mode === mode}
          onClick={() => store.setMode(mode)}
          title={
            mode === 'select'
              ? 'Select (Esc clears)'
              : mode === 'translate'
                ? 'Move (G)'
                : mode === 'rotate'
                  ? 'Rotate (R)'
                  : 'Scale (S)'
          }
        >
          {mode === 'select'
            ? 'Select'
            : mode === 'translate'
              ? 'Move'
              : mode === 'rotate'
                ? 'Rotate'
                : 'Scale'}
        </ToolButton>
      ))}

      <span className="mx-1 h-5 w-px bg-white/10" />

      <ToolButton onClick={store.undo} disabled={store.past.length === 0} title="Undo (⌘Z)">
        Undo
      </ToolButton>
      <ToolButton onClick={store.redo} disabled={store.future.length === 0} title="Redo (⇧⌘Z)">
        Redo
      </ToolButton>

      <span className="mx-1 h-5 w-px bg-white/10" />

      {/* `FR-9.5`–`FR-9.9` — every authored zone type, one click each. */}
      <select
        value=""
        onChange={(event) => {
          if (event.target.value) place(event.target.value as ZoneType);
          event.target.value = '';
        }}
        className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-300"
        title="Add a zone (FR-9.5 – FR-9.9)"
      >
        <option value="">+ Zone…</option>
        <option value="collision">Collision</option>
        <option value="spawn">Spawn rule</option>
        <option value="private">Private</option>
        <option value="spotlight">Spotlight</option>
        <option value="portal">Portal</option>
        <option value="trigger">Trigger</option>
      </select>

      <ToolButton
        onClick={() => store.apply((current) => addSpawn(current, { x: 0, y: 0, z: 0 }))}
        title="Add a spawn point (FR-9.6)"
      >
        + Spawn
      </ToolButton>

      <span className="mx-1 h-5 w-px bg-white/10" />

      {/* `FR-9.3` — walk the draft as a participant would. */}
      <ToolButton
        active={store.mode === 'play'}
        onClick={() => store.setMode(store.mode === 'play' ? 'select' : 'play')}
        title="Walk the draft as a participant would (FR-9.3)"
      >
        {store.mode === 'play' ? 'Stop' : 'Play'}
      </ToolButton>

      <div className="ml-auto flex items-center gap-2">
        {store.lock && !store.lock.mine && (
          <span
            className="rounded border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200"
            title={`${store.lock.name} has this map open. Your saves will be refused rather than overwrite theirs (FR-9.22).`}
          >
            {store.lock.name} is editing
          </span>
        )}
        <ToolButton
          onClick={() => void store.save()}
          disabled={!dirty || store.saving}
          title="Save the draft (⌘S)"
        >
          {store.saving ? 'Saving…' : 'Save draft'}
        </ToolButton>
        <button
          type="button"
          onClick={() => void store.publish()}
          disabled={store.saving}
          title="Make this the version participants enter (FR-9.18)"
          className="rounded-lg bg-sky-500/20 px-3 py-1 text-xs text-sky-100 hover:bg-sky-500/30
                     disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-sky-300"
        >
          Publish
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/10"
        >
          Close
        </button>
      </div>
    </header>
  );
}

function ToolButton({
  children,
  onClick,
  active,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded-lg px-2 py-1 text-xs transition-colors disabled:opacity-40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        active ? 'bg-sky-500/20 text-sky-100' : 'text-slate-400 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

/** `FR-9.3` — say plainly that this is the draft being walked, not the live map.
 *  An author who forgot which they were in would publish by accident or fail to. */
function PlayBanner() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2">
      <Panel className="border-emerald-400/30 bg-emerald-950/70 px-4 py-2">
        <span className="text-xs text-emerald-100">
          Walking the draft — W A S D, Shift to run, Space to jump. Nobody else can see you here.
        </span>
      </Panel>
    </div>
  );
}

/** Errors and confirmations, in one place. An editor that swallowed a refused
 *  save would be an editor that lost work silently. */
function Toasts() {
  const error = useEditorStore((store) => store.error);
  const notice = useEditorStore((store) => store.notice);
  const setError = useEditorStore((store) => store.setError);
  const notify = useEditorStore((store) => store.notify);
  const bytes = useEditorStore(documentBytes);
  const large = useEditorStore(isLarge);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => notify(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice, notify]);

  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
      {/* Sharp edge nº4: a document that is getting large should say so before
          it is a problem nobody saw coming. */}
      {large && (
        <Panel className="border-amber-400/30 bg-amber-950/70 px-4 py-2">
          <span className="text-xs text-amber-100">
            This map document is {(bytes / 1024).toFixed(0)} KB. It is read on every arrival and
            sent to every client — reuse assets rather than duplicating geometry.
          </span>
        </Panel>
      )}
      {notice && (
        <Panel className="border-sky-400/30 bg-sky-950/70 px-4 py-2">
          <span className="text-xs text-sky-100">{notice}</span>
        </Panel>
      )}
      {error && (
        <Panel className="pointer-events-auto border-rose-400/30 bg-rose-950/80 px-4 py-2">
          <span className="text-xs text-rose-100">{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-3 rounded px-1 text-rose-300 hover:text-rose-100"
          >
            ×
          </button>
        </Panel>
      )}
    </div>
  );
}
