/**
 * The application state machine — specs/ux/phase-01-screens.md
 *
 *   ENTRY → LOADING → IN_WORLD ⇄ RECONNECTING
 *                └────────────→ ERROR
 *
 * There is no state in which the user sees a 3D scene that is not working. That
 * is the whole point of the Phase 1 rule about failure states.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from './auth/authClient.js';
import { useAuthStore } from './state/authStore.js';
import { bindSelfSessionId, useChatStore } from './state/chatStore.js';
import { useStore } from './state/store.js';
import { net } from './net/client.js';
import { disposeWorld, loadWorld, WorldLoadError, type LoadedWorld } from './world/loadWorld.js';
import { WorldScene } from './world/WorldScene.jsx';
import { EntryScreen } from './ui/EntryScreen.jsx';
import { LoadingScreen } from './ui/LoadingScreen.jsx';
import { ErrorScreen } from './ui/ErrorScreen.jsx';
import { Hud } from './ui/Hud.jsx';
import { EditorScreen } from './editor/EditorScreen.jsx';

/**
 * `FR-5.15` — who "you" are, for mention highlighting.
 *
 * Injected here rather than read from the world store inside the chat store,
 * which would make one store import the other at module load for a single
 * field. Re-read on every message, never captured: the session id changes on
 * every join, and a stale one misses mentions — which is invisible, unlike a
 * spurious highlight.
 */
bindSelfSessionId(() => useStore.getState().joined?.sessionId ?? '');

