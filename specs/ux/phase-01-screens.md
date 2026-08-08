# UX — Phase 1 Screens and States

**Status:** normative · **Applies to:** phase 1

Phase 1 describes what the system does and never what the user sees. It does impose one visual
requirement, in the Rules section:

> If the static world fails to load, the client must show a clear failure state rather than
> dropping the user into an empty void.

That sentence implies a state machine nobody wrote down. This document is that state machine,
plus the two screens and one overlay Phase 1 needs.

Later phases add surfaces; this covers only what is required to satisfy `AC-1.1`–`AC-1.7`.

---

## Application states

```
        ┌───────────┐
        │   ENTRY   │  name input
        └─────┬─────┘
              │ join
        ┌─────▼─────┐        failure       ┌─────────┐
        │  LOADING  ├─────────────────────▶│  ERROR  │
        └─────┬─────┘                      └────┬────┘
              │ ready                           │ retry
        ┌─────▼─────┐                           │
        │  IN_WORLD │◀──────────────────────────┘
        └─────┬─────┘
              │ connection lost
        ┌─────▼──────────┐  restored
        │  RECONNECTING  ├──────────▶ IN_WORLD
        └─────┬──────────┘
              │ token expired / gave up
              └──────────────────────▶ ERROR
```

There is no state in which the user sees a 3D scene that is not working. That is the whole point
of the rule.

---

## ENTRY

The first screen. No 3D, no connection yet.

**Contains:** product name · display-name input · **Enter** button · a note that this is a guest
session.

| Rule                                                               | Requirement                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| Name is optional; blank generates one (e.g. "Guest 4821")          | `FR-1.2`                                                  |
| Names need not be unique — no uniqueness check, no warning         | `FR-1.8`                                                  |
| Maximum 32 characters, trimmed                                     | `MAX_DISPLAY_NAME_CHARS`                                  |
| Leading/trailing whitespace stripped; empty after trim = generated | `FR-1.2`                                                  |
| Name is remembered in `localStorage` and pre-filled next visit     | convenience only — identity is still ephemeral (`FR-1.7`) |

Pre-filling the name is a convenience, not persistence of identity. Nothing about the participant
survives the session, which `FR-1.7` requires.

---

## LOADING

Shown from **Enter** until the world is interactive. It covers real work — this is not a
decorative spinner. `NFR-13` budgets 8 seconds.

**Sub-steps, shown as progress:**

1. Connecting to server (WebSocket open, `JOIN` sent, `JOINED` received)
2. Initialising physics (Rapier WASM)
3. Downloading world (GLB fetch, with percentage when `Content-Length` is available)
4. Building collision (trimesh construction — usually the slowest step)
5. Entering world

**Rules**

- Any step failing goes to **ERROR** with that step named. "Failed to download world" is
  actionable; "Something went wrong" is not.
- A step exceeding 30 seconds is treated as failed.
- The 3D canvas is never shown partially built. `IN_WORLD` means everything is ready.

---

## IN_WORLD

The 3D scene with a HUD overlaid. The HUD is deliberately sparse — later phases fill it.

### Scene

