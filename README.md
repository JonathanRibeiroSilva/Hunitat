# hubitat

A self-hosted, open-source **3D spatial collaboration platform** — walk an avatar through a
shared 3D world and talk to whoever is near you.

- **What to build:** [`specs/`](specs/README.md) — ten phases, technology-neutral.
- **How we build it:** [`docs/adr/`](docs/adr/README.md) — thirteen decision records.
- **How it fits together:** [`docs/architecture.md`](docs/architecture.md).

**Current state: all ten phases complete.** Multiple people connect to one shared world,
move around with collision and gravity, and see each other in real time. They hear and see whoever
is near them, with distance falloff and directional audio. Authored zones change the rules — a
private zone isolates a conversation, a spotlight carries across the map, a portal moves you
elsewhere. Everyone is an animated character that walks, runs and jumps, wears a name and a status,
shows a ring when they speak, can be recoloured and reshaped without leaving the world, and can
wave at you. And everyone can type: to the whole room, to whoever is standing near them, to the
zone they are in, or to one person. And all of it can now belong to somebody: a local account with
a password, a profile and an avatar that outlive the tab, invite links that make people members of
the space, and a guest who can become an account **without leaving the world** — no reload, no
walking back to where they were standing. Guests still work exactly as they did, unless the space
is set to require accounts.

And now the space can be **governed**. Everybody has a role — owner, admin, member or guest — and one
capability matrix decides what each may do, read by the HTTP guard, by the WebSocket dispatcher and by
the client that draws the buttons. A moderator can mute somebody, turn off their video, send them back
to the entrance, remove them, or ban them for an evening or for good. A space can be locked, given a
password, restricted to a list of addresses, or capped — each refusing with its own reason rather than
a shrug. Anyone can block somebody they would rather not hear, and it holds in both directions and
comes back with them tomorrow. Anyone can report somebody, and the server writes down where it
happened. Everything a moderator does lands in a log the application is not allowed to rewrite.

Phase 3 was built before Phase 2 on purpose. It decides _who may hear whom_, which is testable
with no media layer at all — the server publishes each participant's resolved audience and the
bot harness asserts against it. Phase 2 is then the plumbing that carries that decision, rather
than a place where the rules get invented a second time.

Phase 5 is the payoff for that ordering. "People my local chat reaches" and "people I can talk to"
are required to be the same set, and they are — not because two implementations are kept in step,
but because chat calls the same `resolveAudience()`. There is no distance check anywhere in the
chat code.

Phase 7 is the other half of that argument. `FR-7.16` asks for blocking; the Phase 7 notes say it
belongs "inside `resolveAudience()`, so a block is one more input to the function Phases 2, 3 and 5
already use, rather than a parallel filter". It is — and the consequence is that a blocked person
stops being heard and stops being read at exactly the same instant, without either half knowing the
other exists. There is still no distance check in the chat code, and now there is no block check in
the media code either.

Phase 6 collects a debt the earlier phases each left a note about. `FR-4.8` asked for an avatar
that persists "with their identity" and there was no identity, so it persisted per browser. Phase 5
said a direct message targets a session id and durable conversations would need Phase 6. Both move
here, and neither changed shape: the avatar is the same JSON in `profiles.avatar_appearance`, and
the `messages` table has the same columns with a durable identity in them.

And now the space is a **building**, not a room. A Space holds several Maps, connected by portals
that resolve the abstract destinations phase 3 deliberately left open — walk through the west arch
of the office and you are in the atrium, seen arriving by whoever is standing there and gone from
the room you left, with your voice on a different SFU room by the time you land. A busy Map spills
into a second copy of itself rather than turning people away, and the two copies genuinely cannot
see or hear each other — separate registries, separate rooms, separate everything — which is the
kind of isolation that is either structural or eventually a bug, so it is structural. The interface
says so plainly, because two colleagues in the same room unable to hear each other is baffling
otherwise. There is a directory of where everybody is, one click to walk to any room and one to
walk to a person; and rooms can be created, renamed, capped, archived and deleted, with the people
inside an archived one moved out and told rather than left somewhere that no longer exists.

Those rooms can now be **built without writing anything**. The editor is a route in the same client
running the same scene, the same physics and the same tuning constants — so "preview it as a
participant" is not a preview, it is the thing, and a zone behaves at runtime the way the editor
draws it because the same code reads it. Place furniture from a library that ships with the server,
drag it with a gizmo, draw the six kinds of authored volume, move the spawns, change the sun, then
walk the draft with the same character controller everybody else uses. Undo covers all of it, because
there is exactly one way to change the document. Drafts never touch what people are standing in;
publishing writes an immutable version and offers the people inside a reload rather than taking one;
reverting copies an old version _forward_, so changing your mind again is a click rather than an
archaeology project. Two authors cannot silently overwrite each other — one holds an advisory lock,
and behind it every save is a compare-and-set. Uploaded models go straight to object storage without
passing through the process running the world tick, and are parsed, validated and simplified in a
container of their own, because thirty seconds of synchronous CPU next to a 20 Hz tick is a room
full of people stuttering.

