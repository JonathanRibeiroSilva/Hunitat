#!/usr/bin/env node
/**
 * Brings up the whole remote-testing stack: ngrok, then the api, then the web
 * dev server — in that order, because the order is the problem.
 *
 * Vite has to name the tunnel domain in `allowedHosts` or it answers every
 * request with "Blocked request", and an ephemeral ngrok URL does not exist
 * until the agent has connected. Doing this by hand means starting ngrok,
 * copying the domain, and restarting Vite with it — every single run. So the
 * agent starts first and the domain is read back from its local API.
 *
 * Media does NOT go through the tunnel. LiveKit publishes ICE candidates as
 * `node-ip:port` and nothing rewrites them, so a tunnelled SFU hands the
 * browser an address it cannot reach; the audio is silently missing while
 * everything else looks connected. LiveKit Cloud terminates TLS and runs TURN
 * itself, which is the part that cannot be faked locally.
 *
 * Configure in .env.tunnel (git-ignored) — see .env.tunnel.example.
 * Full walkthrough: docs/remote-media-testing.md
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomServiceClient } from 'livekit-server-sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The agent needs a moment to reach ngrok's edge; a cold start is ~2 s. */
const NGROK_READY_TIMEOUT_MS = 25_000;
/** ngrok's own default for its local inspection API. */
const NGROK_API_PORT = 4040;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const children = [];
let shuttingDown = false;

/** Marks a failure that has already been reported, so the top level does not
 *  print it a second time in a rawer form. */
class Fatal extends Error {}

/**
 * Throws rather than exiting. Exiting from here would be asynchronous — the
 * checks below `die()` would keep running and stack a second and third
 * complaint on top of the real one, burying it.
 */
function die(message, hint) {
  console.error(`\n${c.red('✗')} ${message}`);
  if (hint) console.error(`\n${hint}\n`);
  throw new Fatal(message);
}

/**
 * Minimal KEY=VALUE reader. Deliberately not dotenv: this runs before any
 * workspace is installed-checked, and the file it reads holds two secrets whose
 * parsing should be obvious rather than delegated.
 */
function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
  }
  return out;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
      .setTimeout(700)
      .on('connect', () => (socket.destroy(), resolve(true)))
      .on('timeout', () => (socket.destroy(), resolve(false)))
      .on('error', () => resolve(false));
  });
}

/**
 * Proves the three LiveKit values agree with each other *and* with the server
 * before anyone is invited. Wrong credentials do not fail loudly — the api
 * boots, the world works, tokens are minted and rejected at the SFU, and it
 * presents as "we can see each other but nobody can hear anything", which is a
 * long way to travel from the actual cause.
 */
async function preflightLiveKit({ url, key, secret }) {
  const httpUrl = url.replace(/^ws/, 'http');
  const client = new RoomServiceClient(httpUrl, key, secret);
  try {
    await client.listRooms();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(
      `LiveKit rejected the credentials — ${detail}`,
      `Checked ${c.cyan(url)}.\n` +
        `  · 401/unauthorized  → LIVEKIT_API_KEY or LIVEKIT_API_SECRET is wrong\n` +
        `  · connect failure   → LIVEKIT_URL is wrong, or the project is asleep\n` +
        `Copy all three from the same project at https://cloud.livekit.io`,
    );
  }
}

/**
 * Finds a port the ngrok agent can put its inspection API on.
 *
 * It matters that this is pinned rather than left to default. An agent whose
 * preferred port is taken quietly moves to the next one — and then reading
 * 4040 returns whatever *other* agent is already running, whose tunnel points
 * somewhere else entirely. Vite would be configured for a domain that is not
 * ours, which fails as an unexplained "Blocked request" much later.
 */
async function freeAgentApiPort() {
  for (let port = NGROK_API_PORT; port < NGROK_API_PORT + 20; port++) {
    if (!(await portInUse(port))) return port;
  }
  die('No free port for the ngrok inspection API between 4040 and 4059.');
}

