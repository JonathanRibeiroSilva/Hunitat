# Testing voice, video and audio range with a second person

`AC-2.1`–`AC-2.7`, `AC-3.2` and `AC-3.3` are the acceptance criteria with no automated
coverage — the harness asserts _who should hear whom_, but whether it actually sounds right is
verified by ear. That needs a second human, on a second machine, with a second microphone. Two
tabs on one box share a microphone and cannot produce real capture latency, echo or packet loss.

This describes how to get that second person connected.

---

## Why the SFU does not go through the tunnel

The instinct is to point ngrok at all three ports and be done. It does not work, for a reason
worth knowing before spending an evening on it.

LiveKit publishes ICE candidates as `node-ip:port`, and the browser dials exactly what it was
handed. A tunnel gives you `0.tcp.ngrok.io` on an arbitrary port — the SFU still advertises
`7881`, nothing rewrites the candidate, and the handshake never completes. Media itself is UDP
(`50000-50100` in [`docker-compose.yml`](../docker-compose.yml)) and HTTP tunnels do not carry UDP
at all. On top of that, the dev config ships `--node-ip 127.0.0.1` with `use_external_ip: false`,
so the only address the local SFU ever offers is loopback.

The signalling would tunnel fine. Only the audio would be missing — a room that connects, shows
both avatars, and is silent.

**The web app and the api are a different story.** Plain HTTP and WebSocket, they tunnel cleanly,
and the api is already prepared for it: it binds `0.0.0.0` and its CORS is `origin: true`
([`apps/api/src/main.ts`](../apps/api/src/main.ts)).

So: **one tunnel to the web port, and LiveKit Cloud for the media.** Its free tier terminates TLS
and runs TURN, which is precisely the part that cannot be tunnelled.

```
guest browser ──https──▶ ngrok ──▶ web :5173 ──proxy──▶ api :3000
      │
      └──────────────wss + WebRTC─────────────▶ LiveKit Cloud
```

## What the single origin buys

Everything the browser needs — the page, `/ws`, `/assets/world/` — comes from one host, and that
matters three times over:

- `getUserMedia` requires a secure context. Over plain `http://192.168.x.x` the guest's browser
  refuses microphone and camera access before any of this code runs. The tunnel's certificate is
  what removes that obstacle, and it is the main thing ngrok buys here.
- An `https://` page may not open a `ws://` socket. Two origins would mean solving that too.
- The public URL is not known ahead of time, and with same-origin the client does not need to
  know it — nothing has to be rebuilt when the tunnel domain changes.

That last point is why `VITE_API_URL` and `VITE_WS_URL` are set **empty** rather than to the
tunnel domain. Empty is not the same as absent: absent keeps the `localhost:3000` defaults, which
is what normal development wants.

---

## Setup

First, in both cases: create a project at <https://cloud.livekit.io>, then

```bash
cp .env.tunnel.example .env.tunnel   # fill in the three LIVEKIT_CLOUD_* values
ngrok config add-authtoken <token>   # once per machine
```

`.env.tunnel` is git-ignored. Its variables are named `LIVEKIT_CLOUD_*` and not `LIVEKIT_*` on
purpose — `.env` already defines `LIVEKIT_URL` as `ws://localhost:7880`, and a shared name would
let a value missing here fall through to the local one. The stack would start, look healthy, and
hand every remote guest an address on their own machine.

### Running the Compose stack

```bash
npm run tunnel:docker
ngrok http 5173
```

`tunnel:docker` layers [`docker-compose.tunnel.yml`](../docker-compose.tunnel.yml) over the base
file: it rebuilds `web` with empty `VITE_*` args, points the api at LiveKit Cloud, and drops the
local `livekit` service via an unused profile. Missing credentials stop it before anything starts.

`nginx` accepts any `Host`, so the tunnel domain needs no registration and **the URL can change
without rebuilding** — start and stop ngrok freely.

### Running the dev servers

```bash
npm run tunnel
```

