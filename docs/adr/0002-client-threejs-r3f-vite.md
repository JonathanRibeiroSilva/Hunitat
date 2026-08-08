# ADR 0002 — 3D client: Three.js + React Three Fiber on Vite; UI in Tailwind + shadcn/ui

**Status:** accepted · **Affects:** phases 1, 4, 9, 10

## Context

The client has two halves that grow in opposite directions. One is a continuously rendering 3D
scene: geometry, avatars, camera, interpolation. The other is a pile of conventional interface
— a presence list in Phase 1, chat panels in Phase 5, moderation dialogs in Phase 7, a space
directory in Phase 8, and in Phase 9 a full editor with inspectors, gizmo controls and asset
browsers.

Those halves must overlay each other and share state. A nameplate is UI anchored to a 3D
position. The editor is dense UI driving a live scene. Whatever we pick has to make the seam
between them cheap.

The specs never mention server-side rendering, and a WebGL canvas gains nothing from it.

## Decision

**Three.js** for rendering, wrapped in **React Three Fiber** (R3F) with **drei** helpers, built
by **Vite**, as a client-side SPA. Interface styled with **Tailwind CSS** and built from
**shadcn/ui** components. **Zustand** for client state.

R3F renders the scene as a React tree, so the presence list and the avatars it describes read
from the same store without a bridge layer. drei supplies the pieces this project would
otherwise hand-roll: `useGLTF` for loading, `<Html occlude>` for nameplates that respect depth,
and camera helpers.

shadcn/ui is not a dependency — the components are copied into `packages/ui` and owned outright.
For a tool that has to survive Phase 9's editor UI, owning the components beats fighting a
library's theming.

## Consequences

- The Phase 9 editor is a route in the same app, reusing the runtime scene. `FR-9.3`'s
  "accurate preview" mostly falls out of that rather than being built.
- Vite's HMR keeps a 3D scene alive across edits, which is a large practical difference when
  tuning camera and movement feel.
- No SSR means no `'use client'` bookkeeping and no hydration mismatch class of bug.
- **R3F reconciliation must stay out of the frame loop.** Per-frame updates (interpolating
  remote transforms, moving the camera) mutate object refs inside `useFrame`; they must never
  call `setState`. Getting this wrong turns 60fps into 10fps and is the single easiest way to
  ruin this client.
- No server-rendered landing page or indexable invite route. For an internal tool behind a
  login, that costs nothing.
- Tailwind class strings get long in dense editor UI. Accepted.

## Alternatives rejected

- **Next.js** — SSR actively works against 3D libraries here, and the benefits (SEO, public
  landing pages) don't apply to an internal tool.
- **Plain Three.js without React** — best raw control of the render loop, but every menu,
  dialog, chat panel and editor inspector would be hand-built DOM. Phase 9 makes that a bad
  trade.
- **Babylon.js** — a more complete engine with an editor and physics included, but a smaller
  ecosystem for VRM avatars (see [0010](0010-3d-formats-gltf-vrm.md)) and no equivalent of R3F's
  integration with the surrounding UI.
- **MUI** — mature and complete, but heavy, visually at odds with an immersive 3D space, and
  harder to theme than owning the components.
