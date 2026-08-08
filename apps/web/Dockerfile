# Build context is the REPOSITORY ROOT, not apps/web. See docker-compose.yml.

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
COPY apps/harness/package.json         apps/harness/

RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .

# Vite inlines VITE_* at build time, so the API and WebSocket URLs are baked
# into the bundle here rather than read at runtime. Changing them means
# rebuilding this image — the trade for a static, server-less frontend.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_WS_URL=ws://localhost:3000/ws
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

RUN npx turbo run build --filter=@hubitat/web

# ── runtime ──────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
