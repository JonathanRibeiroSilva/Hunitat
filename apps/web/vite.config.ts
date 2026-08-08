import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Tunnel mode, for testing voice with someone who is not at this machine.
 *
 *   WEB_PUBLIC_HOST=<domain> npm run dev --workspace @hubitat/web
 *
 * Unset — the normal case — nothing below changes: the dev server stays on
 * localhost and talks to the api cross-origin, which is what `enableCors` in
 * apps/api/src/main.ts is there for.
 *
 * Set, everything the browser needs is served from ONE origin: the tunnel
 * publishes a single https URL, and `/ws` and `/assets` are proxied to the api
 * from here. Two tunnels would mean two origins, and then the guest's browser
 * has to be talked out of blocking a ws:// socket opened by an https:// page.
 * See docs/remote-media-testing.md.
 */
const publicHost = process.env.WEB_PUBLIC_HOST?.trim();
const apiOrigin = `http://localhost:${process.env.API_PORT ?? 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: false,
    // Default binds loopback only, which a tunnel agent on this machine can
    // still reach — but not the LAN, and `host` costs nothing to widen here
    // because tunnel mode is opt-in.
    host: publicHost ? true : undefined,
    // Vite refuses requests carrying a Host header it does not know, so the
    // tunnel domain has to be named or every response is "Blocked request".
    allowedHosts: publicHost ? [publicHost] : undefined,
    // The HMR client derives its socket from the page URL and would dial
    // wss://<domain>:5173 — a port the tunnel does not publish. Left wrong, the
    // symptom is a full page reload on every edit, which during a media test
    // reads as the connection dropping.
    hmr: publicHost ? { protocol: 'wss', host: publicHost, clientPort: 443 } : undefined,
    proxy: publicHost
      ? {
          '/ws': { target: apiOrigin, ws: true },
          // The world GLB and its map document live on the api — it needs the
          // document for spawns anyway (apps/api/src/main.ts).
          '/assets': { target: apiOrigin, changeOrigin: true },
          '/health': { target: apiOrigin, changeOrigin: true },
        }
      : undefined,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js and Rapier are most of the bundle and change only when their
        // versions do. Splitting them means an application change re-downloads
        // ~100 KB instead of 3 MB, which is what keeps repeat loads inside the
        // NFR-13 budget.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
    // The three chunk is legitimately large; warning about it every build just
    // trains people to ignore warnings.
    chunkSizeWarningLimit: 1600,
  },
  optimizeDeps: {
    // The -compat build inlines its WASM, but Vite's dependency pre-bundler
    // still trips over the base64 payload during development.
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