export function App() {
  const appState = useStore((state) => state.appState);
  const tuning = useStore((state) => state.tuning);
  /**
   * Phase 8 — what the server has told this client to load, and when.
   *
   * Replaces the `joined`-plus-a-ref arrangement phase 1 used. A map transfer
   * (`FR-8.6`) replaces the world on a socket that never dropped, so there is no
   * second `JOINED` to hang a reload off, and the guard against a *resume*
   * re-triggering one has to survive that. The store decides both: `epoch`
   * increments only when the world genuinely has to be rebuilt, and stays put
   * for a resume into the Map already on screen.
   */
  const request = useStore((state) => state.world);

  const [world, setWorld] = useState<LoadedWorld | null>(null);
  /** Phase 9 — which Map is open in the editor, if any. Held here rather than in
   *  a store, because it is a fact about which *screen* is showing and every
   *  other one of those lives in this component. */
  const [editing, setEditing] = useState<{ mapId: string; spaceSlug: string } | null>(null);
  /** The epoch the scene on screen was built from. `-1` is "nothing loaded",
   *  which is what makes the first load happen and what `reset()` returns to. */
  const loadedEpochRef = useRef(-1);

  /**
   * Phase 6 — establish who this is, before the entry screen renders a form.
   *
   * Two independent questions, asked together:
   *
   *   `GET /auth/config` — what this server allows. Which doors the entry screen
   *   shows depends entirely on it, and guessing produces a form that cannot
   *   succeed (`AC-6.5`).
   *
   *   `restore()` — `FR-6.17`, "remains authenticated across refreshes". The
   *   access token died with the previous page; the refresh cookie did not. This
   *   is what turns a reload into a continued session.
   *
   * `status` only leaves `unknown` once both have answered, so nobody watches
   * their own account flicker away and come back.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [config, account] = await Promise.all([
        auth.config().catch(() => null),
        auth.restore().catch(() => null),
      ]);
      if (cancelled) return;

      const store = useAuthStore.getState();
      if (config) store.setConfig(config);
      else {
        // The server is unreachable or too old to answer. Guests are the honest
        // fallback: it is what every build before phase 6 did, and it lets the
        // entry screen render something rather than hanging on "Checking…".
        store.setConfig({
          accountsEnabled: false,
          allowGuests: true,
          passwordMinLength: 12,
          passwordResetEnabled: false,
          spaceSlug: 'default',
          spaceName: 'hubitat',
          // Phase 7. Both false, for the same reason `accountsEnabled` is: this
          // branch runs when the server could not be reached, and a client that
          // guessed "a password is required" would ask for one it cannot check.
          // A join that turns out to need one is answered with
          // `password-required`, which the entry screen can act on.
          spacePasswordRequired: false,
          spaceLocked: false,
        });
      }
      store.setAccount(account);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // NFR-29 — fail with a clear message rather than a broken canvas.
  useEffect(() => {
    if (!supportsWebGL2()) {
      useStore.getState().fail({
        title: "Your browser doesn't support the 3D features this needs.",
        detail: 'WebGL 2 is required. Try a recent version of Chrome, Edge, Firefox or Safari.',
        retryable: false,
      });
    }
  }, []);

  /**
   * `spacePassword` is phase 7, `FR-7.12`.
   *
   * Carried from the entry screen rather than prompted for on refusal, because
   * `GET /auth/config` already says whether one is needed — asking up front is
   * one form instead of a form, a rejection and a second form. A join refused
   * with `password-incorrect` sends them back here with the reason on screen,
   * which is the case where a prompt would have been the second form anyway.
   */
  const enter = useCallback((displayName: string, spacePassword?: string) => {
    const store = useStore.getState();
    store.setDisplayName(displayName);
    store.setAppState('loading');
    loadedEpochRef.current = -1;
    net.connect(displayName, { ...(spacePassword ? { spacePassword } : {}) });
  }, []);

  /**
   * Load the world the server has named — at the handshake, and again whenever a
   * transfer moves this participant to a different Map (`FR-8.6`).
   *
   * The loading screen is shown for a mid-session transfer as well as for the
   * first entry, deliberately: a Map is a GLB download and a collider build, and
   * a canvas that kept drawing the old room while the new one arrived would be
   * showing a world the person is no longer in. The Phase 1 rule — "the canvas is
   * never shown partially built" — applies to the second world as much as to the
   * first.
   */
  useEffect(() => {
    if (!request || !tuning) return;
    if (loadedEpochRef.current === request.epoch) return;
    loadedEpochRef.current = request.epoch;

    let cancelled = false;
    const avatarModelUrl = useStore.getState().joined?.avatarModelUrl;
    if (!avatarModelUrl) return;

    // A transfer arrives while the world is on screen, so the state machine has
    // to be sent back to LOADING or the user watches the old room until the new
    // one is ready. Guarded, because the first load is already there and setting
    // it again would restart the step display.
    if (useStore.getState().appState === 'in-world') useStore.getState().setAppState('loading');

    void (async () => {
      try {
        const loaded = await loadWorld(
          request.mapUrl,
          request.mapDocumentUrl,
          avatarModelUrl,
          request.spawn,
          tuning,
        );
        if (cancelled) {
          // A second transfer landed while this one was still downloading, or
          // the app went away. Nothing will ever hold this world, so nothing
          // else will ever dispose it: the Rapier world is WASM memory no
          // collector can see (NFR-14), and the claim it took on the shared
          // avatar model would keep that alive for the rest of the session.
          disposeWorld(loaded);
          return;
        }
        setWorld(loaded);
        useStore.getState().setAppState('in-world');
      } catch (error) {
        if (cancelled) return;
        const failure =
          error instanceof WorldLoadError
            ? {
                title: error.message,
                detail: error.detail,
                retryable: error.retryable,
                technical: error.detail,
              }
            : {
                title: 'The world failed to load.',
                detail: String(error),
                retryable: true,
              };
        useStore.getState().fail(failure);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request, tuning]);

  /**
   * NFR-14 — free the previous world before another can be loaded.
   *
   * As a cleanup rather than a call inside `retry`/`backToStart`: React runs it
   * after the scene has been torn down, so nothing disposes geometry that is
   * still being drawn, and every path that drops a world — retry, back to start,
   * unmount — is covered by construction rather than by remembering.
   *
   * StrictMode double-invokes effects on the initial mount only, and `world` is
   * null there, so the spurious cleanup disposes nothing. Seeding a world before
   * first paint would break that and free a scene still on screen.
   */
  useEffect(() => {
    if (!world) return;
    return () => disposeWorld(world);
  }, [world]);

  // FR-1.4 — a prompt departure rather than waiting for the stale-session sweep.
  useEffect(() => {
    const onUnload = () => net.leave();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // Chat is reset alongside the world on both paths. A conversation belongs to
  // the session it happened in: `nearby` and `zone` were never stored at all
  // (FR-5.13), and the persistent channels are re-fetched from the server on
  // the next join rather than carried across in a store the user has left.
  const retry = useCallback(() => {
    const store = useStore.getState();
    const name = store.displayName;
    store.reset();
    useChatStore.getState().reset();
    setWorld(null);
    loadedEpochRef.current = -1;
    enter(name);
  }, [enter]);

  const backToStart = useCallback(() => {
    net.disconnect();
    useStore.getState().reset();
    useChatStore.getState().reset();
    setWorld(null);
    loadedEpochRef.current = -1;
  }, []);

  if (appState === 'entry') return <EntryScreen onEnter={enter} />;
  if (appState === 'error') return <ErrorScreen onRetry={retry} onBack={backToStart} />;
  if (appState === 'loading' || !world || !tuning) return <LoadingScreen />;

  /**
   * Phase 9 — the editor, over the world rather than beside it.
   *
   * A mode rather than a route: the socket stays connected, so chat, presence
   * and moderation keep working while somebody authors a room, and closing the
   * editor puts them back exactly where they were standing. `FR-9.3`'s "preview
   * as a participant would" is the same client, which is what makes the preview
   * accurate by construction rather than by maintenance.
   *
   * The world scene is unmounted while it is open. Two R3F canvases each holding
   * a Rapier world is twice the WASM memory for a scene nobody is looking at.
   */
  if (editing) {
    return (
      <EditorScreen
        mapId={editing.mapId}
        spaceSlug={editing.spaceSlug}
        tuning={tuning}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="relative h-full w-full">
      {/*
        The scene stays mounted while reconnecting, dimmed rather than torn
        down. Remote avatars freeze in place — they are stale, not gone, and
        throwing the scene away would make a two-second blip feel like a crash.
      */}
      <div
        className={
          appState === 'reconnecting'
            ? 'absolute inset-0 opacity-40 transition-opacity duration-300'
            : 'absolute inset-0'
        }
      >
        {/*
          Keyed on the world, so a map transfer remounts the scene rather than
          re-rendering it with a different one underneath. Every component below
          holds a reference into Rapier's WASM heap — the character body, the
          controller, the colliders — and handing them a new `PhysicsWorld` while
          the old one is being freed is a crash inside WebAssembly rather than a
          React error anybody could read.
        */}
        <WorldScene key={request?.epoch ?? 0} world={world} tuning={tuning} />
      </div>
      <Hud onEdit={(mapId, spaceSlug) => setEditing({ mapId, spaceSlug })} />
    </div>
  );
}

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}