And the objects in those rooms **do something**. Walk up to one and it offers itself — the nearest
one only, with the same key and the same words whatever it holds. A link that says out loud that it
is leaving, an image, a document, a video, a note. Or a surface people share: a whiteboard two
people can draw on at once and converge, sticky notes to drag around, text that merges rather than
overwrites, a video whose play, pause and scrub move the whole room. Somebody who arrives ten
minutes late sees what is already there rather than an empty board, concurrent edits merge rather
than one of them winning, and what a workshop drew is still there on Monday. None of that is logic
written here and argued about — it is what a CRDT is, which is the whole reason
[ADR 0012](docs/adr/0012-collaborative-state-yjs.md) chose one. There is no generic app framework
and nowhere to put one: five content types, a closed enum, no sandbox and no bridge.

There is deliberately **no SSO**, and the exclusion was re-examined rather than followed by default
— this is an internal company tool, the one context where corporate SSO is normally mandatory.
[ADR 0011](docs/adr/0011-auth-local-accounts.md) records the decision and its consequence: nothing
here is designed to accept an external subject, so SSO would be a new phase rather than a patch.

---

## Requirements

- **Node 20.11+** and npm 10+
- **Docker** and Docker Compose — only for running the full stack; not needed for development

---

## Development

Postgres holds chat history from Phase 5, accounts from Phase 6, the map catalogue from Phase 8,
drafts and the asset library from Phase 9 and shared object state from Phase 10 — and is _still_
optional: with no database reachable the server keeps room and direct history in memory, turns
accounts off, reads its maps straight from `assets/world`, and says all of it at boot. Everybody
joins as a guest, which is what `FR-1.7` describes and what every build before phase 6 did.
Multi-map, portals between maps, instancing and the directory all work without one; what needs a
database is _changing_ the catalogue, editing a map, and keeping what people draw.

MinIO is needed only to **upload** assets. The built-in library ships in the repository and is
served statically, so a map can be built with no object storage at all (`FR-9.15`). LiveKit is
needed only for voice and video; Mailpit only for password recovery; the `worker` container only to
optimize uploads — without it an uploaded model is usable exactly as it arrived, with no
level-of-detail variants, and says so.

Roles and moderation need the database that phase 6 introduced: without one there are no accounts,
so everybody is a guest, and a guest has nothing to hold a role on. Blocking still works for as long
as the session that made it lasts, which is what a guest's block was always going to be.

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
Unmute in both and walk toward each other: the voices get louder, and pan to the side the avatar
is on. Press **1–6** to react, and open **Avatar** in the corner to change how you look — the other
window sees it immediately.

Press **Enter** to chat. The channel strip is who hears you: **Room** reaches everyone, **Nearby**
reaches the same 12 m as your voice, a **zone** channel appears while you stand in one that has
chat enabled, and **msg** beside a name in the presence list opens a direct thread. Walk one window
20 m away and send to Nearby — it does not arrive. Send to Room and it does.

With Postgres running, open **Account** in the corner. As a guest it offers to make you one and
keeps your name, your avatar and your place while it does — watch your own nameplate rather than
the form. Once you are a member it issues invite links.

The **first account to sign in owns the space**, because a space whose members are all `member` has
nobody who can appoint anybody. That account gets a **Moderate** button beside Account: roles, access
policy, bans, reports and the audit log. Everything urgent is somewhere else — hover a name in the
presence list and press **⋯** to block, report, mute, turn off video, send somebody back to the
entrance, remove them or ban them.

Try it with two windows. Mute the other one and watch its microphone button go dark with a sentence
saying who did it; reload that window and watch the mute still be there. Block it instead, and it stays
in the presence list, struck through, and goes completely silent both ways.

**Running without voice and video** — leave `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` empty. The world, movement and presence are unaffected and the media
controls do not render. Setting _some_ of the three is refused at boot: partial credentials look
configured, reject every token, and present as "nobody can hear anyone".

### Regenerating the assets

The world GLBs, the avatar and the built-in object library are all committed. To rebuild them:

```bash
node assets/world/build-world.mjs      # office.glb + atrium.glb, the two starter maps
node assets/avatars/build-avatars.mjs
node assets/library/build-library.mjs  # the built-in props a map is built from (FR-9.15)
```