One command for all three processes, in the order that matters: ngrok first, because Vite must
name the tunnel domain in `allowedHosts` or it answers `Blocked request`, and an ephemeral ngrok
URL does not exist until the agent has connected. The script reads the domain back from the
agent's local API and starts Vite with it. It also validates the LiveKit credentials by calling
`listRooms()` before anything else starts, so a wrong secret stops the run instead of surfacing
later as "we can see each other but nobody can hear anything".

Ports 3000 and 5173 must be free — if the Compose stack is up, `docker compose down` first.

### Either way

Send the guest the `https://` URL. They click through ngrok's warning page once, enter a name,
and they are in.

> The tunnel puts an app with **no authentication** on the public internet — guest identity is
> ephemeral until Phase 6, so the URL is the only thing standing between the world and whoever
> has it. Treat it as a secret and stop the agent when the test is over.

Free ngrok plans allow **one online endpoint**. An agent left running from an earlier session
takes the slot and the next one fails with `ERR_NGROK_334`.

---

## The script

Numbers below are the defaults in [`.env.example`](../.env.example); if you changed them, read
yours. Distances are easiest to judge against the world's grid rather than guessed.

| #   | Criterion | What to do                            | What should happen                                                                                     |
| --- | --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `AC-2.3`  | Both join, unmute, stand apart        | Audio connects on proximity alone — there is no call/accept step anywhere                              |
| 2   | `AC-2.1`  | Walk slowly together from ~15 m       | Silence until `MAX_AUDIBLE_DISTANCE_M=12`, then a smooth rise. Not a switch                            |
| 3   | `AC-2.1`  | Circle around them while they talk    | Voice pans to the side the avatar is on, and tracks continuously                                       |
| 4   | —         | Stand **exactly** at 12 m and shuffle | No flutter. `AUDIO_HYSTERESIS_M=2` means you go silent at 14 m, not 12 — the gap is the point          |
| 5   | `AC-2.2`  | Approach with camera on               | Video appears in range, disappears beyond it, no stuck last frame                                      |
| 6   | `AC-2.5`  | Mute mid-sentence                     | Outbound audio stops _and_ the speaking indicator clears at once                                       |
| 7   | `AC-2.6`  | Share a screen, then end it           | In-range participants see it; ending leaves no ghost tile                                              |
| 8   | `AC-3.2`  | Both into one private zone            | You hear each other fully and are silent to everyone outside                                           |
| 9   | `AC-3.3`  | One onto a spotlight, other far away  | Carries across the whole map, while the speaker still hears their locals                               |
| 10  | `AC-2.7`  | Walk repeatedly through a group       | No dropouts _for the bystanders_ — that is the renegotiation-churn test                                |
| 11  | `AC-2.4`  | Spread out past 30 m                  | Media stops flowing entirely; `AOI_ENTER_RADIUS_M=25` gates presence, and audible range sits inside it |

Rows 4 and 10 are the ones that find real bugs. Both are about hysteresis — an edge case that
looks fine in a two-tab test because neither tab ever sits still on a boundary.

Watch `GET /health` while you go: it reports participant count and observed tick duration, which
is the number that shows load before users do (`NFR-38`).

---

## If you would rather stay on the LAN

Same building, and you want direct media with lower latency and no cloud account. It is more
setup, not less:

1. `VITE_API_URL` / `VITE_WS_URL` and `LIVEKIT_PUBLIC_URL` all pointed at this machine's LAN IP.
2. `--node-ip <LAN IP>` in [`docker-compose.yml`](../docker-compose.yml), replacing `127.0.0.1`.
3. Windows Firewall opened for 5173, 3000, 7880, 7881 **and** UDP 50000-50100. Forgetting the UDP
   range is the classic failure: the room connects and stays silent.
4. The secure-context problem, which does not go away — the guest must allowlist the origin under
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, entering `http://<LAN IP>:5173`
   and restarting the browser. Phones are harder; iOS Safari has no such escape hatch.

Worth it if you are chasing a latency or audio-quality question, where a cloud SFU sits in the
measurement. For "does the falloff sound right", the tunnel is less work and the extra tens of
milliseconds change nothing you are listening for.
