# ADR 0001 — TypeScript monorepo with Turborepo and npm workspaces

**Status:** accepted · **Affects:** all phases

## Context

Three runtimes have to agree on the same facts. The browser client resolves collision and
reports a transform. The server filters that transform by area of interest and fans it out.
The headless test bots speak the same wire format to prove both. If any two of them disagree
about the byte layout of a movement frame, or about the radius at which someone enters an area
of interest, the bug is silent and only shows up as "sometimes people flicker".

The specs make this worse than usual on purpose. `FR-1.16` (area of interest) and `FR-2.6`
(proximity sets) describe geometry that must produce the _same_ answer on both sides, and the
Phase 5 rules require chat recipients to match media recipients exactly. Shared logic isn't a
convenience here — it's how those requirements are met.

## Decision

One repository, TypeScript end to end, with **Turborepo** for task orchestration and **npm
workspaces** for dependency resolution. Root at the project directory, with `specs/` and
`docs/` living beside `apps/` and `packages/`.

```
apps/       web · api · worker (phase 9) · harness
packages/   protocol · world-core · ui · config
```

Two packages carry the weight:

- **`protocol`** — opcodes, binary encoders/decoders, Zod schemas, the Map Document schema, and
  the tuning constants. The single definition of what goes on the wire.
- **`world-core`** — pure functions: the spatial grid, area-of-interest queries with hysteresis,
  and `resolveAudience()`. No I/O, no framework, importable from anywhere.

npm workspaces over pnpm: npm ships with Node, and this is an internal tool where "clone and
`npm install`" beating "install pnpm first" matters more than disk savings.

## Consequences

- Client, server and bots import the same encoder. A byte-layout change breaks all three
  compilations at once instead of producing runtime drift.
- The Phase 9 editor reuses the same scene code and `world-core` as the runtime client, which
  is most of what `FR-9.3` ("an accurate preview") asks for.
- Turborepo's cache makes `build`, `lint` and `typecheck` cheap enough to run on every change.
- `world-core` must stay free of Node and DOM APIs. That constraint is load-bearing — it is
  what lets the same code run in a browser, in NestJS, and in a bot.
- npm workspaces hoists more aggressively than pnpm and won't catch undeclared dependencies.
  Accepted; the strictness isn't worth the setup friction here.

## Alternatives rejected

- **Separate repositories per app** — the wire format would need publishing and versioning
  between them, and every protocol change would become a two-repo dance.
- **Nx** — more capable, considerably more configuration. Turborepo does what this project
  needs, which is caching and task graphs.
- **pnpm workspaces** — better disk usage and stricter dependency isolation, but adds a
  prerequisite install step for an internal tool.
