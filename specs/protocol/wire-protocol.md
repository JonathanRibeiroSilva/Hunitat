# Protocol — Wire Format

**Status:** normative · **Applies to:** phases 1, 3, 4, 5, 6, 7, 10 · **Implemented by:** `packages/protocol`

The phase specs describe _what_ is replicated and never _how_. This document is the how: the
byte layout of every frame on the game WebSocket.

It exists because [ADR 0003](../../docs/adr/0003-transport-native-websocket.md) chose native
WebSocket over socket.io, which means the wire format is ours to define. Client, server and test
bots all encode and decode through the same implementation in `packages/protocol` — that shared
package is the only thing preventing silent disagreement about byte offsets.

Numeric conventions come from [coordinates-and-units.md](../conventions/coordinates-and-units.md);
timings and limits from [tuning-defaults.md](../conventions/tuning-defaults.md).

---

## Framing

One WebSocket message is one frame. **The first byte is the opcode.**

Opcodes below `0x80` carry a **binary** payload. Opcodes at or above `0x80` carry a **UTF-8 JSON**
payload. A receiver dispatches on the first byte and never has to guess.

All multi-byte integers are **little-endian** (native order on every platform this runs on;
`DataView` calls pass `littleEndian = true` explicitly).

```
┌────────┬─────────────────────────────┐
│ opcode │ payload                     │
│  u8    │ binary (<0x80) / JSON (≥0x80)│
└────────┴─────────────────────────────┘
```

A frame exceeding `MAX_MESSAGE_BYTES` (4096) is rejected before parsing and the connection is
closed with code `1009`. An unknown opcode is ignored and logged, never fatal — this is what
allows a newer client to send frames an older server does not know.

---

## Opcode table

### Client → server

| Op     | Name             | Payload        | Phase |
| ------ | ---------------- | -------------- | ----- |
| `0x01` | `TRANSFORM`      | binary, single | 1     |
| `0x80` | `JOIN`           | JSON           | 1     |
| `0x81` | `LEAVE`          | JSON           | 1     |
| `0x82` | `SET_STATUS`     | JSON           | 1, 4  |
| `0x83` | `EMOTE`          | JSON           | 4     |
| `0x84` | `CHAT_SEND`      | JSON           | 5     |
| `0x85` | `TYPING`         | JSON           | 5     |
| `0x86` | `SET_APPEARANCE` | JSON           | 4     |
| `0x87` | `CHAT_HISTORY`   | JSON           | 5     |
| `0x88` | `CHAT_READ`      | JSON           | 5     |
| `0x89` | `MODERATE`       | JSON           | 7     |
| `0x8A` | `BLOCK`          | JSON           | 7     |
| `0x8B` | `REPORT`         | JSON           | 7     |

### Server → client

| Op     | Name                  | Payload      | Phase   |
| ------ | --------------------- | ------------ | ------- |
| `0x02` | `TRANSFORM_BATCH`     | binary, many | 1       |
| `0x90` | `JOINED`              | JSON         | 1       |
| `0x91` | `SNAPSHOT`            | JSON         | 1       |
| `0x92` | `PARTICIPANT_ADD`     | JSON         | 1       |
| `0x93` | `PARTICIPANT_REMOVE`  | JSON         | 1       |
| `0x94` | `PARTICIPANT_UPDATE`  | JSON         | 1, 4    |
| `0x95` | `FORCE_TRANSFORM`     | JSON         | 1, 3, 7 |
| `0x96` | `ERROR`               | JSON         | 1       |
| `0x97` | `EMOTE_PLAY`          | JSON         | 4       |
| `0x98` | `CHAT_MESSAGE`        | JSON         | 5       |
| `0x99` | `TYPING_STATE`        | JSON         | 5       |
| `0x9A` | `AUDIENCE`            | JSON         | 2, 3    |
| `0x9B` | `ZONE_EVENT`          | JSON         | 3       |
| `0x9C` | `CHAT_HISTORY_RESULT` | JSON         | 5       |
| `0x9D` | `CHAT_REJECT`         | JSON         | 5       |
| `0x9E` | `IDENTITY`            | JSON         | 6, 7    |
| `0x9F` | `MODERATION_STATE`    | JSON         | 7       |

Opcodes are **stable**. New frames take new numbers; existing ones are never reassigned.

---

## Binary frames

### `0x01 TRANSFORM` — client → server

The hot path inbound. Sent at `CLIENT_SEND_RATE_HZ` (20).

