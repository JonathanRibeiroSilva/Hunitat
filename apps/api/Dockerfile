# Build context is the REPOSITORY ROOT, not apps/api — a workspace build needs
# every workspace manifest present before `npm ci`, or the lockfile does not
# resolve. See docker-compose.yml.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /repo

# Manifests only, so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/config/package.json      packages/config/
COPY packages/protocol/package.json    packages/protocol/
COPY packages/world-core/package.json  packages/world-core/
COPY packages/ui/package.json          packages/ui/
COPY apps/api/package.json             apps/api/
COPY apps/web/package.json             apps/web/
COPY apps/harness/package.json         apps/harness/

RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN npx turbo run build --filter=@hubitat/api

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# The api resolves assets relative to its working directory; pin it explicitly
# so the layout of the image cannot silently change the answer.
ENV ASSETS_DIR=/repo/assets

COPY --from=deps  /repo/node_modules            ./node_modules
COPY --from=build /repo/packages/protocol/dist   ./packages/protocol/dist
COPY --from=build /repo/packages/world-core/dist ./packages/world-core/dist
COPY --from=build /repo/apps/api/dist            ./apps/api/dist

COPY packages/protocol/package.json   ./packages/protocol/
COPY packages/world-core/package.json ./packages/world-core/
COPY apps/api/package.json            ./apps/api/
COPY package.json                     ./

# The GLB and its Map Document. The api both reads the document (for spawns) and
# serves the directory statically.
COPY assets ./assets

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/apps/api
CMD ["node", "dist/main.js"]
