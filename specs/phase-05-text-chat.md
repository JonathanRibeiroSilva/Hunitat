# Phase 5 — Text Chat & Messaging

## Overview

**Goal.** Let participants communicate in text across several scopes: the whole room,
just the people nearby, a specific zone, and one-to-one direct messages.

**Value.** Text complements spatial voice: it works when muted, supports links and async
catch-up, and reaches people you can't (or don't want to) talk to by voice.

**Depends on.** Phase 1 (participants, presence), Phase 3 (proximity & zone scoping for
"nearby" and "zone" channels).

**Delivers.** A chat interface where a participant can message the room, only nearby people,
their current zone, or a specific person; see typing indicators; and (optionally) read recent
history.

---

## In scope

- Channel scopes: room/global, nearby/local, zone, and direct (1:1).
- Sending, receiving, ordering, and delivery of messages.
- Typing indicators.
- Configurable message history (persistent vs. ephemeral).
- Mentions, basic formatting, and links.
- Unread indicators.

## Out of scope

- Moderation of chat (mute, delete, report) — Phase 7.
- Rich embeds / link previews beyond a clickable link.
- File attachments (revisit with the asset pipeline, Phase 9, if desired).

---

## Functional Requirements

### Channels & scoping

- **FR-5.1** A participant can send a message to the **room** channel, received by all
  participants in the world instance.
- **FR-5.2** A participant can send a **nearby/local** message, received only by participants
  currently within a configurable proximity range (consistent with Phase 2/3 proximity).
- **FR-5.3** A participant can send a **zone** message, received by participants currently in
  the same zone (using Phase 3 zone membership), where the map defines chat-enabled zones.
- **FR-5.4** A participant can send a **direct** message to one specific other participant.
- **FR-5.5** The current set of available channels reflects the participant's situation (e.g.,
  the zone channel appears only while in a chat-enabled zone).

### Sending & receiving

- **FR-5.6** Messages are delivered to all eligible recipients in near-real-time.
- **FR-5.7** Messages display sender display name and a timestamp, and preserve send order
  within a channel.
- **FR-5.8** The sender sees their own message reflected immediately (optimistic) and a clear
  indication if delivery fails.
- **FR-5.9** Recipients are determined at send time for proximity/zone channels (walking away
  afterward does not retract an already-delivered message).

### Typing & presence

- **FR-5.10** A participant can see a typing indicator for others composing in a channel they
  share, which clears when sending stops.

### History & persistence

- **FR-5.11** Whether a channel's history persists is configurable. Room and direct channels
  may retain recent history; proximity/zone channels may be ephemeral by default.
- **FR-5.12** When history persists, a participant can scroll back to recent messages on
  joining/opening the channel, up to a configured limit.
- **FR-5.13** When a channel is ephemeral, messages are not stored beyond live delivery.

### Content features

- **FR-5.14** Messages support basic formatting (at least line breaks and simple emphasis) and
  render URLs as clickable links.
- **FR-5.15** A participant can mention another participant; the mentioned participant receives a
  distinct notification/highlight.
- **FR-5.16** Unread indicators show which channels have new messages since the participant last
  viewed them.

---

## Data Concepts

- **DC-5.1 Channel** — scope (room | nearby | zone | direct), its membership rule, and whether it
  persists.
- **DC-5.2 Message** — sender, channel, content, timestamp, mentions; recipients resolved per scope.
- **DC-5.3 Typing State** — per participant per channel, transient.
- **DC-5.4 Read State** — per participant, last-seen marker per channel for unread tracking.

---

## Rules & Edge Cases

- Direct messages require both participants to be identifiable; for guests this lasts only as long
  as the session (durable DMs depend on accounts, Phase 6).
- Proximity/zone recipient resolution must match the same ranges/zones used by media so behavior
  is consistent ("people I can talk to" ≈ "people my local chat reaches").
- Message ordering must be stable per channel even under concurrent sends.
- Mentions must not leak a message to someone outside the channel's scope (mention highlights only
  apply to eligible recipients).
- History limits and retention must be configurable without code changes.

---

## Acceptance Criteria

- **AC-5.1** A room message reaches everyone in the instance; a nearby message reaches only those
  in range; a zone message reaches only co-occupants of that zone; a direct message reaches only
  the target.
- **AC-5.2** Messages show sender and time, arrive in order, and appear to the sender instantly.
- **AC-5.3** Typing indicators appear and clear correctly for shared channels.
- **AC-5.4** A persistent channel shows recent history on open; an ephemeral channel shows none after
  the fact.
