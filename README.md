<div align="center">

# Hubitat

**A self-hosted, open-source 3D spatial collaboration platform.**

Walk an avatar through a shared 3D world and talk to whoever is standing near you.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-green.svg)](https://nodejs.org)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-2496ED.svg)](#self-hosting)

</div>

---

## What Hubitat is

Video calls put everyone in one rectangle and give the floor to one person at a time. Hubitat
replaces that with a **place**: a 3D room your team walks around in, where you hear the people near
you, drift over to a conversation, and step away from it — the way a physical office works.

Everything runs on **your own hardware**. There is no hosted plan, no account on somebody else's
server, and no telemetry. The whole stack is seven containers and a `docker compose up`.

### What it does

**Presence and movement** — Multiple people share one world, moving with real collision and gravity.
Everyone is an animated character that walks, runs and jumps, wears a name and a status, and can be
recoloured and reshaped without leaving the world.

**Spatial voice and video** — You hear whoever is near you, with distance falloff and directional
audio: voices get louder as you approach and pan to the side the avatar is on.

**Authored zones** — Volumes drawn into a map change the rules. A private zone isolates a
conversation, a spotlight carries a voice across the whole map, a portal moves you somewhere else.

**Text chat that matches the voice** — Send to the whole room, to whoever is standing near you, to
the zone you are in, or to one person. "People my local chat reaches" and "people I can talk to" are
the same set by construction — chat and audio call the same `resolveAudience()`, and there is no
distance check anywhere in the chat code.

**Accounts and membership** — Local accounts with a password, a profile and an avatar that outlive
the tab, plus invite links. A guest can become an account **without leaving the world** — no reload,
no walking back to where they were standing. Guest-only operation stays fully supported unless the
space is set to require accounts.

**Roles and moderation** — Owner, admin, member and guest, with one capability matrix read by the
HTTP guard, the WebSocket dispatcher and the client that draws the buttons. Moderators can mute,
disable video, send someone back to the entrance, remove or ban. A space can be locked, given a
password, restricted to an address allowlist, or capped. Anyone can block somebody, and it holds in
both directions and persists. Every moderator action lands in an append-only audit log.

**Multiple rooms** — A Space holds several Maps connected by portals. A busy Map spills into a second
copy of itself rather than turning people away, and the two copies genuinely cannot see or hear each
other. There is a directory of where everybody is, with one click to walk to any room or any person.

**A built-in map editor** — Build rooms without writing anything. The editor is a route in the same
client running the same scene, physics and tuning constants, so "preview it as a participant" is not
a preview — it is the thing. Place furniture from a bundled library, drag it with a gizmo, draw
authored volumes, move spawns, change the sun, then walk the draft. Drafts never touch what people
are standing in; publishing writes an immutable version and _offers_ the people inside a reload
rather than taking one.

**Interactive objects** — Walk up to an object and it offers itself: a link, an image, a document, a
video, a note. Or a shared surface — a whiteboard two people draw on at once, sticky notes, merging
text, a video whose play/pause/scrub moves the whole room. Late arrivals see what is already there,
concurrent edits merge rather than one winning, and what a workshop drew is still there on Monday.
That is [a CRDT doing its job](docs/adr/0012-collaborative-state-yjs.md), not logic written here.

### Design notes worth knowing up front

- **No Redis.** The job queue is pg-boss, in the database that is already there —
  [ADR 0009](docs/adr/0009-no-redis-in-memory-pgboss.md).
- **No SSO**, and the exclusion was re-examined rather than followed by default.
  [ADR 0011](docs/adr/0011-auth-local-accounts.md) records the decision and its consequence: nothing
  here is designed to accept an external subject, so SSO would be a new phase rather than a patch.
- **Movement is client-authoritative** — [ADR 0004](docs/adr/0004-client-authoritative-movement-aoi.md).
  A tampered client can walk through walls, but cannot escape server-side decisions: interest, zone
  occupancy and audience resolution are all computed on the server from the reported position, so a
  client that lies about where it stands still cannot hear a private conversation it is not in.

---

## Self-hosting

### Requirements

|                             |                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| **Docker** + Compose v2     | The only requirement for running the full stack                                              |
| **Node 20.11+** and npm 10+ | Only for development, or for regenerating assets                                             |
| **Open ports**              | TCP `5173`, `3000`, `7880`, `7881` · **UDP `50000–50100`** (WebRTC media)                    |
| **Hardware**                | ~2 vCPU / 4 GB RAM is comfortable for the 50-participant figure `NFR-1` was verified against |

### Quick start

```bash
git clone https://github.com/JonathanRibeiroSilva/Hubitat.git
cd Hubitat

cp .env.example .env      # then work through the production checklist below
docker compose up --build
```

Open <http://localhost:5173>, enter a name, and walk around. Open a second window and walk the two
avatars toward each other with both unmuted — the voices get louder and pan.

> **The first account to sign in owns the space.** A space whose members are all `member` has nobody
> who can appoint anybody, so the first sign-in is promoted to owner and gets the **Moderate** panel.
> Sign in yourself before sharing the URL.

### Production checklist

The defaults are development defaults. **Every item here matters before anyone outside your machine
connects.**

**1. Replace the three placeholder secrets in `.env`**

```ini
POSTGRES_PASSWORD=...        # currently: change-me-in-production
MINIO_ROOT_PASSWORD=...      # currently: change-me-in-production
LIVEKIT_API_SECRET=...       # currently: devsecret-change-me-at-least-32-chars (min 32 chars)
```

**2. Change the LiveKit key in `docker/livekit.yaml` too — it is a second copy**

The SFU reads its own credentials from its config file. `.env` alone is not enough; the two must
match or every media token is rejected and the symptom is "nobody can hear anyone".

```yaml
keys:
  yourkey: your-secret-at-least-32-characters-long
```

…with the same pair in `.env` as `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.

**3. Set `AUTH_JWT_SECRET` to 32+ characters**

Left empty, the server generates one at boot — so every access token becomes invalid on restart and
everybody is signed out at once, which reads as a session bug rather than a missing variable. It
signs every access token, and a short one can be recovered offline from a single captured token.

**4. Point the public URLs at your real hostname**

```ini
VITE_API_URL=https://hubitat.example.com
VITE_WS_URL=wss://hubitat.example.com/ws
LIVEKIT_PUBLIC_URL=wss://hubitat.example.com:7880
MINIO_PUBLIC_URL=https://hubitat.example.com:9000
PUBLIC_WEB_URL=https://hubitat.example.com     # where invite and reset links point
AUTH_COOKIE_SECURE=true
```

> ⚠️ **`VITE_API_URL` and `VITE_WS_URL` are build arguments**, baked into the client bundle by
> `apps/web/Dockerfile`. Changing them requires `docker compose up --build`, not a restart. Every
> _other_ value in `.env` is read at runtime (`NFR-39`).

**5. Make the bundled LiveKit config reachable**

`docker-compose.yml` starts the SFU with `--node-ip 127.0.0.1` and `use_external_ip: false` — correct
for one machine, and unreachable for anyone else. For a real deployment set the node IP to the
server's publicly reachable address and open **UDP 50000–50100**. WebRTC media does not travel over
your HTTP reverse proxy.

**6. Replace the development mail relay**

Mailpit accepts everything and delivers to a web inbox on `:8025` — it exists so a password-reset
link can be followed without a relay. Point `SMTP_*` at a real one, or leave `SMTP_HOST` **empty** to
disable password recovery entirely, which is supported and deliberate. `SMTP_HOST` set with
`SMTP_FROM` empty is refused at boot: a relay that accepts the connection and rejects every message
presents as recovery being broken rather than misconfigured.

**7. Decide who may enter**

`SPACE_ALLOW_GUESTS=false` requires an account to join. Note this only **seeds** the row — once the
space exists the database is authoritative, so an operator who closes the space from the moderation
panel does not find it reopened by the next restart. The same is true of locks, passwords,
allowlists, bans and roles: all of it is state, not configuration.

### The services

| Service    | Port                          | What it is                                                         | Required?            |
| ---------- | ----------------------------- | ------------------------------------------------------------------ | -------------------- |
| `web`      | 5173                          | Vite + React + Three.js client                                     | **Yes**              |
| `api`      | 3000                          | NestJS — REST, WebSocket, 20 Hz world tick                         | **Yes**              |
| `postgres` | 5432                          | Accounts, chat history, map catalogue, drafts, shared object state | Strongly recommended |
| `livekit`  | 7880 / 7881 / 50000–50100 udp | The SFU carrying voice and video                                   | Optional             |
| `minio`    | 9000 / 9001                   | Object storage for uploaded assets                                 | Optional             |
| `worker`   | —                             | The asset pipeline, in its own process                             | Optional             |
| `mailpit`  | 1025 / 8025                   | Password recovery — **development only**                           | Optional             |

`worker` publishes no port and serves nothing. It exists because optimizing a model is tens of
seconds of synchronous CPU while `api` runs the 20 Hz world tick — and because it is where untrusted
uploads are parsed (`NFR-33`), so an out-of-memory kill costs a container restart rather than every
WebSocket connection in the deployment.

`coturn` is commented out in `docker-compose.yml`; it is only needed behind restrictive NAT.

### Running a smaller stack

Every optional service degrades to a **stated** behaviour rather than a broken one. The server says
which mode it is in at boot.

| Leave out        | What happens                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres`       | Guest-only. Chat history is kept in memory, accounts are off, maps are read straight from `assets/world`. Roles and moderation need accounts, so blocking lasts only as long as the session. Editing a map or changing the catalogue needs a database.                                                                                           |
| `livekit`        | No voice or video. Leave **all three** of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` empty — the world, movement and presence are unaffected and the media controls do not render. Setting _some_ of the three is refused at boot: partial credentials look configured, reject every token, and present as "nobody can hear anyone". |
| `minio`          | No asset uploads. The built-in object library ships in the repository and is served statically, so maps can still be built (`FR-9.15`).                                                                                                                                                                                                          |
| `worker`         | Uploaded models are usable exactly as they arrived, with no level-of-detail variants — and the interface says so.                                                                                                                                                                                                                                |
| `mailpit` / SMTP | No password recovery. Deliberate and supported ([ADR 0011](docs/adr/0011-auth-local-accounts.md)).                                                                                                                                                                                                                                               |

### Operating it

`GET /health` reports participant count and observed tick duration — the number that shows load
before users do (`NFR-38`). Watch the tick: overrunning its budget is what a too-high
`DEFAULT_MAP_CAPACITY` looks like.

**Testing with people who are not on your network** — `npm run tunnel` and
`docker-compose.tunnel.yml` stand up a temporary public route so you can get a second person onto a
second machine, which the audio criteria genuinely require (two tabs on one box share a microphone
and cannot produce real capture latency or echo). See
[`docs/remote-media-testing.md`](docs/remote-media-testing.md).

---

## Configuration

Every tunable value lives in [`.env.example`](.env.example) — around a hundred of them, each
commented — with defaults from
[`specs/conventions/tuning-defaults.md`](specs/conventions/tuning-defaults.md).

Several **relationships** between values are validated at boot, and the server refuses to start if
any is violated. All of them otherwise produce symptoms nobody traces back to configuration:

- `AOI_EXIT_RADIUS_M` must exceed `AOI_ENTER_RADIUS_M` — the gap is the hysteresis that stops avatars
  flickering in and out at a boundary.
- `MAX_AUDIBLE_DISTANCE_M` must be smaller than `AOI_ENTER_RADIUS_M`, or someone becomes audible
  before they have ever been announced as present.
- `CHAT_NEARBY_RADIUS_M` must be smaller than `AOI_ENTER_RADIUS_M`, or a nearby message can arrive
  from somebody the recipient has never been told is present — worse than failing, because the reply
  goes to a person the client cannot find.
- `STALE_SESSION_TIMEOUT_MS` must exceed twice `PING_INTERVAL_MS`, or one dropped pong evicts a
  healthy session.
- `ZONE_HYSTERESIS_M` and `AUDIO_HYSTERESIS_M` may not be negative — a negative band makes the exit
  test tighter than the enter test, so standing on an edge toggles zone isolation, or renegotiates a
  WebRTC track, every tick.
- `DEFAULT_MAP_CAPACITY` must be at least 2. Below that nobody can ever be joined by anybody, and it
  presents as "the second person cannot connect".
- `ARGON2_MEMORY_KIB`, `ARGON2_ITERATIONS` and `ARGON2_PARALLELISM` may not fall below the OWASP
  argon2id floor (`FR-6.3`). This is the one set of numbers where a weaker value produces **no
  symptom at all** — logins get faster, an offline attack against a stolen table gets cheaper, and
  nothing in the running system ever mentions it.
- `ACCESS_TOKEN_TTL_MIN` must be shorter than `REFRESH_TOKEN_TTL_DAYS`, or refreshing a session can
  never extend it and the client loops between a 401 and a refresh that fixes nothing.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` must be set together or not at all.
- `AUTH_JWT_SECRET`, when set, must be at least 32 characters.
- `SMTP_HOST` set with `SMTP_FROM` empty is refused.

A few more are **warnings** rather than refusals, because each is right for development or otherwise
legitimate: `DEFAULT_MAP_CAPACITY` above 50, an unset `AUTH_JWT_SECRET`, an empty `SMTP_HOST`,
`AUTH_COOKIE_SAMESITE=none` without `Secure` (a cookie every browser discards, so sign-in appears to
work and the first refresh fails), and `CHAT_NEARBY_RADIUS_M` diverging from `MAX_AUDIBLE_DISTANCE_M`.

### The one that catches everybody

`LIVEKIT_URL` is how the **server** reaches the SFU; under Compose that is `ws://livekit:7880`, a
name no browser can resolve. `LIVEKIT_PUBLIC_URL` is what **clients** are told. They default to the
same value, which is correct everywhere the SFU has one address — and wrong under Compose, which is
why the compose file sets both. MinIO has the identical split for the identical reason: a presigned
URL carries its host inside the signature, so it must be signed against the address the browser will
actually use.

---

## Development

```bash
npm install
cp .env.example .env          # optional: every value has a default

npm run build                 # builds the shared packages first

docker compose up -d livekit  # voice and video; skip it to run without them
docker compose up -d postgres # accounts and durable chat; skip it to run guest-only

# two terminals
npm run dev --workspace @hubitat/api    # http://localhost:3000
npm run dev --workspace @hubitat/web    # http://localhost:5173
```

Open <http://localhost:5173> in **two browser windows**, enter a name in each, and walk around.
Unmute in both and walk toward each other: the voices get louder, and pan to the side the avatar is
on. Press **1–6** to react, and open **Avatar** in the corner to change how you look — the other
window sees it immediately.

Press **Enter** to chat. The channel strip is who hears you: **Room** reaches everyone, **Nearby**
reaches the same 12 m as your voice, a **zone** channel appears while you stand in one that has chat
enabled, and **msg** beside a name opens a direct thread. Walk one window 20 m away and send to
Nearby — it does not arrive. Send to Room and it does.

With Postgres running, open **Account** in the corner. As a guest it offers to make you one and keeps
your name, your avatar and your place while it does — watch your own nameplate rather than the form.

### Regenerating the assets

The world GLBs, the avatar and the built-in object library are all committed. To rebuild them:

```bash
node assets/world/build-world.mjs      # office.glb + atrium.glb, the two starter maps
node assets/avatars/build-avatars.mjs
node assets/library/build-library.mjs  # the built-in props a map is built from (FR-9.15)
```

Dropping another `*.map.json` beside them adds a Map to a **fresh** deployment and does nothing to an
established one: the catalogue is seeded from disk by slug, once, and the database is authoritative
afterwards. That is what stops a Map somebody renamed or archived through the API from reappearing on
the next restart.

Both generators stand in for authored content — a CC0-kit world, and the VRM avatars
[ADR 0010](docs/adr/0010-3d-formats-gltf-vrm.md) chose. Replacing either is a file swap rather than a
code change, provided its contract is kept:

- **World** — the node-naming convention in
  [`specs/protocol/map-document.md`](specs/protocol/map-document.md). `COL_` meshes become collision
  and are never rendered.
- **Avatar** — the clip and material names in
  [`assets/avatars/README.md`](assets/avatars/README.md). The client warns, by name, about anything a
  loaded model is missing.

---

## Testing

There is no unit test suite. The test mechanism is an **assertive bot harness** that runs against a
live server, so interest-management and wire-format regressions fail there rather than surfacing
later as avatars in the wrong place.

```bash
npm run dev --workspace @hubitat/api    # in one terminal
npm run harness                         # in another

npm run harness -- aoi                  # a single scenario
```

Thirty-nine scenarios, roughly 100 seconds. The harness needs no LiveKit — it asserts the server's
decisions, and the server decides who hears whom without any media existing. Twenty-two scenarios
need no database either; the phase 6 and 7 scenarios do, and **skip by name and with a reason** when
the server reports accounts as disabled. Skips are counted separately from passes, because a skip
reported as a pass would make a database-less run look like it had covered criteria it never touched.

```bash
docker compose up -d postgres   # then the harness covers accounts and moderation too
```

What is **verified by hand**, because there is no browser automation: how movement looks, how things
sound, how avatars animate, message rendering, the editor's gizmos and undo, and that the SFU itself
refuses a publish rather than merely that the server decided it should. Automated testing of spatial
audio quality or an animation blend is not practical; what _is_ automated is the decision underneath.

Details and what each scenario protects: [`docs/testing-strategy.md`](docs/testing-strategy.md).

---

## Project layout

```
specs/         behaviour — the authority on what to build
  conventions/   coordinates & units · tuning defaults
  protocol/      wire protocol · map document
  ux/            screens and states
docs/          decisions, architecture, testing strategy
apps/
  web/           Vite + React + Three.js — the client
    media/         LiveKit room, subscriptions, and the Web Audio graph
  api/           NestJS — REST, WebSocket, and the 20 Hz world tick
    auth/          accounts, profiles, spaces, invites, sessions, roles
    media/         LiveKit access tokens and publish permissions
    chat/          scoping, history store (memory or Postgres), typing, read state
    moderation/    access policy, bans, blocks, reports, audit log, the roles guard
    world/         maps, instances, portals, the space directory
    persistence/   the one database connection, shared by chat, auth and moderation
  worker/        the asset pipeline, in its own process
  harness/       headless assertive bots
packages/
  protocol/      opcodes, binary codecs, schemas, tuning constants
  world-core/    pure logic: spatial grid, interest management, audience
  ui/            shared interface primitives
  config/        shared tsconfig / prettier
assets/
  world/         the starter maps and their map documents
  avatars/       the rigged, animated avatar GLB
  library/       the built-in prop library the editor builds from
```

`protocol` and `world-core` are imported by the client, the server **and** the bots. A change to a
byte layout breaks all three compilations at once instead of producing silent runtime drift. That is
the reason this is a monorepo.

Further reading: [`docs/architecture.md`](docs/architecture.md) for how it fits together,
[`docs/adr/`](docs/adr/README.md) for thirteen decision records, and [`specs/`](specs/README.md) for
the technology-neutral behaviour specification the whole thing was built against.

---

## Known limitations

These are deliberate or inherent, not a backlog we forgot about.

- **There is no way to remove a message once sent.** Moderators get the people; the words are
  untouched. Adding deletion means deciding what happens to a persisted history other people have
  already read.
- **A direct message reaches someone who is online.** Storage moved to durable identity, so a
  conversation between two accounts is one row set across any number of reconnects and unread markers
  survive them — but delivery still resolves a live session, so a thread you can open is a thread
  whose other end is here.
- **A guest's direct conversations and blocks are session-scoped**, and always will be. There is
  nothing durable to key them on.
- **A guest ban is weak, and the interface says so where it is issued.** It keys on a browser
  fingerprint and an address: clearing site data defeats it, another browser defeats it, and matching
  on an address catches everybody behind the same office NAT. The real remedy is one checkbox along —
  requiring accounts. An **account** ban is exact.
- **Capacity refuses; it does not shard.** A full Map spills into a second instance; a full _space_
  turns you away.
- **Moderators bypass lock, password, allowlist and capacity.** Deliberately: all four can be switched
  on from inside the world, and without the exception an admin who locks a space and then loses their
  connection has no way back in to unlock it. The ceiling is soft by the number of moderators.
- **The audit log is append-only against the application, not against a DBA.** A `REVOKE` stops this
  process and any future endpoint that forgets; a trigger would stop a superuser, which the default
  Compose deployment happens to be. Somebody with a `psql` prompt can drop the trigger, and that is
  the honest limit of "tamper-evident enough to be trusted".
- **Movement is client-authoritative** — see the design note above.

---

## Contributing

**Contributions are genuinely welcome — this is open source and it is meant to be worked on.**
Bug reports, documentation fixes, new maps, new avatars and code are all useful, and you do not need
permission to start.

**Good first steps**

- Open an [issue](https://github.com/JonathanRibeiroSilva/Hubitat/issues) for a bug or an idea — a
  question counts as a contribution, especially if the docs sent you the wrong way.
- Self-host it and tell us where the setup hurt. This README is the part most likely to be wrong for
  a deployment that is not the author's.
- Build a map with the editor, or swap in a different world or avatar. Both are file swaps rather
  than code changes.

**Before opening a pull request**

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format         # prettier, config in prettier.config.mjs

npm run dev --workspace @hubitat/api   # then, in another terminal:
npm run harness                        # 39 scenarios, ~100s — behaviour changes should keep it green
```

**How this codebase is organised, and what a good change looks like**

[`specs/`](specs/README.md) is the authority on _what_ to build and [`docs/adr/`](docs/adr/README.md)
on _why_ it is built this way. If a change contradicts an ADR, that is worth doing — but say so in
the PR and propose a new ADR rather than quietly diverging, because the next person will read the
record and not the diff.

The pattern worth preserving: rules live in **one** place and everything else calls it. Chat has no
distance check because it calls `resolveAudience()`; the media layer has no block check for the same
reason. A change that adds a parallel implementation of a rule is the change most likely to be asked
about in review.

New behaviour that a headless bot can hold an opinion about should come with a harness scenario. New
behaviour that only an eye can judge — how something looks, sounds or animates — should come with a
line on the manual checklist in [`docs/testing-strategy.md`](docs/testing-strategy.md) instead.

---

## License

[MIT](LICENSE) © Hubitat contributors.

You can use, modify, self-host and redistribute this, commercially or otherwise. If you build
something with it, we would like to hear about it.