async function ngrokPublicUrl(apiPort, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
      const { tunnels = [] } = await response.json();
      const https = tunnels.find((t) => t.public_url?.startsWith('https://'));
      if (https) return https.public_url;
    } catch {
      // Agent not listening yet.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function run(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  children.push({ label, child });

  const prefix = c.dim(`[${label}]`);
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`\n${c.red('✗')} ${label} exited with code ${code}`);
      shutdown(1);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${c.dim('shutting down…')}`);
  for (const { child } of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    // child.kill() on Windows leaves the actual server orphaned holding the
    // port, because the visible child is a shell wrapper.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 700);
}

async function main() {
  const env = { ...readEnvFile(path.join(ROOT, '.env')), ...readEnvFile(path.join(ROOT, '.env.tunnel')) };

  const webPort = Number(env.WEB_PORT ?? 5173);
  const apiPort = Number(env.API_PORT ?? 3000);

  // ── Configuration ────────────────────────────────────────────────────────
  if (!existsSync(path.join(ROOT, '.env.tunnel'))) {
    die(
      'No .env.tunnel found.',
      `Create it from the template:\n\n  ${c.cyan('cp .env.tunnel.example .env.tunnel')}\n\n` +
        `then fill in the three LiveKit Cloud values from https://cloud.livekit.io`,
    );
  }

  // LIVEKIT_CLOUD_*, not LIVEKIT_*: .env already defines LIVEKIT_URL as
  // ws://localhost:7880, and a shared name would let a value missing here fall
  // back to the local one without any complaint. Reading a name that exists in
  // only one file means "unset" stays visibly unset.
  const livekit = {
    url: env.LIVEKIT_CLOUD_URL ?? '',
    key: env.LIVEKIT_CLOUD_API_KEY ?? '',
    secret: env.LIVEKIT_CLOUD_API_SECRET ?? '',
  };

  if (!livekit.url || !livekit.key || !livekit.secret) {
    die(
      'LIVEKIT_CLOUD_URL, LIVEKIT_CLOUD_API_KEY and LIVEKIT_CLOUD_API_SECRET must all be set in .env.tunnel.',
      'Partial credentials look configured and reject every token — the api refuses to boot on\n' +
        'purpose rather than present as "nobody can hear anyone".',
    );
  }

  // The local dev values leaking into tunnel mode is the single most likely
  // mistake here, and it fails in the confusing direction: the api starts, the
  // client is handed ws://localhost:7880, and the guest's browser dials its own
  // machine. Nothing in the logs says so.
  if (/localhost|127\.0\.0\.1/.test(livekit.url)) {
    die(
      `LIVEKIT_CLOUD_URL still points at this machine (${livekit.url}).`,
      'A remote guest resolves localhost to their own computer. Tunnel mode needs the\n' +
        'wss://<project>.livekit.cloud URL — the SFU cannot be tunnelled, see\n' +
        'docs/remote-media-testing.md.',
    );
  }
  if (livekit.key === 'devkey') {
    die(
      'LIVEKIT_CLOUD_API_KEY is still the dev default.',
      'Use the key from your LiveKit Cloud project.',
    );
  }

  // ── Ports ────────────────────────────────────────────────────────────────
  for (const [port, what] of [
    [apiPort, 'the api'],
    [webPort, 'the web dev server'],
  ]) {
    if (await portInUse(port)) {
      die(
        `Port ${port} is already serving something — ${what} cannot start.`,
        `A dev server started the normal way is holding it, and that one is configured for\n` +
          `local LiveKit. It would mint tokens for the wrong SFU. Stop it and re-run.`,
      );
    }
  }

  // ── LiveKit reachability ─────────────────────────────────────────────────
  console.log(`${c.dim('→')} checking LiveKit credentials against ${c.cyan(livekit.url)} …`);
  await preflightLiveKit(livekit);
  console.log(`${c.green('✓')} LiveKit Cloud reachable and credentials accepted`);

  // ── Tunnel ───────────────────────────────────────────────────────────────
  const agentApiPort = await freeAgentApiPort();
  const ngrokArgs = [
    'http',
    String(webPort),
    '--web-addr',
    `127.0.0.1:${agentApiPort}`,
    '--log',
    'stdout',
    '--log-format',
    'logfmt',
  ];
  // A reserved domain survives restarts, so the guest's link keeps working. The
  // free tier includes one; without it the URL is new on every run.
  if (env.NGROK_DOMAIN) ngrokArgs.push(`--url=https://${env.NGROK_DOMAIN}`);

  console.log(`${c.dim('→')} starting ngrok …`);
  run('ngrok', env.NGROK_BIN ?? 'ngrok', ngrokArgs, {});

  const publicUrl = await ngrokPublicUrl(agentApiPort, Date.now() + NGROK_READY_TIMEOUT_MS);
  if (!publicUrl) {
    die(
      'ngrok did not report a public URL.',
      'Check the [ngrok] lines above. Most often:\n' +
        `  · ${c.bold('ERR_NGROK_334')} — another agent already holds that endpoint. Free plans allow\n` +
        `    one online endpoint, so an ngrok you started earlier will block this.\n` +
        `    ${c.cyan('tasklist | grep ngrok')} to find it.\n` +
        `  · no authtoken — ${c.cyan('ngrok config add-authtoken <token>')}`,
    );
  }
  const publicHost = new URL(publicUrl).host;
  console.log(`${c.green('✓')} tunnel up at ${c.cyan(publicUrl)}`);

  // ── Servers ──────────────────────────────────────────────────────────────
  run('api', 'npm', ['run', 'dev', '--workspace', '@hubitat/api'], {
    // Passed explicitly, not left to .env: the ports were checked above, and a
    // child that binds a different one than the one checked makes the check a
    // lie. Vite in particular reads WEB_PORT from the environment only — it
    // does not load .env itself.
    API_PORT: String(apiPort),
    LIVEKIT_URL: livekit.url,
    LIVEKIT_API_KEY: livekit.key,
    LIVEKIT_API_SECRET: livekit.secret,
    // Same address for both: the cloud SFU has one, unlike the Compose setup
    // where the server and the browser reach it differently.
    LIVEKIT_PUBLIC_URL: livekit.url,
  });

  run('web', 'npm', ['run', 'dev', '--workspace', '@hubitat/web'], {
    WEB_PORT: String(webPort),
    // vite.config.ts aims its /ws and /assets proxy at this port.
    API_PORT: String(apiPort),
    WEB_PUBLIC_HOST: publicHost,
    // Empty, not absent. Absent keeps the localhost defaults; empty means
    // same-origin, which is what makes the tunnelled page talk to the api
    // through Vite's proxy instead of the guest's own machine.
    VITE_API_URL: '',
    VITE_WS_URL: '',
  });

  // ── Verify, then hand out the link ───────────────────────────────────────
  const ready = await waitForApp(publicUrl, Date.now() + 60_000);
  console.log(
    `\n${ready ? c.green('✓ serving') : c.yellow('⚠ started, but the tunnel did not return the app yet')}\n\n` +
      `  ${c.bold('Send this:')}  ${c.cyan(publicUrl)}\n\n` +
      `  ${c.dim('The guest clicks through ngrok\'s warning page once, enters a name, and is in.')}\n` +
      `  ${c.dim('Checklist to run together: docs/remote-media-testing.md')}\n\n` +
      `  ${c.yellow('This world has no authentication')} ${c.dim('— the URL is the only thing gating it.')}\n` +
      `  ${c.dim('Ctrl-C stops all three processes.')}\n`,
  );
}

async function waitForApp(publicUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(publicUrl, {
        headers: { 'ngrok-skip-browser-warning': '1' },
        redirect: 'follow',
      });
      if (response.ok && (await response.text()).includes('<div id="root"')) return true;
    } catch {
      // Vite still booting behind the tunnel.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  if (!(error instanceof Fatal)) {
    console.error(`\n${c.red('✗')} ${error instanceof Error ? error.message : String(error)}`);
  }
  shutdown(1);
});