| Element                                                | Requirement                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| The loaded world, with `COL_`-prefixed nodes invisible | `FR-1.18`, [map-document.md](../protocol/map-document.md)                  |
| Local avatar — placeholder capsule with a facing cone  | Phase 1; VRM arrives in Phase 4                                            |
| Remote avatars at interpolated transforms              | `FR-1.13`                                                                  |
| Nameplates above every avatar, fading with distance    | anticipates `FR-4.9`                                                       |
| Third-person orbital camera with wall collision        | [coordinates-and-units.md](../conventions/coordinates-and-units.md#camera) |

Remote avatars appear and disappear cleanly as they cross the area of interest (`FR-1.17`) — a
short fade, not a pop, and with GPU resources disposed on removal (`NFR-14`).

The local participant's own avatar is visually distinct (a subtle outline or tint), because in
third-person with placeholder capsules, telling yourself apart in a crowd is otherwise
guesswork.

### HUD

**Presence list** — top right, collapsible. `FR-1.21`.

- Everyone in the area of interest, plus a total count for the instance.
- Per entry: display name, activity dot (active / idle), and "you" marked.
- Updates within seconds of joins and leaves (`AC-1.7`).
- Ordered: yourself first, then alphabetically. Stable ordering matters — a list that reshuffles
  as people move is unreadable.

**Connection indicator** — top left. Hidden when healthy; shows a state and round-trip time when
degraded. Silence when things work is the correct default.

**Controls hint** — bottom left, dismissible, shown on first visit only.

**Self status** — bottom right: your name and activity. Idle appears automatically after
`IDLE_TIMEOUT_MS` and clears on input (`FR-1.22`).

### Leaving

Closing the tab is the ordinary path. A `LEAVE` frame is sent on `beforeunload` for a prompt
departure (`FR-1.4`); if it does not arrive, the stale-session sweep removes the participant
within `STALE_SESSION_TIMEOUT_MS` (`FR-1.6`, `AC-1.4`).

---

## RECONNECTING

The connection dropped and recovery is in progress (`FR-1.5`).

- **The 3D scene stays on screen**, dimmed, with a banner. Remote avatars freeze in place rather
  than vanishing — they are stale, not gone, and throwing away the scene would make a two-second
  network blip feel like a crash.
- The banner states what is happening and counts down to the next attempt.
- Local movement input is ignored while disconnected; there is nowhere to send it.
- On success: banner clears, a fresh `SNAPSHOT` replaces remote state wholesale (stale avatars
  are removed rather than reconciled), and the scene un-dims.
- On failure past `RESUME_TOKEN_TTL_MS`: **ERROR**, offering a fresh join.

---

## ERROR

The state the Phase 1 rule demands. Never a blank scene, never a silent failure.

**Contains:** what failed, in plain language · a **Retry** button · a **Back to start** link ·
a collapsed technical detail block for whoever has to debug it.

| Cause                 | Message                                                    | Retry                  |
| --------------------- | ---------------------------------------------------------- | ---------------------- |
| Server unreachable    | "Can't reach the server."                                  | reconnect              |
| World download failed | "Couldn't download the world."                             | refetch                |
| World file invalid    | "The world file is damaged or in an unsupported format."   | no — retry cannot help |
| Physics init failed   | "Your browser couldn't start the physics engine."          | no — see `NFR-28`      |
| WebGL 2 unavailable   | "Your browser doesn't support the 3D features this needs." | no (`NFR-29`)          |
| World full            | "This world is at capacity."                               | retry                  |
| Reconnection expired  | "You were disconnected for too long."                      | fresh join             |

Retry is offered only where retrying can plausibly work. A retry button on a corrupt world file
teaches users that buttons lie.

---

## Accessibility floor

Not a full accessibility programme — the minimum that avoids designing problems in.

- ENTRY and ERROR are fully keyboard-navigable with visible focus.
- All movement and camera control is available from the keyboard; no action requires a mouse
  drag.
- Colour is never the only signal: activity status carries an icon as well as a dot.
- Text contrast meets WCAG AA, including HUD text over the 3D canvas — which needs a scrim,
  since contrast against a moving scene cannot be guaranteed otherwise.
- Respect `prefers-reduced-motion`: skip camera easing and avatar fade transitions.

---

## Out of scope for Phase 1

Chat (Phase 5), media controls (Phase 2), avatar customization (Phase 4), settings, the
participant context menu (Phase 7), and the map directory (Phase 8). The HUD is laid out to
leave room for them, but they are not stubbed.

---

## Related

- [coordinates-and-units.md](../conventions/coordinates-and-units.md#camera) — camera and input
- [tuning-defaults.md](../conventions/tuning-defaults.md) — timeouts named here
- [nfr.md](../nfr.md) — load-time and frame-rate budgets
- [wire-protocol.md](../protocol/wire-protocol.md) — the connection lifecycle these states mirror