Dropping another `*.map.json` beside them adds a Map to a **fresh** deployment and does nothing to
an established one: the catalogue is seeded from disk by slug, once, and the database is
authoritative afterwards. That is what stops a Map somebody renamed or archived through the API
from reappearing on the next restart.

Both generators stand in for authored content — a CC0-kit world, and the VRM avatars
[ADR 0010](docs/adr/0010-3d-formats-gltf-vrm.md) chose. Replacing either is a file swap rather than
a code change, provided its contract is kept:

- **World** — the node-naming convention in
  [`specs/protocol/map-document.md`](specs/protocol/map-document.md). `COL_` meshes become
  collision and are never rendered.
- **Avatar** — the clip and material names in
  [`assets/avatars/README.md`](assets/avatars/README.md). The client warns, by name, about anything
  a loaded model is missing.

---

## Testing

There is no unit test suite. The test mechanism is an **assertive bot harness** that runs against
a live server, so interest-management and wire-format regressions fail there rather than
surfacing later as avatars in the wrong place.

```bash
npm run dev --workspace @hubitat/api    # in one terminal
npm run harness                         # in another

npm run harness -- aoi                  # a single scenario
```

Thirty-nine scenarios, roughly 100 seconds. Details and what each one protects:
[`docs/testing-strategy.md`](docs/testing-strategy.md).

The harness still needs no LiveKit: it asserts the server's decisions, and the server decides who
hears whom without any media existing — including who may publish, which is what makes `AC-7.2`
testable without an SFU. Twenty-two of the scenarios need no database either. The **five phase 6 and
six phase 7 scenarios do** — an account has nowhere to live otherwise, and a role has nothing to
attach to — so they skip, by name and with a reason, when the server reports accounts as disabled.
Skips are counted separately from passes, because a skip reported as a pass would make a run against
a database-less server look like it had covered `AC-6.1`–`AC-7.6`.

```bash
docker compose up -d postgres   # then the harness covers phase 6 as well
```

What is **verified by hand**, because there is no browser automation: `AC-1.1`, `AC-1.2` and
`AC-1.3`, which are about how movement looks; `AC-2.1`–`AC-2.7` plus `AC-3.2` and `AC-3.3`, which
are about how things sound; and `AC-4.1`, `AC-4.3` and `AC-4.6`, which are about how avatars
animate. Automated testing of spatial audio quality or an animation blend is not practical; what
_is_ automated is the decision underneath — whether the right people were in the audience, at the
right gain, and whether the appearance, status and emote actually reached them.

Phase 5 is the first phase where almost nothing is left to the eye. Who received a message is a
fact, so all six of its acceptance criteria are covered by scenarios; only message _rendering_ —
formatting, links, and that a pasted `<script>` stays literal text — is checked by hand.

Phase 6 is the same: all six of `AC-6.1`–`AC-6.6` are covered by scenarios, including the two
concurrency cases that are easy to get wrong and impossible to notice — two people redeeming the
same single-use invite in the same instant, and a refresh token presented twice.

Phase 7 covers all six of `AC-7.1`–`AC-7.6`, and three of its assertions exist because the
implementation notes named the failure first. `moderation-capabilities` refuses a member on **both**
transports, because a guard on the REST controllers protects nothing a modified client would use
(`NFR-34`). `force-mute` drops the socket and comes back, because a mute that a reconnect undoes is a
suggestion. `kick-and-ban` presents a _valid resume token_ from a banned account, because a ban
checked only on fresh joins lasts until its target reconnects.

The one half that is **not** automated is the SFU call itself — that LiveKit refuses the publish, and
not merely that the server decided it should. That is the two-call pattern in `MediaService`, and it
is on the manual checklist with the rest of the media work.

Phase 8 covers all six of `AC-8.1`–`AC-8.6`, and the assertions that matter are the negative ones:
that a room message does **not** cross a door, that somebody in a second copy of a room is **not**
in the presence list of the first, and that archiving a room moves the people in it out with a
notice rather than disconnecting them. Phase 9 covers `AC-9.5` and `AC-9.6` — that a draft never
reaches the live map, that a stale save is refused with a 409 rather than merged, that publishing
does not disturb the people inside, and that reverting copies _forward_ so the version reverted away
from is still reachable. What is checked by hand there is the editor itself: gizmos, undo across zone
and property edits, and play-mode, none of which a headless bot can hold an opinion about.

