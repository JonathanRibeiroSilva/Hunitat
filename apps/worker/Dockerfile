# The asset pipeline worker — phase 9, `FR-9.13`.
#
# Its own image and its own container, not a second command on the api's. The
# reasoning is in apps/worker/src/main.ts: optimizing a model is tens of seconds
# of synchronous CPU, the api process runs the 20 Hz world tick, and an
# out-of-memory kill here must not drop every WebSocket connection in the
# deployment.
#
# Build context is the REPOSITORY ROOT, not apps/worker — a workspace build needs
# every workspace manifest present before `npm ci`, or the lockfile does not
# resolve. See docker-compose.yml.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/config/package.json      packages/config/
COPY packages/protocol/package.json    packages/protocol/
COPY packages/world-core/package.json  packages/world-core/
COPY packages/ui/package.json          packages/ui/
COPY apps/api/package.json             apps/api/
COPY apps/web/package.json             apps/web/
COPY apps/worker/package.json          apps/worker/
COPY apps/harness/package.json         apps/harness/

RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npx turbo run build --filter=@hubitat/worker

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=deps  /repo/node_modules           ./node_modules
COPY --from=build /repo/packages/protocol/dist  ./packages/protocol/dist
COPY --from=build /repo/apps/worker/dist        ./apps/worker/dist

COPY packages/protocol/package.json ./packages/protocol/
COPY apps/worker/package.json       ./apps/worker/
COPY package.json                   ./

# No assets, no ports, no health endpoint. This container talks to Postgres and
# to object storage and to nothing else — which is the whole point of it being
# where untrusted uploads are parsed (`NFR-33`).
USER node

WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