```
offset size  field
  0     u8   opcode = 0x01
  1     i16  x        centimetres
  3     i16  y        centimetres
  5     i16  z        centimetres
  7     u8   yaw      0..255 → [0, 2π)
  8     u8   flags
              bit 0  grounded
              bit 1  running
              bit 2  jumping
              bit 3-7 reserved, must be 0
                                            total: 9 bytes
```

No participant id: the server knows who is sending. No timestamp: the server stamps on arrival,
and clocks are not assumed to agree
([coordinates-and-units.md](../conventions/coordinates-and-units.md#time)).

### `0x02 TRANSFORM_BATCH` — server → client

The hot path outbound. One frame per recipient per tick, containing **only that recipient's
current area-of-interest set** (`FR-1.16`).

```
offset size  field
  0     u8   opcode = 0x02
  1     u16  count
  3     ...  count × entry (10 bytes each)

entry:
  +0    u16  id       instance-local participant index
  +2    i16  x
  +4    i16  y
  +6    i16  z
  +8    u8   yaw
  +9    u8   flags    same bits as 0x01
```

10 bytes per participant against roughly 40 as JSON. With 50 participants averaging 10
neighbours at 20 Hz, that is ~100 KB/s server-wide instead of ~400 KB/s.

**The `id` is an instance-local `u16`, not the session UUID.** The mapping is delivered in
`SNAPSHOT` and `PARTICIPANT_ADD` and stays valid for the lifetime of the participant's presence
in that instance. Sending a 36-character UUID twenty times a second would cost more than the
transform itself.

Ids are **not reused** while an instance lives. A departed participant's index is retired, so a
late frame referencing it resolves to nobody rather than to a stranger.

### Quantization

```
encode:  round(metres × 100)  clamped to [-32768, 32767]
decode:  value / 100

encode:  round(yaw_rad / (2π) × 256) & 0xFF
decode:  value × (2π / 256)
```

Resolution 1 cm and ~1.4°. Range ±327.67 m per axis — a hard limit on world size, which the Map
Document validator enforces.

**Clamping is silent on encode.** A client reporting a position outside bounds has already
failed collision; the clamp keeps the frame well-formed rather than propagating a bad value.

---

## JSON frames

Payload is UTF-8 JSON from byte 1 onward. Every schema is defined with Zod in
`packages/protocol` and validated on receipt; a payload failing validation produces `ERROR` and
is discarded.

### Client → server

**`0x80 JOIN`** — the first frame after the socket opens. No other frame is accepted before it.

```jsonc
{
  "displayName": "Ana", // optional; generated if absent (FR-1.2)
  "resumeToken": "…", // optional; reconnection (FR-1.5)
  "worldId": "default",
  "appearance": {…}, // optional (FR-4.8); ignored for an account, whose profile wins
  "accessToken": "…", // optional (phase 6, FR-6.18)
  "spacePassword": "…",     // optional (phase 7, FR-7.12)
  "clientFingerprint": "…", // optional (phase 7, FR-7.8) — guest bans only
}
```

`accessToken` rides on `JOIN` rather than on the HTTP upgrade, and that is a choice rather than a
convenience. The browser `WebSocket` constructor cannot set an `Authorization` header, which leaves
a query parameter as the only header-free alternative — and a query parameter lands in every access
log and proxy trace between here and the server. A token in the first frame is written to nothing.

It is resolved to an identity **before the connection joins a world** (`FR-6.18`), so a participant
exists as an account from its first frame rather than being corrected afterwards. Three outcomes:

| Presented                     | Space allows guests | Result                                                         |
| ----------------------------- | ------------------- | -------------------------------------------------------------- |
| a token that resolves         | either              | joins as that account, wearing its profile (`FR-6.9`)          |
| nothing                       | yes                 | joins as a guest — the phase 1 path, unchanged (`FR-6.6`)      |
| nothing                       | no                  | `ERROR guests-not-allowed`, fatal (`FR-6.8`, `AC-6.5`)         |
| a token that does not resolve | either              | `ERROR auth-required`, fatal — **never** downgraded to a guest |

From phase 7 the identity is only half the question. Once it is settled, the join is evaluated
against the Space's **access policy** (`FR-7.8`, `FR-7.11`–`FR-7.14`) and may be refused with
`banned`, `space-locked`, `password-required`, `password-incorrect`, `not-allowlisted` or
`world-full`. Each is its own code because the recovery differs entirely: type a password, wait, ask
an admin, or accept the answer.

That evaluation runs on the **resume path too**. A banned identity presenting a valid resume token is
refused; a ban checked only on fresh joins lasts until its target's client reconnects. Capacity is
the one check a resume skips, because the participant is already counted and refusing them would
evict somebody for a dropped packet.

`spacePassword` travels here rather than on an HTTP call because it gates entry to the world and this
is the frame that enters it — a check passed over REST and a join that skipped it would be two doors
into one room. `clientFingerprint` is a stable per-browser value used for **nothing but guest ban
matching**; it is not an identity, nothing reads it to decide who somebody is, and it is never
published.

The last row is the rule worth stating twice. Silently continuing as somebody else is the failure
with no symptom: the person keeps walking around, and their profile edits, direct messages and
membership all land on an identity that evaporates when they close the tab. The client's correct
response to `auth-required` is to refresh its token and retry, which is what makes a fifteen-minute
access token survivable across a reconnect.

**`0x81 LEAVE`** — voluntary departure (`FR-1.4`). `{}`. Closing the socket is equivalent but
slower, since it waits for the stale-session sweep.

**`0x82 SET_STATUS`** — `{ "status": "available" | "away" | "do-not-disturb" }` (`FR-4.11`).
`idle` is server-derived and cannot be set (`FR-1.22`).

**`0x83 EMOTE`** — `{ "emote": "wave" }`. Server-throttled to `EMOTE_MIN_INTERVAL_MS`
(`FR-4.16`); excess is dropped silently, not errored. The id is a free string rather than an enum,
so an emote a build does not recognise is ignored under the versioning rule below rather than
answered with `bad-frame`.

**`0x86 SET_APPEARANCE`** — `{ "appearance": { "baseModel": "…", "colors": {…}, "accessories": […] } }`
(`FR-4.5`, `FR-4.7`). The **whole** appearance, never a patch: a patch would require the sender and
the server to agree on the current value, and they demonstrably do not while a previous change is
still in flight. Colours are palette **indices**, not free-form values — bounded by construction,
and a client cannot publish an invisible avatar. Takes effect without leaving the world; no respawn
is issued.

**`0x84 CHAT_SEND`** — `{ "scope": "room"|"nearby"|"zone"|"direct", "body": "…", "targetId": "…"?,
"tempId": "…"? }`. Recipients are resolved **server-side** via `resolveAudience()`, which is what
keeps chat reach identical to media reach (Phase 5 rules).

`targetId` carries two things depending on scope — the recipient's **session id** for `direct`,
the **zone id** for `zone`, unused otherwise. One overloaded field rather than three of which two
are always null.

`tempId` is the sender's own id for the message it has already drawn optimistically. It comes back
on the server's echo so the client reconciles rather than duplicating, and on `CHAT_REJECT` so a
failure marks the right message (`FR-5.8`).

The client never sends a channel id. A direct channel is named from the _reader's_ side, so a
client-supplied one would have to be rewritten by the server for every recipient anyway.

**`0x85 TYPING`** — `{ "scope": "…", "typing": true, "targetId": "…"? }`. Never persisted, at any
layer. The server holds no typing state at all: it resolves recipients exactly as it would for a
message and forwards.

**`0x87 CHAT_HISTORY`** — `{ "channelId": "room", "beforeSeq": 412?, "limit": 50? }` (`FR-5.12`).
A request rather than an unsolicited push, because the direct channels a participant _might_ open
are one per person in the world. Paging is by `seq`, not by offset: the channel is still receiving
while somebody scrolls, and an offset would slide.

**`0x88 CHAT_READ`** — `{ "channelId": "room", "seq": 412 }` (`FR-5.16`). Moves the last-seen
marker, monotonically — a lower value never moves it backwards, so an out-of-order frame cannot
resurrect messages somebody has already read.

**`0x89 MODERATE`** (Phase 7) — one act on one live participant.

```jsonc
{ "action": "mute" | "unmute" | "disable-video" | "enable-video"
          | "kick" | "ban" | "respawn",
  "targetSessionId": "uuid",
  "reason": "…",            // optional; shown to the target and audited
  "durationMinutes": 1440,  // optional, `ban` only; absent means permanent
}
```

**This frame is what `NFR-34` is about.** Guarding the HTTP controllers is routine; the socket carries
this too, and an unguarded handler here is a complete bypass of every role check in the product. The
server asks the same `CAPABILITIES` matrix both transports share, plus a **strict** rank comparison —
so an admin cannot moderate another admin or the owner, and nobody can moderate themselves.

A refused action answers `ERROR forbidden`, non-fatal, always. `FR-7.4` requires attempts to be
_refused_, and a moderation button that silently does nothing is indistinguishable from one that
worked.

The durable half of moderation — roles, bans against people who are offline, access policy, the audit
log — is HTTP ([http-api.md](http-api.md)), because none of it addresses a session.

**`0x8A BLOCK`** (Phase 7) — `{ "targetSessionId": "uuid", "blocked": true }` (`FR-7.16`,
`FR-7.18`). Its own frame rather than a `MODERATE` action: it needs no capability beyond being
present, it affects nobody but the two people involved, and it belongs in nobody's audit log.

Enforced inside `resolveAudience()` and symmetric — the blocked party stops reaching the blocker as
well as the reverse. Both remain **visible in presence**: the Rules require a block not to falsely
imply the blocker is offline. A direct message between the two is accepted, delivered to nobody and
never stored; a refusal that only happened for blocked senders would itself be the disclosure.

**`0x8B REPORT`** (Phase 7) — `{ "targetSessionId": "uuid", "reason": "…"? }` (`FR-7.17`). Carries
only who and why. The **where** — map, position and zone occupancy — is captured on the server at the
moment of filing, because a client-supplied location is a fact about the accused supplied by the
accuser.

### Channel ids

One string names a channel on the wire, in the history store, in `read_state` and in the client's
unread map, so the four cannot drift:

| Scope  | Channel id               | Persistent |
| ------ | ------------------------ | ---------- |
| room   | `room`                   | yes        |
| nearby | `nearby`                 | no         |
| zone   | `zone:<zoneId>`          | no         |
| direct | `direct:<peerSessionId>` | yes        |

**A direct channel is named from the reader's point of view**, and asymmetrically on purpose: Ana's
thread with Bea is `direct:<bea>` and Bea's is `direct:<ana>`, so the server addresses each copy of
a message to the channel its recipient will look for it in. Storage uses the opposite convention —
`dm:<a>|<b>` with the ids sorted — because there both sides must read one row set or each would
scroll back through only their own half of the conversation.

### Server → client

**`0x90 JOINED`** — the reply to `JOIN`.

```jsonc
{
  "sessionId": "uuid",
  "localId": 7,                    // this participant's u16 index
  "displayName": "Ana",            // possibly generated
  "resumeToken": "…",              // for FR-1.5
  "resumeTokenTtlMs": 60000,
  "spawn": { "x": 0, "y": 0, "z": 0, "yaw": 0 },
  "mapUrl": "/assets/world/office.glb",
  "mapDocumentUrl": "/assets/world/office.map.json",
  "avatarModelUrl": "/assets/avatars/avatar.glb",   // phase 4
  "appearance": { "baseModel": "standard", "colors": {…}, "accessories": [] },
  "chatChannels": [ /* phase 5 — see PARTICIPANT_UPDATE below */ ],
  "tuning": { "tickRateHz": 20, "aoiEnterRadiusM": 25, "…": "…" }
}
```

Tuning values are pushed at join so the client never hard-codes what the server owns. So is
`avatarModelUrl`, for the same reason `mapUrl` is: the server owns asset locations, and Phase 9
moves them to object storage on another origin.

`appearance` is what the participant was actually given, which is not necessarily what `JOIN`
offered — a guest who offers none is issued a distinct one derived from their local id, so a room
of people who never opened a customizer is still a room of distinguishable people. From phase 6 an
**account's profile wins over whatever the client offered** (`FR-6.9`), so a stale copy remembered by
one browser cannot overwrite what its owner set from another device.

`JOINED` also carries `identity`, in the same shape as the `IDENTITY` frame below. From phase 7 that
shape includes `role` and `capabilities` (`FR-7.2`) — the role for display, the capability list to act
on. Both are derived from the one matrix in `packages/protocol`, so a client cannot hold a second
opinion about what an admin may do, and every action they enable is re-checked on the server.
Stated rather
than left for the client to infer from whether it sent a token, because the two can disagree: a
token that expired between the last refresh and this handshake is refused, and a client that assumed
success would render an account session on top of a guest one.

**`0x91 SNAPSHOT`** — the current area-of-interest set, sent immediately after `JOINED`. This is
`FR-1.15`: a joiner sees who is already present, not only who moves next.

```jsonc
{
  "participants": [
    { "id": 3, "sessionId": "uuid", "displayName": "Bea",
      "status": "available", "activity": "active",
      "appearance": { "baseModel": "slim", "colors": {…}, "accessories": ["cap"] },
      "identity": { "kind": "account", "member": true },
      "transform": { "x": 1.2, "y": 0, "z": -4.0, "yaw": 1.57 } }
  ]
}
```

Phase 7 adds three fields to the same shape:

- **`role`** (`FR-7.1`) — `guest` · `member` · `admin` · `owner`, so a presence list can say who
  moderates. It is not a permission: nothing a client does with it is trusted.
- **`moderation`** (`FR-7.5`, `FR-7.6`) — `{ micMuted, cameraDisabled }`, so a room where one person
  has gone quiet can tell "muted by a moderator" from "microphone broken". No actor, no reason.
- **`blocked`** (`FR-7.16`) — the one field on a participant frame that describes **the recipient**
  rather than the participant. It is safe here because `SNAPSHOT` and `PARTICIPANT_ADD` are already
  addressed per connection; a block applied afterwards is announced with a `PARTICIPANT_UPDATE` sent
  only to the blocker, and the blocked party is told nothing.

`identity` (phase 6) is `FR-6.13` — "the system distinguishes members from guests". Two fields
rather than one enum, because they answer different questions and a combined value would collapse a
real state: `kind` is whether the identity is durable (`FR-6.11`), `member` is whether it belongs to
this Space (`DC-6.4`). A signed-in account that has never redeemed an invite is `account` and not a
member — a legitimate visitor who happens to own their name.

It deliberately carries **no account id**. A presence list needs to say "guest" beside a name; it
has no use for a stable cross-session handle for a stranger, and publishing one to everybody in
range is not something this phase asks for. The connection's _own_ identity, which does name an
account, travels on `JOINED` and `IDENTITY` instead.

**`0x92 PARTICIPANT_ADD`** — someone entered the area of interest (`FR-1.17`). Same shape as one
snapshot entry.

**`0x93 PARTICIPANT_REMOVE`** — `{ "id": 3, "reason": "left" | "out-of-range" | "timeout" | "kicked"
| "banned" }`. The reason matters: `out-of-range` means drop the remote representation but keep them
in the presence count; `left` means they are gone. `kicked` and `banned` are distinct because one of
them can be undone by walking back in (`FR-7.7`).

**`0x94 PARTICIPANT_UPDATE`** — low-frequency field changes: display name, status, activity, from
Phase 4 avatar appearance, from Phase 5 the available chat channels, from Phase 6 `identity` when a
guest becomes an account without going anywhere, and from Phase 7 `role`, `moderation` and `blocked`.
Never transforms.

Sent to every observer whose area of interest holds the participant, **plus the participant
themself**. Self is not incidental: an observer is never in their own interest set, so a change
routed through interest alone would be invisible to the one person who made it — and in third
person they are looking straight at the avatar it applies to.

Carrying appearance here is only half of `FR-4.6`. The other half is that it also rides on
`SNAPSHOT` and `PARTICIPANT_ADD`, which is what makes someone walking up after a change see the
current look rather than the default until the next one.

`chatChannels` (Phase 5, `FR-5.5`) and `blocked` (Phase 7, `FR-7.16`) are the fields on this frame
sent **only to the participant they describe**. The set names the chat-enabled zone somebody is standing in, and broadcasting that to
observers would publish a position the area of interest exists to keep private — the same
restriction, for the same reason, as `ZONE_EVENT`. It is seeded on `JOINED` and revised on every
chat-enabled zone crossing.

```jsonc
{
  "id": 7,
  "chatChannels": [
    { "id": "room", "scope": "room", "label": "Room", "persistent": true },
    {
      "id": "nearby",
      "scope": "nearby",
      "label": "Nearby",
      "persistent": false,
    },
    {
      "id": "zone:west-corridor",
      "scope": "zone",
      "label": "West Corridor",
      "persistent": false,
      "zoneId": "west-corridor",
    },
  ],
}
```

Direct channels are deliberately absent from this list. The advertised set describes the
participant's _situation_; a direct channel exists the moment either side decides to use it, and
the client opens one from the presence list or from the first message that arrives.

**`0x98 CHAT_MESSAGE`** (Phase 5) — one delivered message (`DC-5.2`).

```jsonc
{ "id": "uuid", "channelId": "nearby", "scope": "nearby", "seq": 412,
  "senderId": 7, "senderSessionId": "uuid", "senderName": "Ana",
  "body": "over here", "at": 1733…,
  "mentions": [ { "id": 9, "sessionId": "uuid", "name": "Bea" } ],
  "tempId": "t3-7" }
```

Addressed **per recipient**, not broadcast verbatim: `channelId` for a direct message names the
_other_ party, and `mentions` carries only recipients eligible for this copy. `tempId` appears
solely on the sender's own copy.

`seq` is the server's ordering (`FR-5.7`) and `at` is the server's clock. A client timestamp is
never on the wire — clocks are not assumed to agree, and ordering by one would let a skewed machine
post into last Tuesday. Persistent channels take `seq` from `messages.seq` (`BIGSERIAL`); ephemeral
ones from an in-memory counter per channel. **Clients must not assume `seq` starts at 1 or is
contiguous** — only that it increases with delivery order within a channel.

**`0x99 TYPING_STATE`** (Phase 5) — `{ "channelId": "nearby", "scope": "nearby", "id": 7,
"sessionId": "uuid", "displayName": "Ana", "typing": true, "expiresInMs": 5000 }` (`FR-5.10`).

`expiresInMs` is carried rather than left to the client's own constant, because the indicator has
to clear even when the "stopped" frame is lost — which is what happens when somebody closes the tab
mid-sentence, and a client timing it from a stale copy leaves them shown as typing forever.

**`0x9C CHAT_HISTORY_RESULT`** (Phase 5) — the reply to `CHAT_HISTORY`.

```jsonc
{
  "channelId": "room",
  "scope": "room",
  "messages": [/* oldest first */],
  "complete": false,
  "lastReadSeq": 380,
}
```

`complete` means the page reached the oldest message still _retained_, which is not the same as the
beginning of the conversation. An **ephemeral** channel answers with an empty list and
`complete: true` — the channel exists, it simply remembers nothing (`AC-5.4`), and that is a
different answer from an error.

**`0x9D CHAT_REJECT`** (Phase 5) — `{ "tempId": "t3-7", "code": "rate-limited", "message": "…" }`.
Codes: `rate-limited`, `channel-unavailable` (that scope is not available where the sender is
standing), `recipient-gone` (a direct message to somebody who has left), `bad-frame`.

Its own frame rather than an `ERROR` code because it must name the `tempId` it refers to. The
sender has an optimistic message on screen; a generic error cannot say _which_ one failed, and a
message left looking sent that nobody received is the outcome `FR-5.8` exists to prevent.

**`0x97 EMOTE_PLAY`** (Phase 4) — `{ "id": 7, "emote": "wave", "durationMs": 2200 }`. Broadcast on
the same rule as `PARTICIPANT_UPDATE`: everyone who can see the emoter, and the emoter. The
duration is the server's word, already clamped to `EMOTE_MAX_DURATION_MS` — `FR-4.16`'s time bound
is a guarantee, and fifteen clients each deciding when the dance stops is fifteen chances to
disagree.

**`0x95 FORCE_TRANSFORM`** — the server overriding client authority.

```jsonc
{ "transform": { "x": 0, "y": 0, "z": 0, "yaw": 0 },
  "reason": "spawn" | "portal" | "moderation" }
```

The one place the server outranks the client on position
([ADR 0004](../../docs/adr/0004-client-authoritative-movement-aoi.md)). Serves `FR-3.14`
portals and `FR-7.9` moderator respawn. The client must apply it immediately and reset its
prediction state.

**`0x96 ERROR`** — `{ "code": "…", "message": "…", "fatal": false }`. Codes: `bad-frame`,
`not-joined`, `rate-limited`, `invalid-resume`, `portal-unresolved` (phase 3 — the destination did not
resolve, so the participant stayed put), two from phase 6:

- `guests-not-allowed` — this Space requires an account (`FR-6.8`). The Rules require it to arrive
  with a clear message **and an invite path**, never as a generic denial, which is why it is its own
  code: a client cannot offer "sign in, or open your invite" in response to a merged one.
- `auth-required` — a token was presented and did not resolve. Distinct from the above because the
  recovery differs: refresh and retry, rather than find another way in.

and six from phase 7, five of which refuse a join and one of which refuses an action:

| Code                 | Requirement | Fatal | What the client should do                          |
| -------------------- | ----------- | :---: | -------------------------------------------------- |
| `banned`             | `FR-7.8`    |  yes  | Nothing. The message says when it ends, if it does |
| `space-locked`       | `FR-7.11`   |  yes  | Offer a retry — a lock is lifted                   |
| `password-required`  | `FR-7.12`   |  yes  | Ask for the Space password and retry               |
| `password-incorrect` | `FR-7.12`   |  yes  | Say so, and ask again. A retry sends the same one  |
| `not-allowlisted`    | `FR-7.13`   |  yes  | Nothing. Ask whoever runs the Space                |
| `world-full`         | `FR-7.14`   |  yes  | Offer a retry — a full space empties               |
| `forbidden`          | `FR-7.4`    |  no   | Show the message. The connection is fine           |

`AC-7.4` requires "a clear reason", and these are separate codes because a merged one would leave a
client unable to offer the right next step — and the next steps have nothing in common.

**`0x9E IDENTITY`** (Phase 6) — who the server now believes this connection is.

```jsonc
{
  "kind": "account",
  "accountId": "…", // present only for an account
  "member": true, // of this world instance's Space (DC-6.4)
  "displayName": "Ana Lima",
  "appearance": {…},
}
```

Sent **only to the connection it describes** — it names an account id, which is a durable handle for
a person and belongs to nobody else. What observers get instead is the `identity` field on
`PARTICIPANT_ADD` / `SNAPSHOT` / `PARTICIPANT_UPDATE`, which says `guest` or `member` and stops.

Sent unprompted, and only when the answer **changes** mid-connection, which happens exactly once: a
guest upgrades to an account over HTTP while their socket stays open (`FR-6.7`). `JOINED` already
carries the same shape for the identity a connection starts with, so this is not a duplicate of it —
it is the one thing `JOINED` cannot express, because `JOINED` has already been sent.

Its own frame rather than a field on `PARTICIPANT_UPDATE`, for the reason `chatChannels` is
restricted there: a field that is only ever valid for self, on a frame that is usually about
others, is a leak waiting for a refactor.

**`0x9F MODERATION_STATE`** (Phase 7) — what a moderated participant is told about themself.

```jsonc
{ "micMuted": true, "cameraDisabled": false,
  "byName": "Ana",              // absent when a permission is being restored
  "reason": "Please use the stage.",
  "at": 1733… }
```

Sent **only to the connection it describes**, and re-sent after a resume so a client that reconnected
still knows why its microphone will not turn on. `at` is stamped once, so a client can tell a state it
has already announced from a new one — a "you were muted" notice that fired again on every reconnect
would read as a moderator doing it twice.

What observers get instead is the `moderation` field on `PARTICIPANT_ADD` / `SNAPSHOT` /
`PARTICIPANT_UPDATE`, which says _that_ somebody is muted and stops. Publishing a moderator's name and
their reason to the room would turn every mute into an announcement. Same restriction, and the same
reasoning, as `IDENTITY` and `chatChannels`.

**`0x9A AUDIENCE`** (Phase 2) — the server's decision about who this participant may hear and
see, with per-target gain. The client applies it to LiveKit subscriptions and Web Audio.
Computed server-side because zone rules and blocks are not the client's to decide.

Shape, as shipped in phase 3:
`{ "targets": [ { "id": 7, "gain": 0.82, "reason": "proximity" } ] }` — `reason` is one of
`proximity`, `private-zone`, `spotlight`. The **complete** set each time, not a diff, and sent
only when it changes. A self-describing set cannot drift out of step after a dropped frame the
way an accumulated sequence of diffs can. Phase 3 computes and ships it; phase 2 is what makes
it audible, which is why the zone precedence rules are observable before any media exists.

**`0x9B ZONE_EVENT`** (Phase 3) — `{ "id": 7, "zoneId": "huddle-a", "zoneType": "private",
"kind": "enter", "key": "…", "at": 1733… }`. A participant's **own** zone transitions only:
broadcasting everyone's would leak the position of people outside the area of interest, which
is the leak AOI exists to prevent. `FR-3.17` is about other systems consuming enter/exit and
the server-side bus is that deliverable — this frame is one subscriber, present so the client
can tell someone their audio just became private, and so `AC-3.5` is observable from outside
the process.

---

## Connection lifecycle

```
open
  │
  ├─▶ client sends JOIN (0x80)          within WS_HANDSHAKE_TIMEOUT_MS or dropped
  │
  ◀── server sends JOINED (0x90)
  ◀── server sends SNAPSHOT (0x91)
  │
  ├─▶ TRANSFORM (0x01) @ 20 Hz ────────┐
  ◀── TRANSFORM_BATCH (0x02) @ 20 Hz ──┘   steady state
  ◀── PARTICIPANT_ADD / REMOVE / UPDATE
  │
  ├─▶ LEAVE (0x81)  or  socket closes
```

### Heartbeat

Native WebSocket **ping/pong** frames, not application messages. The server pings every
`PING_INTERVAL_MS` (15 s) and marks the connection alive on pong. A connection that misses two
consecutive pings is terminated and its participant reaped — this is `FR-1.6`, and it is why
`STALE_SESSION_TIMEOUT_MS` must exceed twice the ping interval.

### Reconnection and resume — `FR-1.5`

`JOINED` carries a `resumeToken` valid for `RESUME_TOKEN_TTL_MS` (60 s).

On disconnect, the client reconnects with exponential backoff (500 ms, doubling, capped at 10 s,
±20% jitter) and presents the token in `JOIN`.

The server then:

1. Finds the retained session, if still within TTL.
2. **Rebinds the existing participant to the new socket** rather than creating a second one.
   This is the Phase 1 rule that reconnect must not duplicate a participant.
3. Restores the last known transform and issues a fresh `SNAPSHOT`.
4. Issues a **new** resume token; the old one is consumed.

An expired or unknown token is not an error — the client is joined as a new participant, and
`JOINED` simply carries a different `sessionId`.

**Retained sessions are invisible to everyone else.** During the retention window the
participant is removed from other clients' views. Keeping a ghost avatar standing there for up
to a minute would violate `FR-1.4`'s promptness; the trade is that a reconnecting user
re-appears rather than never having left.

### Backpressure

Before sending a `TRANSFORM_BATCH`, the server checks `socket.bufferedAmount`. Above
`MAX_BUFFERED_BYTES` (64 KB) **the frame is skipped**, not queued.

This replaces socket.io's `volatile emit` and is correct for this data: a stale position has no
value once a newer one exists. JSON event frames are never skipped — those are reliable.

---

## Security limits

Enforced from Phase 1, which had no authentication at all, because the transport is binary and the
movement model is trusting. Phase 6 adds an identity to the handshake and changes none of it: a
token says who is connected, not that what they report is true. Phase 7 adds authorization to three
frames and changes none of it either — a role says what somebody may ask for, not that the position
they report is real (`NFR-35`).

| Limit                | Value                            | Behaviour on breach                        |
| -------------------- | -------------------------------- | ------------------------------------------ |
| Frame size           | `MAX_MESSAGE_BYTES` (4096)       | close `1009`                               |
| Inbound rate         | `MAX_INBOUND_MSGS_PER_SEC` (60)  | `ERROR rate-limited`, then close on repeat |
| Frames before `JOIN` | 1 (`JOIN` only)                  | `ERROR not-joined`                         |
| Handshake delay      | `WS_HANDSHAKE_TIMEOUT_MS` (10 s) | close                                      |
| Display name         | `MAX_DISPLAY_NAME_CHARS` (32)    | truncate                                   |
| Access token         | 4096 bytes                       | `ERROR bad-frame`, close                   |
| Space password       | 200 characters                   | `ERROR bad-frame`                          |
| Ban duration         | 10 years                         | `ERROR bad-frame`                          |
| Report reason        | 1000 characters                  | `ERROR bad-frame`                          |
| Chat body            | `CHAT_MAX_MESSAGE_CHARS` (2000)  | `ERROR bad-frame`                          |
| Chat rate            | `CHAT_RATE_LIMIT_PER_MIN` (30)   | `CHAT_REJECT rate-limited`                 |

The chat rate limit is separate from the inbound frame rate on purpose: 60 frames a second is a
fine transform rate and an intolerable chat rate. It is tracked per **participant**, not per
connection — a resume rebinds the socket and keeps the person, so a per-connection window would
hand a flooder a clean slate for the cost of a reload.

Binary frames are validated on **length before offset**: a truncated `TRANSFORM_BATCH` must be
rejected, never read past its end. Every JSON payload passes its Zod schema before use.

---

## Versioning

The client offers a protocol version in the WebSocket subprotocol header (`hubitat.v1`). A client
that offers a _different_ subprotocol is closed immediately with code `1002` and a reason naming
the expected version — better than failing later as a mysterious decode error. A client that
offers none is accepted; refusing those would break trivial tooling for no gain.

Within a major version:

- New opcodes may be added; unknown opcodes are ignored.
- New **optional** JSON fields may be added; unknown fields are ignored.
- Binary layouts are **never** changed in place. A changed layout gets a new opcode.

---

## Related

- [http-api.md](http-api.md) — the REST surface accounts and invites need, and where the access
  token in `JOIN` comes from
- [coordinates-and-units.md](../conventions/coordinates-and-units.md) — quantization and axes
- [tuning-defaults.md](../conventions/tuning-defaults.md) — every constant named here
- [map-document.md](map-document.md) — what `mapDocumentUrl` returns
- [ADR 0003](../../docs/adr/0003-transport-native-websocket.md) · [ADR 0004](../../docs/adr/0004-client-authoritative-movement-aoi.md)