Phase 10 covers `AC-10.3`–`AC-10.6` with a headless CRDT client speaking the same `y-protocols` the
browser does: two clients converge on both strokes, somebody across the room is refused the channel,
a late joiner receives what is already there, and it all survives everybody leaving. The content
types themselves — that a link opens, an image renders, a video plays — are on the manual checklist,
because what they are is a browser doing its job.

The audio criteria need a second person on a second machine — two tabs on one box share a
microphone and cannot produce real capture latency or echo. Getting someone else connected, and
the checklist to run once they are:
[`docs/remote-media-testing.md`](docs/remote-media-testing.md).

---

## Running the whole stack

```bash
cp .env.example .env          # then change every "change-me" value
docker compose up --build
```

| Service    | Port        | Phase it starts serving                    |
| ---------- | ----------- | ------------------------------------------ |
| `web`      | 5173        | 1                                          |
| `api`      | 3000        | 1                                          |
| `postgres` | 5432        | 5, 6, 7, 8, 9, 10                          |
| `livekit`  | 7880        | 2                                          |
| `minio`    | 9000 / 9001 | 9 (asset uploads)                          |
| `worker`   | —           | 9 (the asset pipeline, in its own process) |
| `mailpit`  | 1025 / 8025 | 6 (password recovery, development only)    |

`worker` publishes no port and serves nothing. It exists because optimizing a model is tens of
seconds of synchronous CPU and `api` runs the 20 Hz world tick — and because it is where untrusted
uploads are parsed (`NFR-33`), so an out-of-memory kill there costs a container restart rather than
every WebSocket connection in the deployment.

There is deliberately **no Redis** — [ADR 0009](docs/adr/0009-no-redis-in-memory-pgboss.md).
`coturn` is commented out in `docker-compose.yml`; it is only needed behind restrictive NAT.

`GET /health` reports participant count and observed tick duration, which is the number that
shows load before users do (`NFR-38`).

---

## Layout

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
    persistence/   the one database connection, shared by chat, auth and moderation
  harness/       headless assertive bots
packages/
  protocol/      opcodes, binary codecs, schemas, tuning constants
  world-core/    pure logic: spatial grid, interest management, audience
  ui/            shared interface primitives
  config/        shared tsconfig / prettier
assets/
  world/         the phase 1 GLB and its map document
  avatars/       the phase 4 rigged, animated avatar GLB
```

`protocol` and `world-core` are imported by the client, the server **and** the bots. A change to
a byte layout breaks all three compilations at once instead of producing silent runtime drift.
That is the reason this is a monorepo.

---

## Configuration

Every tunable value lives in [`.env.example`](.env.example), with defaults from
[`specs/conventions/tuning-defaults.md`](specs/conventions/tuning-defaults.md). Nothing requires
a rebuild to change (`NFR-39`).

Several relationships are validated at boot, and the server **refuses to start** if any is
violated. All of them produce symptoms nobody traces back to configuration:

- `AOI_EXIT_RADIUS_M` must exceed `AOI_ENTER_RADIUS_M`. The gap is the hysteresis that stops
  avatars flickering in and out at a boundary.
- `STALE_SESSION_TIMEOUT_MS` must exceed twice `PING_INTERVAL_MS`, or one dropped pong evicts a
  healthy session.
- `ZONE_HYSTERESIS_M` and `AUDIO_HYSTERESIS_M` may not be negative — the same failure as equal
  AOI radii, one phase later each. A negative band makes the exit test tighter than the enter
  test, so standing on an edge toggles zone isolation, or renegotiates a WebRTC track, on every
  tick.
- `MAX_AUDIBLE_DISTANCE_M` must be smaller than `AOI_ENTER_RADIUS_M`, or someone can become
  audible before they have ever been announced as present.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` must be set together or not at all.
- `DEFAULT_MAP_CAPACITY` must be at least 2. Below that nobody can ever be joined by anybody, which
  is not a capacity limit — and it presents as "the second person cannot connect".
- `CHAT_NEARBY_RADIUS_M` must be smaller than `AOI_ENTER_RADIUS_M`, or a nearby message can arrive
  from somebody the recipient has never been told is present. The message carries its sender's
  name so it would still render — which is worse than failing, because the reply goes to a person
  the client cannot find.
- `ARGON2_MEMORY_KIB`, `ARGON2_ITERATIONS` and `ARGON2_PARALLELISM` may not fall below the OWASP
  argon2id floor (`FR-6.3`). This is the one set of numbers here where a weaker value produces **no
  symptom at all** — logins get faster and an offline attack against a stolen table gets cheaper,
  and nothing in the running system ever mentions it.
- `ACCESS_TOKEN_TTL_MIN` must be shorter than `REFRESH_TOKEN_TTL_DAYS`, or refreshing a session can
  never extend it and the client loops between a 401 and a refresh that fixes nothing.