- **AC-5.5** URLs are clickable; a mention highlights and notifies the mentioned participant.
- **AC-5.6** Unread indicators accurately reflect new activity per channel.

---

## Non-Goals & Deferred

- Chat moderation/deletion/reporting (Phase 7).
- File attachments and rich embeds (later, with the asset pipeline if pursued).
- Durable per-user message history across sessions depends on accounts (Phase 6); until then,
  history is per-session/instance.
- **Deferred decisions:** message storage and delivery mechanisms are chosen later; this spec
  fixes scoping and behavior only.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The rule that drives the design

From the Rules section above:

> Proximity/zone recipient resolution must match the same ranges/zones used by media so behavior
> is consistent ("people I can talk to" ≈ "people my local chat reaches").

The only reliable way to satisfy that is to **not write a second implementation**. `nearby` and
`zone` recipients are resolved by calling the same `resolveAudience()` in `world-core` that
Phase 2 uses for media and Phase 3 extended with zones. Consistency then holds by construction
rather than by two pieces of code being kept in step.

`CHAT_NEARBY_RADIUS_M` defaults to `MAX_AUDIBLE_DISTANCE_M` and should track it. Diverging them
deliberately is allowed; diverging them by accident is the bug this rule exists to prevent.

### Requirement mapping

| Requirement         | Implementation                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-5.1`            | `room` → every participant in the instance, from the in-memory registry                                                                                                                                           |
| `FR-5.2`            | `nearby` → `resolveAudience()` at `CHAT_NEARBY_RADIUS_M`                                                                                                                                                          |
| `FR-5.3`            | `zone` → current zone occupancy from the Phase 3 tick, where the zone is chat-enabled                                                                                                                             |
| `FR-5.4`            | `direct` → a single target by session or account id                                                                                                                                                               |
| `FR-5.5`            | The server advertises available channels in `PARTICIPANT_UPDATE` — **to that participant only**, since the set names the zone they are standing in — seeded on `JOINED` and revised off the `FR-3.17` zone stream |
| `FR-5.6`            | `CHAT_SEND` → server resolves recipients → `CHAT_MESSAGE` to each. Same WebSocket, JSON opcode — chat is not hot path                                                                                             |
| `FR-5.7`            | Sender, UTC timestamp, and a monotonic `seq` per channel                                                                                                                                                          |
| `FR-5.8`            | Optimistic local echo with a client-side `tempId`, reconciled on the server's echo; a refusal comes back as `CHAT_REJECT` naming that `tempId`, so the right message is marked and none is left looking sent      |
| `FR-5.9`            | **Recipients are resolved once, at send time.** Walking away afterwards does not retract a delivered message — so delivery is a snapshot, never a live subscription                                               |
| `FR-5.10`           | `TYPING` frame with `TYPING_INDICATOR_TTL_MS` expiry. In-memory only, never persisted                                                                                                                             |
| `FR-5.11`–`FR-5.13` | `room` and `direct` persist to a `messages` table; **`nearby` and `zone` never touch the database** — they are delivered and forgotten                                                                            |
| `FR-5.14`           | Markdown-lite (line breaks, emphasis, code), URLs linkified. Rendering untrusted text is the injection surface here — see the note below                                                                          |
| `FR-5.15`           | Mentions resolved server-side **against the already-resolved recipient set**, so a mention cannot leak a message outside its scope                                                                                |
| `FR-5.16`           | `read_state` table holding the last-seen `seq` per (identity, channel), moved by `CHAT_READ` and returned on `CHAT_HISTORY_RESULT`                                                                                |

### Rendering untrusted text

> **Built differently to this note's original suggestion, which was DOMPurify.**

The risk assessment was right and the remedy is stronger: the renderer emits **React elements and
never builds an HTML string**, so there is no `dangerouslySetInnerHTML` for a sanitizer to stand in
front of and no markup for a message to inject into. Sanitising is a filter over a dangerous
representation; not producing that representation is better than filtering it, and it drops a
dependency whose bypasses are a recurring CVE class.

The one hole this does not close for free is the `javascript:` URL, because a link's `href` is an
attribute rather than a text node. Link protocols are therefore allow-listed explicitly
(`http`, `https`, `mailto`), which is the check DOMPurify would have been performing.

A refactor to `dangerouslySetInnerHTML` would reintroduce the whole class at once, so
`docs/testing-strategy.md` carries a manual injection check to run after any change to the
renderer.

### Ordering

`FR-5.7` requires stable order per channel under concurrent sends, so ordering is assigned by
the server, never by the client:

- **Persistent channels** (`room`, `direct`) — `BIGSERIAL` from PostgreSQL.
- **Ephemeral channels** (`nearby`, `zone`) — an in-memory counter per channel.

Client timestamps are never sent at all — the server stamps `at` on arrival, so there is no clock
to be wrong about ([coordinates-and-units.md](conventions/coordinates-and-units.md#time)).

Assigning the numbers is only half of it. Sends are also **serialised per channel** on the server,
so the order messages are numbered in is the order they are written out. Without that, two
concurrent sends can be numbered correctly and delivered in the opposite order, and a client that
appends as frames arrive shows a shuffled conversation while one that sorts shows the right one —
two clients, both behaving reasonably, disagreeing.

Clients must not assume `seq` starts at 1 or is contiguous: persistent channels take it from a
global `BIGSERIAL`, ephemeral ones from a per-channel counter. Only the increase is guaranteed.

### Rules

- **Guest DMs last only as long as the session.** Until Phase 6, `direct` targets a session id,
  which disappears on leave. Durable DMs need durable identity.
- **Retention is configurable** — `CHAT_HISTORY_LIMIT` and `CHAT_HISTORY_RETENTION_DAYS`, no code
  change, as the Rules require.
- **Rate limiting** at `CHAT_RATE_LIMIT_PER_MIN` (30), server-side, and tracked on the
  _participant_ rather than the connection — a resume rebinds the socket and keeps the person, so
  a per-connection window hands a flooder a clean slate for the cost of a reload.

### Where history lives, and what happens when it does not

`FR-5.11` makes retention configurable, so history sits behind one interface with two
implementations: `messages`/`read_state` on PostgreSQL, and an in-memory store bounded by
`CHAT_HISTORY_LIMIT`. `CHAT_PERSISTENCE` picks between them — `postgres` refuses to boot without a
database, `memory` never opens a connection, and `auto` (the default) tries and falls back with a
warning naming the reason.

The fallback is not a shortcut. The README promises development works with no Docker running and
the bot harness runs against a bare `npm run dev`; this phase's own Non-Goals also permit it —
_"until then, history is per-session/instance"_. Compose sets `postgres`, because there the
database is declared, healthy and depended on, and silently degrading a durable channel to one
that empties on restart is the failure nobody notices until they go looking for a conversation.

This is also why the connection is a plain TypeORM `DataSource` in a provider rather than
`TypeOrmModule.forRoot`: everything ADR 0008 chose is kept — TypeORM, decorated entities,
versioned migrations, `synchronize` off — but `forRoot` treats an unreachable database as a fatal
boot error in every configuration, and this phase needs that to be a choice.

**Ephemeral channels never reach the interface at all.** They have no storage key, so there is
nothing to append to, page from, or mark read — `FR-5.13` is structural rather than a rule
somebody has to remember. Verified against the real database: after a full harness run the
`messages` table holds `room` and `dm:` rows and nothing else.

### Risks and sharp edges

1. **Do not reimplement proximity here.** The moment chat has its own distance check, it drifts
   from media and the consistency rule quietly fails. One function, four callers.
2. **Sanitize on render, not only on store.** Messages arriving over the socket are rendered
   directly; DOMPurify belongs at the render boundary.
3. **Ephemeral means ephemeral.** `nearby` and `zone` must not be logged either. A log file is
   persistence.
4. **Mentions are resolved after scoping, not before.** Resolving them first and then filtering
   is how a `@name` leaks the existence of a message to someone out of range.
5. **Optimistic echo needs reconciliation, not duplication.** The client must match the server's
   echo to its temporary id, or every message appears twice.
6. **A zone event must be published after occupancy is stored, not before.** Found during
   implementation: the channel set is computed off the `FR-3.17` enter/exit stream, and with the
   assignment last a listener reading "you have entered west-corridor" still saw the participant as
   outside it — so the channel was announced one crossing late. Anything else subscribing to that
   stream (Phase 10) would inherit the same off-by-one.

### References

[ADR 0003](../docs/adr/0003-transport-native-websocket.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[architecture.md](../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320) ·
[wire-protocol.md](protocol/wire-protocol.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md)
