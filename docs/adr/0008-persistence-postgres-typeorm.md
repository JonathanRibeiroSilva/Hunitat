# ADR 0008 — Persistence: PostgreSQL + TypeORM, `jsonb` for the Map Document, versioned migrations

**Status:** accepted · **Affects:** phases 5–10

## Context

Durable storage arrives gradually. Phase 1 persists nothing at all — `FR-1.7` _requires_ guest
identity to be ephemeral. Phase 5 introduces message history, Phase 6 accounts and memberships,
Phase 7 roles and an append-only audit log, Phase 8 spaces and maps, Phase 9 versioned map
documents and asset metadata, Phase 10 collaborative object state.

The shapes are mostly ordinary relational data — accounts, memberships, invites, bans, roles.
One is not. `DC-9.1 Map Document` is _"the serializable definition: scene graph (placed objects
with transforms), zones, spawns, portals, lighting/environment, and asset references"_. That is
a nested tree with a schema that grows every phase, and it is written and read as a whole.

Phase 7 adds a requirement most storage layers ignore: `FR-7.20` wants the audit log
_"tamper-evident enough to be trusted (append-only in intent)"_.

## Decision

**PostgreSQL 16** with **TypeORM** (`@nestjs/typeorm`, a first-party NestJS integration —
entities are decorated classes, which matches the framework's idiom).

Structural rules:

- **Relational tables for relational data.** Accounts, profiles, spaces, memberships, invites,
  roles, bans, blocks, reports, messages, read state, asset metadata, map metadata.
- **`jsonb` for the Map Document.** `map_versions.document jsonb`, validated by the Zod schema
  in `packages/protocol` on the way in. Modelling a scene graph as tables would buy query
  ability nobody needs and cost a migration every time the editor gains a field.
- **`bytea` for Yjs snapshots** — see [0012](0012-collaborative-state-yjs.md).
- **Versioned migrations, never `synchronize`.** `synchronize: true` is convenient in
  development and destroys data in production; it is disabled in every environment, including
  development, so the migration path is exercised from day one.
- **Append-only enforced by the database, not by discipline.** The application role receives
  `INSERT` and `SELECT` on `audit_log` and no `UPDATE` or `DELETE`. `FR-7.20` becomes a grant
  rather than a convention.
- **Map versioning is copy-forward.** Publishing writes a new `map_versions` row and moves
  `maps.published_version_id`. Reverting copies an old document into a _new_ version. Nothing
  is ever overwritten, which is what lets `FR-9.19` return to the newer version after a revert.

## Consequences

- One database engine for relational data, documents, binary snapshots and the job queue
  ([0009](0009-no-redis-in-memory-pgboss.md)). One thing to back up, one connection to
  configure.
- `jsonb` gives up referential integrity inside the document. An asset referenced by a map is
  a UUID in JSON, not a foreign key — so `FR-9.14`'s "safeguards if in use" must be an explicit
  application query over `map_versions`, not a database constraint. This is a real cost and the
  main argument against `jsonb`.
- TypeORM's migration generator drifts from hand-written entities on complex changes. Generated
  migrations get reviewed, not trusted.
- Postgres is declared in Compose from the start but sits idle through Phase 1. The `api` opens
  the connection and runs an empty initial migration so the path is proven early rather than
  discovered late.
- `jsonb` documents should stay well under a megabyte. A very large authored map would need
  splitting; the editor should surface size before that becomes a problem.

## Alternatives rejected

- **Prisma** — excellent DX and type safety, and the more popular choice. Rejected in favour of
  TypeORM's first-party NestJS integration and decorator-based entities, which keep persistence
  in the same idiom as the rest of the server.
- **Map document as normalised tables** — real foreign keys and queryable scene contents, at
  the cost of a migration per editor feature and an expensive assembly on every load. The
  document is always read whole; the normalisation would serve nothing.
- **Map documents as files in MinIO** — natural for versioned blobs, but loses transactional
  consistency with the `maps` row that points at them, and makes "which maps reference this
  asset?" impossible to answer without scanning object storage.
- **MongoDB** — a better native fit for the document half, and a worse fit for everything else,
  which is the majority.
- **SQLite** — genuinely tempting for a single-process internal tool. Rejected because Phase 9's
  job queue and Phase 10's concurrent writers want real concurrency, and because the deployment
  is already containerised.