- `AUTH_JWT_SECRET`, when set, must be at least 32 characters. It signs every access token, and a
  short one can be recovered offline from a single captured token.
- `SMTP_HOST` set with `SMTP_FROM` empty is refused: a relay accepts the connection and rejects
  every message, which presents as password recovery being broken rather than misconfigured.

Four settings are **warnings** rather than refusals, because each is right for development, or
legitimate, and wrong or accidental otherwise. `DEFAULT_MAP_CAPACITY` above 50 is the fourth: that is
the figure `NFR-1` was verified against, raising it may well have been measured, and the failure it
produces — a tick that overruns its budget — is visible on `/health` rather than silent. An unset `AUTH_JWT_SECRET` generates one at boot, so every access token
becomes invalid on restart and everybody is signed out at once — which reads as a session bug
rather than as a missing variable. An empty `SMTP_HOST` disables password recovery, which is
supported and deliberate ([ADR 0011](docs/adr/0011-auth-local-accounts.md)) but should not be
silent. And `AUTH_COOKIE_SAMESITE=none` without `Secure` produces a cookie every browser discards,
so sign-in appears to work and the first refresh fails.

One more is a warning for a different reason — both readings are legitimate:
`CHAT_NEARBY_RADIUS_M` defaults to `MAX_AUDIBLE_DISTANCE_M` and should track it, since the Phase 5
rule is that local chat reaches the people you can talk to. Setting it differently is allowed and
logged at boot. Nothing can tell a deliberate divergence from an accidental one, so the server says
it happened and leaves the judgement to whoever set it.

One value is easy to get wrong and only fails under Compose: `LIVEKIT_URL` is how the **server**
reaches the SFU, and under Compose that is `ws://livekit:7880` — a name no browser can resolve.
`LIVEKIT_PUBLIC_URL` is what clients are told, and Compose sets it to the published port. They
default to the same value, which is correct everywhere the SFU has one address.

---

## What is not built yet

No multi-map spaces, no map editor, no interactive objects. Those are Phases 8–10, each with a
specification and implementation notes already written.

**There is still no way to remove a message once it has been sent.** Phase 7 gives moderators the
people; the words are untouched. Nothing in `FR-7.1`–`FR-7.20` asks for message deletion, and adding
it would mean deciding what happens to a persisted room history that other people have already read.

**A direct message still targets a session id.** The _storage_ moved to durable identity in Phase 6,
so a conversation between two accounts is one row set across any number of reconnects and unread
markers survive them. But addressing an account that is **offline** needs a presence directory,
which is `DC-8.5` in Phase 8; until then a thread you can open is a thread whose other end is here.

**A guest's direct conversation is still session-scoped**, and always will be. There is nothing
durable to key it on, which is inherent rather than deferred. The same is true of a guest's blocks.

**A guest ban is weak, and the interface says so where it is issued.** It keys on a browser
fingerprint and an address: clearing site data defeats it, another browser defeats it, and matching
on an address catches everybody behind the same office NAT. The Phase 7 Rules asked for "available
identifying signals, with known limitations documented" rather than a solution, and the real remedy
is one checkbox along — requiring accounts (`FR-6.8`). An **account** ban is exact.

**Capacity refuses; it does not shard.** `FR-7.14` allows either, and the Phase 7 Rules require the
choice to agree with `FR-8.8` rather than be made twice. There is one instance until Phase 8 builds
more, so refusing is the only one of the two this build can implement honestly.

**Moderators bypass lock, password, allowlist and capacity.** Deliberately: every one of those can be
switched on from inside the world, and without the exception an admin who locks a space and then
loses their connection has no way back in to unlock it. The ceiling is soft by the number of
moderators.

**The audit log is append-only against the application, not against a DBA.** A `REVOKE` stops this
process and any future endpoint that forgets; a trigger stops a superuser, which the grant cannot and
which the default Compose deployment happens to be. Somebody with a `psql` prompt can drop the
trigger, and that is the honest limit of "tamper-evident enough to be trusted" (`FR-7.20`).

Movement is **client-authoritative** — the Phase 1 Non-Goals explicitly permit a trusting model,
and taking it removes prediction reconciliation entirely. A tampered client can walk through
walls. It cannot escape server-side decisions: interest, zone occupancy and audience resolution
are all computed from the reported position on the server, so a client that lies about where it
is standing still cannot hear a private conversation it is not in. Phase 6 does not change this:
authentication binds a socket to an identity, it does not make the positions that socket reports
true. See [ADR 0004](docs/adr/0004-client-authoritative-movement-aoi.md).
