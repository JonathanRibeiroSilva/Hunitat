# Testing Strategy

**There is no unit test suite.** The test mechanism is an assertive bot harness that runs against
a live server.

That is a deliberate choice with a real trade-off, so it is worth stating plainly rather than
discovering later.

## Why a harness instead of unit tests

`AC-1.5` requires proving that a client receives updates only for nearby participants "with many
simulated participants". Satisfying it means building a headless bot client that speaks the real
protocol — whatever else we do. Once that exists, making it _assert_ rather than merely generate
load covers the two things most likely to regress:

- **The wire format.** Bots import `@hubitat/protocol`, the same encoders the browser and server
  use. A changed byte offset fails here.
- **Interest management.** Bots can be placed at exact positions and their received sets compared
  against an expected set, exactly.

Both are covered end-to-end, through the real socket, rather than against a mock.

### What this costs

A unit test failure points at a line. A harness failure says _"bot 7 saw someone it shouldn't"_
and you go digging. Runtime is seconds, not milliseconds. For a pure function like a quantizing
codec, a round-trip assertion would be about fifteen lines of Vitest and would fail more
precisely.

The mitigation is in how the scenarios are written: each declares which requirement it protects,
and that string is printed on both pass and fail, so a failure says _what_ broke and not only
_where_.

---

## Running it

```bash
npm run dev --workspace @hubitat/api    # the harness needs a live server
npm run harness

npm run harness -- aoi                  # substring match on scenario name
```

Thirty-nine scenarios, roughly 100 seconds. Exit code is non-zero if any fails, so it drops into
CI unchanged. No LiveKit needed — the scenarios assert the server's decisions, and the server
decides who hears whom, and who may publish at all, whether or not an SFU exists to carry it.

**PostgreSQL is needed for fifteen of them.** The twenty-four scenarios up to phase 5 — and phase
8's two blockless ones, because walking through a door and reading the directory are things a guest
does — run against a bare `npm run dev` exactly as before: with `CHAT_PERSISTENCE=auto` the server
falls back to in-memory history, and `chat-history` asserts the same behaviour against either store.
Accounts cannot degrade that way — there is nowhere to put an account, and from phase 7 nothing for
a role to attach to — so the phase 6, 7, 8, 9 and 10 scenarios that need one **skip** when the
server reports `accountsEnabled: false`, and say so:

```
  SKIP  account-identity — AC-6.1, … — a durable identity across sessions
        accounts are disabled on this server (no database). Start Postgres …
```

Skips are counted separately from passes in the summary line. That distinction is the point: a
skip reported as a pass would make a run against a database-less server look like it had covered
`AC-6.1`–`AC-7.6`.

To run them: `docker compose up -d postgres`, then the harness as usual.

One caveat, and it is the only setup step in the whole suite. `FR-6.13` makes an invite the way
into a Space, and the sole exception is the founding account on a Space that has none — so the
phase 6 scenarios need an account that is already a member, and they establish one under a **fixed**
address (`harness-member@harness.local`) before anything else registers. Phase 7 leans on the same
arrangement one level up: that account is the **founder**, so it holds the owner role, which is what
lets the moderation scenarios build the rest of the hierarchy rather than hoping to inherit one. On a fresh database that
account becomes the founder; on later runs it signs back in as the same member, which is `FR-6.15`
being relied upon as well as tested. If the Space was populated by something _other_ than the
harness, that address is a stranger and there is no honest way to grant it membership — the
scenarios skip with an actionable message rather than inventing a back door.

The runner checks `/health` first: a connection-refused error buried inside the first scenario
reads as a protocol bug, so it is caught up front with an actionable message.

It also **force-closes every bot between scenarios**. A scenario that throws never reaches its
own cleanup, and one leftover bot standing in the world makes every later interest-set assertion
fail for the wrong reason — that cost real debugging time during Phase 1.

---

## The scenarios

Ordered fastest-first, so a broken build fails in seconds rather than after the half-open reaping
scenario has waited out two ping intervals.

### `codec-roundtrip-fuzz` — wire format integrity

Two halves, catching different things:

1. **Local fuzz** — 20,000 random transforms plus 200 batch rounds through the encoders and
   decoders directly, asserting error stays within the quantization bound (5 mm, 0.7°). Also
   eight edge cases that break naive implementations: the ±327.67 m bounds, yaw at exactly 2π
   (must wrap to 0, not overflow), negative yaw, non-finite input, and out-of-range clamping. And
   three malformed frames that must be rejected rather than read past their end.
2. **Wire round-trip** — 25 transforms actually sent bot → server → bot. Far fewer samples, but
   it exercises the real path: `Buffer` byteOffset handling (Node pools buffers, so ignoring the
   offset reads someone else's bytes under load), the batch header, and the server's storage.

Neither half is sufficient alone. Without (1) the coverage is thin; without (2) a codec that is
internally consistent but wrong on the wire would pass.

### `late-join-snapshot` — `AC-1.6`

A joiner must immediately see who is already present, not only whoever moves next. Catches a
server that sends deltas only, where the world looks empty until somebody happens to move.

This is also the only clean place to assert the **enter** radius: a joiner has no prior interest
set, so hysteresis has nothing to preserve.

### `aoi-boundary-walk` — `FR-1.17`

The scenario that would catch the classic bug. A walker crosses the enter radius 40 times, then
loiters inside the hysteresis band. With a single radius that produces dozens of add/remove pairs
and avatars strobing in and out. The assertion is exact: **one add, one remove**.

### `presence-churn` — `AC-1.7`, `FR-1.2`, `NFR-31/32`

Six joins and six leaves tracked within seconds. Also covers a blank display name producing a
generated one, and two limits that are the only thing between the gateway and a malformed client
in a phase with no authentication: a frame sent before `JOIN` is refused, and an oversized frame
closes the connection.

### `reconnect-resume` — `FR-1.5`

Position restored, same session id, same instance-local id, token rotated, replay of a consumed
token refused, and the observer left holding **exactly one** participant.

The duplicate is the interesting failure: a server that treats resume as "join again with the old
name" leaves the original in the registry and the observer watches two copies, one of which never
moves again.

### `aoi-coverage` — `AC-1.5`

Fifty bots on a grid; each one's interest set must match the expected set **exactly** — not be a
superset, which is what a broken filter produces and what a "did I receive something?" check
would miss.

The grid spacing is 11 m for a non-obvious reason, and it is the most instructive thing Phase 1
turned up. **With hysteresis, the interest set is path-dependent.** Fifty bots cannot teleport
atomically: the server interleaves their transform frames with its own ticks, so a pair can
transiently exceed the 30 m exit radius (removed) and then settle at 28.5 m — inside the band,
where re-entry is impossible because entering requires 25 m. They end up invisible to each other
despite a final distance well within the exit radius.

That is hysteresis working correctly. The first version of this scenario assumed simultaneous
movement and was flaky for exactly that reason. The fix is geometric: at 11 m spacing every
pairwise distance is 11·√k for k = i²+j², and k jumps from 5 (24.60 m) straight to 8 (31.11 m)
because 6 and 7 are not sums of two squares. Nothing lands in the band, so the expected set is
path-independent. A guard asserts this property up front, so retuning the radii fails with the
arithmetic instead of going intermittently red.

### `session-reaping` — `AC-1.4`, `FR-1.6`

Two failure modes, and only one is obvious:

- **Abrupt close** — the connection goes away, the server sees `close`, and the participant must
  disappear from everyone else promptly (measured in tens of milliseconds).
- **Half-open** — the connection stays up but the peer stops responding: a closing laptop lid, a
  dropped Wi-Fi link. Nothing fires and only the ping/pong heartbeat notices. This is what
  `FR-1.6` exists for and what leaves ghost participants standing around when it is missing.

The half-open case is simulated by pausing the bot's underlying TCP socket — `ws` answers pings
automatically, so doing nothing would not reproduce it. It takes up to two ping intervals by
design, which is why this scenario runs last.

---

## Phase 2 and 3 scenarios

Phase 2 and 3's requirements describe what people _hear and see_, and whether a sound is pleasant
is not something a bot can assert. What is testable is the layer underneath, and it is where the
logic errors actually live: the server computes an audience set and ships it as an `AUDIENCE`
frame, so **who would hear whom, at what gain, with video or without** is observable without a
single media track.

These scenarios need no LiveKit running. That is deliberate and worth keeping — a test suite that
requires an SFU is a test suite people stop running.

### `private-zone-isolation` — `FR-3.8`, `FR-3.9`, `FR-3.10`

The Phase 3 risks section names this one directly: the natural test is whether two people inside
can hear each other, and the requirement that actually breaks is `FR-3.9` — whether someone just
outside is cut off, **in both directions**.

So the outsider stands **3.5 m** from the insiders, well inside the 12 m proximity range. If
isolation is not applied, proximity connects them and this fails. An outsider parked 40 m away
would pass against a server with no zone logic at all.

Also asserts the reason, not merely the presence: two people in a shared private zone must be
audible _because of the zone_ at full gain, not incidentally because they happen to be close.

### `spotlight-reach` — `FR-3.12`, `FR-3.13`

Two requirements that pull opposite ways. An implementation treating spotlight as a _replacement_
for proximity satisfies `FR-3.12` and breaks `FR-3.13`, so the assertion is that the listener
hears **both** the stage and their own neighbour, with different reasons.

The listener stands 100 m out — outside `AOI_ENTER_RADIUS_M`, not merely outside audible range.
The interest set is the natural candidate list for an audience, and a spotlight has to be unioned
in explicitly or it silently stops at the interest boundary. Bots are authoritative over their own
position and are not confined to the map, which is how a 26 × 18 m office reaches that case.

### `zone-boundary-walk` — `FR-3.3`, `FR-3.18`

`aoi-boundary-walk` one phase later, with worse consequences: a flapping interest set makes an
avatar strobe, a flapping private zone connects and drops someone's audio twenty times a second.
Forty crossings of a zone edge must produce **one** enter, and a clean pass-through of a trigger
exactly one enter then one exit, carrying the authored key and a timestamp (`DC-3.3`).

### `portal-teleport` — `FR-3.14`, `FR-3.16`

The interesting requirement is not that it moves you. It is that a participant _"must not
immediately re-trigger the same portal"_ — the naive version bounces someone between two
destinations forever. So the traveller stands still at the destination past `PORTAL_COOLDOWN_MS`
and the assertion is that **nothing else happens**.

The destination is inside the private zone, which also covers `FR-3.16`: zone membership must be
established at the new location rather than inherited from the old one. The portal must show up as
a matched enter _and_ exit, never left as somewhere the traveller is still standing.

### `audible-visible-range` — `FR-2.7`, `FR-2.11`, `FR-2.12`

Three participants at 4 m, 10 m and 20 m from one listener, against thresholds of 12 m audible and
8 m visible.

The middle one is the whole scenario. A single threshold — "range" read as one idea rather than
two — passes at 4 m and passes at 20 m, and fails only in the gap `FR-2.7` exists to allow. The
assertion is that the 10 m participant is audible with `visible: false`.

The 20 m case covers `FR-2.11`, and the distinction is finer than it looks: the requirement is
_absence_, not an entry with `gain: 0`. A zero-gain entry tells a client to subscribe to a track
and play it silently, and silence still costs the same bandwidth as speech.

Then the hysteresis band. Stepping from 4 m to 8.5 m — just past the visible threshold, inside the
2 m band — must **not** drop video, and 11 m must. Without the band, standing on 8 m renegotiates
a WebRTC track twenty times a second.

One detail in this scenario is worth copying rather than re-deriving. It waits for the audience to
settle by asserting on the **reported distances**, not on the flags it is about to check. Each bot
sends its transform on its own socket, so the server can apply four moves in any order and there
are intermediate ticks that look exactly like a settled world if you key on a visibility flag: at
spawn everyone stands ~9 m from where the listener ends up, which is audible-and-not-visible —
indistinguishable from the 10 m bot at its final position. Keying on `distanceM` fixes the geometry
without presuming the answer. It was intermittently red for precisely this reason before phase 5.

### `media-budget` — `FR-2.18`, `NFR-20`

Fourteen bots on a ring at known radii around one listener, which is more than either cap allows
(12 audio, 6 video).

"Degrades gracefully" is easy to claim and easy to not have, so the assertion is not that
_something_ was shed — it is what, and in which order. The six nearest keep video; the two at 7 m
and 7.5 m are inside visible range but past the video cap, and must keep **audio**; the two most
distant lose everything. An implementation that sheds whole participants passes a count check and
fails here, which is the point: a conversation survives losing a face and does not survive losing
a voice.

The ring is placed outside the map, clear of every authored zone — a private zone or a spotlight
defeats distance by design, and would make the distance ranking mean something else.

### `spawn-placement` — `FR-3.6`, `FR-3.7`

Six arrivals must spread across the two `least-crowded` spawns and none may land within two avatar
radii of another. The overlap assertion is the one worth having: Phase 1 offset arrivals by a
random angle, which spreads people out _usually_, and two unlucky draws surface as a complaint
rather than a test failure.

---

## Phase 4 scenarios

Phase 4 is mostly about how an avatar _looks_, which a bot cannot see. What a bot can see is
everything underneath: which frames carry an appearance, whether a throttle actually throttles,
and whether a status survives a reconnect. Those are where the bugs are — the animation blend is
verified by eye, and the replication is not.

One part of "how it looks" turned out to be measurable after all, and is checked by the asset
generator rather than by the harness — see [The avatar generator's self-check](#the-avatar-generators-self-check) below.

### `appearance-replication` — `AC-4.2`, `FR-4.6`, `FR-4.8`

The failure this exists for is specific. A server that broadcasts `PARTICIPANT_UPDATE` on change
and stops there passes every test anybody thinks to write, and then shows the **default** avatar to
everyone who arrives afterwards — because the appearance was never added to the frames that
describe a participant to someone seeing them for the first time.

So all three arrival paths are asserted: a watcher already present (`PARTICIPANT_UPDATE`), a bot
that joins later (`SNAPSHOT`), and a bot that walks in from beyond the interest radius
(`PARTICIPANT_ADD`). The Phase 4 Rules name the third one explicitly, and it is the one that
breaks.

Also that a join carrying no appearance is _given_ one. The Phase 1 capsules had `colorForId` so a
room of strangers was a room of distinguishable strangers; replacing them with identical characters
would be a regression in a feature nobody would think to re-test.

### `emote-throttle` — `AC-4.5`, `FR-4.15`, `FR-4.16`

Three claims, each with its own failure:

An emote reaches nearby observers **and its author**. The author is the part that gets missed: an
observer is never in their own area of interest, so a broadcast routed through the interest set
alone shows everyone the wave except the person who sent it — and in third person, that is the one
person watching for it.

A burst collapses to one. `EMOTE_MIN_INTERVAL_MS` is a guarantee rather than a client courtesy, so
the bot sends four times more than the interval allows and expects the server to drop the excess.

The excess is dropped **silently**. Answering a throttled emote with `ERROR rate-limited` would
turn a leaned-on key into a stream of warnings for a client that did nothing wrong. An unrecognised
emote id is checked the same way: ignored, never fatal, which is what lets a newer client talk to
an older server.

### `presence-status` — `AC-4.4`, `FR-4.11`, `FR-1.22`

Two facts share one nameplate and they are not the same fact: **status** is chosen by the
participant, **activity** is derived by the server from input. So this asserts the happy path, that
the author receives their own change, and that `SET_STATUS` with `"idle"` is refused as a bad
frame — a client that could claim idle could claim to be at its desk indefinitely.

It also reconnects with a resume token and asserts the status came back. Status lives on the
participant, not on the socket; a reconnect that reset it to `available` would announce someone as
interruptible at the exact moment they were not.

---

## Phase 5 scenarios

Chat is the first feature where nearly everything that matters is machine-checkable. Who received a
message is a fact, not an impression — so unlike phases 2 and 4, there is very little here left for
a human to look at.

Three of the five spend most of their runtime proving a **negative**, and that is the cost of the
phase: showing that a message did not arrive means waiting long enough that it would have.

### `chat-scoping` — `FR-5.1`–`FR-5.4`, `AC-5.1`

All four scopes in one run, with a layout chosen so each can fail _into another_ and be caught.

The far bot stands at 20 m: inside `AOI_ENTER_RADIUS_M` (25) and outside `CHAT_NEARBY_RADIUS_M`
(12). If `nearby` were quietly resolving to "the interest set" — the natural shortcut, since the
interest set is right there — that bot receives the message and this fails. Parked at 60 m it would
pass against a server with no proximity logic at all.

The zone half uses `west-corridor`, a **trigger** zone, and not the private huddle. That choice is
the scenario. Inside a private zone `nearby` already excludes everyone outside, so a zone message
there reaches the right people even if zone resolution fell through to proximity; in the corridor
the two disagree, and the outsider stands 2 m from the edge to prove which one ran.

It also asserts the direct channel is named from the **reader's** side on both ends. Getting that
backwards files every reply into a thread nobody is reading, and no other assertion notices.

### `chat-ordering` — `FR-5.7`, `FR-5.8`, `AC-5.2`

Two bots interleave sixteen sends into the room channel as fast as the socket allows, because
"stable order per channel" is only interesting **under concurrency** — that is the case `FR-5.7`
names, and the only one where a client-assigned sequence would differ from a server-assigned one.

The trap it is built for is not wrong numbers. It is a server that assigns `seq` correctly and then
writes frames out in whatever order its awaits resolved: every client would then have to sort, and
one that appended as frames arrived would show a shuffled conversation. So the assertion is that
arrival order and sequence order agree, for three observers independently.

It also checks that every send came back carrying its `tempId`, and that **nobody else** received
one. Without the echo a client cannot reconcile the message it already drew and every message
appears twice; leaking it would let a recipient reconcile against an id that means nothing to them.

### `chat-mentions` — `FR-5.15`, `AC-5.5`

This scenario exists for one Rule:

> Mentions must not leak a message to someone outside the channel's scope.

Which is entirely about _ordering inside the server_. Resolving mentions against the roster and
then filtering by scope produces an identical result for everyone in range — and tells the person
out of range that a message about them exists. The only observable difference between the correct
implementation and the broken one is what the out-of-scope participant receives, so that is the
assertion: one line mentioning two people, one in range and one at 18 m, and the second must
receive nothing at all.

Display names deliberately contain a space. A mention scanner built on `@\w+` matches `Mention` and
resolves nobody, which is a bug that single-word test names hide completely.

### `chat-history` — `FR-5.11`–`FR-5.13`, `FR-5.16`, `AC-5.4`, `AC-5.6`

Asserted from a bot that was **not connected** when the messages were sent, which is the only way
to tell history from live delivery — a bot that was present received everything on the socket and
would pass whether or not anything was stored.

`FR-5.13` gets the same treatment and is the more important half: an ephemeral channel that quietly
retained its messages looks identical to a correct one in every other test. So a `nearby` message
is sent alongside the room ones and must appear in neither the nearby history nor, more subtly, the
room history.

Message bodies are stamped with a timestamp because the room channel is durable: a fixed body would
match a message left behind by the _previous run_ of this scenario and pass for the wrong reason.

### `chat-typing-channels` — `FR-5.5`, `FR-5.10`, `AC-5.3`

Two requirements that are one idea: what you can type in, and who is told that you are.

The zone channel must appear on entering a chat-enabled zone and vanish on leaving — and must never
be advertised to anybody else, because the set names where a person is standing and broadcasting it
would publish the position the area of interest exists to hide.

"A channel they share" is the load-bearing phrase in `FR-5.10`, so typing is scoped by exactly the
same resolution as a message: somebody typing in a zone you are not in must not appear to you. That
assertion is the one that fails when typing is implemented as a broadcast, which is the obvious way
to implement it.

Finally, a send into a zone the participant has walked out of must be **refused and named**
(`channel-unavailable`), not accepted into a channel the sender no longer has.

This scenario caught a real ordering bug during phase 5. Zone occupancy was assigned _after_ the
enter/exit events were published, so a listener on that stream saw the participant as still outside
the zone they had just entered, and the chat channel was announced one crossing late.

---

## Phase 6 scenarios

Accounts are the first feature that is not entirely on the socket. They are created over REST and
_used_ on the WebSocket, and `FR-6.18` — "authenticated state is what binds a live presence to a
durable identity" — is precisely the seam between the two. A scenario that could only see one side
could not test it, so these drive both: `apps/harness/src/accounts.ts` is the HTTP half, holding
its credentials the way the browser does (access token in memory, refresh token in a cookie it
never reads).

They run **last**, and not only because argon2 costs ~50 ms per hash. `guests-not-allowed` briefly
closes the Space to guests, and every scenario above it joins as one.

### `account-identity` — `AC-6.1`, `FR-6.2`, `FR-6.9`, `FR-6.11`, `FR-6.18`

Register, join, send a message, disconnect, sign in **again**, join again — and find the same
profile and the same avatar under a different session id.

The last assertion is the one worth having. It is not that the name matches: it is that the room
message sent by the first session, read back out of history by the second, resolves to the local id
of the person now standing in the room. That only holds if authorship was stored against the
durable identity rather than the session id, which is `FR-6.11` in the only form observable from
outside the process. The stored value is checked directly too — it must begin `acct:`.

### `guest-upgrade` — `AC-6.2`, `FR-6.7`, `FR-6.13`

The requirement most easily satisfied wrongly. Registering, reloading the page and signing in
produces the same end state and fails the Rule this exists for: _"guest-to-account upgrade must not
lose the user's place/state mid-session"_.

So the assertion is not that the account has the right name. It is that the **same socket** — never
closed, never rejoined — receives an `IDENTITY` frame saying it is now an account, and that the
session id on the far side is the one it had before. A reconnect would change it.

A second bot watches, because `FR-6.13` says the system distinguishes members from guests: an
observer that goes on labelling somebody a guest after they have signed up is showing something
that is no longer true.

### `invite-membership` — `AC-6.3`, `AC-6.4`, `FR-6.12`–`FR-6.16`

The single-use invite is the interesting half, and the Phase 6 implementation notes flag it by
name: checking `uses < max_uses` and then incrementing without a lock over-issues, and two people
clicking the same link at the same moment is ordinary rather than adversarial.

So this redeems a one-use invite from **two accounts concurrently** and asserts that exactly one
wins. Serial redemption would pass against the unlocked implementation the transaction exists to
rule out — which is why it is written the harder way.

Then `AC-6.4`: the loser's message must say the invite was _used_, not that it _expired_. The Rules
require those to read differently because the recovery differs, and a shared "invalid invite"
string would satisfy every other assertion here.

### `session-lifecycle` — `AC-6.6`, `FR-6.4`, `FR-6.17`, `FR-6.18`

Four properties, and two are about failing correctly.

**A bad token is refused, never downgraded to a guest.** This is the failure mode with no symptom:
somebody whose token expired keeps walking around, and everything they do — profile edits, direct
messages, membership — lands on an ephemeral identity that disappears when they close the tab. Both
a malformed token and a well-formed one with a forged signature are checked, because the second is
what a naive "does it parse" implementation lets through.

**Rotation, with reuse detection, and with leeway.** A refresh token replayed long after it was
spent revokes the whole family — that is ADR 0011's entire point, and without it rotation is
decorative. But a token re-presented _within_ `REFRESH_REUSE_LEEWAY_MS` is a client racing itself:
two browser tabs restored at the same instant read one cookie out of a shared jar and both refresh
before either `Set-Cookie` has landed. Treating that as theft signs somebody out of both tabs for
opening two tabs. Both sides are asserted, which costs this scenario a real ten-second wait — the
leeway is a wall-clock property and there is no way to observe it without letting it elapse.

### `guests-not-allowed` — `AC-6.5`, `FR-6.8`

Closing the Space and asserting that a guest cannot get in is the easy half. The half that matters
is the Rules':

> A Space configured to disallow guests must reject guest entry with a clear message **and an
> invite path**.

So the refusal must carry a distinct code — a client cannot offer "sign in or open your invite" in
response to a generic denial — and a message that names both routes. Both are asserted, and the
setting is restored in a `finally` because every scenario in the suite joins as a guest.

---

## Phase 7 scenarios

Six, and every one of them needs a database and an account: a role has nothing to attach to
otherwise. They run **last**, after phase 6, and `access-controls` runs last of all — it locks the
space, sets a password and drops capacity to one, and every scenario before it joins as an ordinary
guest. It restores all four in a `finally` and then proves the restoration, for the reason
`guests-not-allowed` does one phase earlier: a silent failure there would be diagnosed as twenty
other bugs.

Three of the six exist in the shape they do because the Phase 7 implementation notes named the
failure before the code was written. Those three are worth reading before changing anything here.

### `moderation-capabilities` — `AC-7.1`, `FR-7.2`–`FR-7.4`, `NFR-34`

Every refusal is asserted **twice**: once as an `ERROR forbidden` frame on a socket, once as an
HTTP 403.

That is not thoroughness for its own sake. `NFR-34` requires authorization on both paths, and the
implementation notes call the unguarded WebSocket handler "the single most likely way this phase
ships broken" — the moderation _frames_ are where a bypass would be, and they are the ones a
modified client would send. A scenario that only exercised the REST surface would pass against
exactly that bug.

The hierarchy is built rather than assumed: the founding account is the owner, two fresh accounts
redeem an invite, and one is promoted. So the scenario controls the whole ladder instead of
depending on what a previous run happened to leave behind.

Three rungs, and the third is the one people forget:

- a **member** is refused, and the target is checked to be unchanged — `FR-7.4` says an attempt "is
  refused", and a button that silently does nothing is indistinguishable from one that worked;
- an **admin** is allowed;
- an admin acting on the **owner** is refused. `outranks` is strict, so this also covers the case
  the requirement does not state: two admins cannot moderate each other.

Then the admin is demoted while standing in the world, and their next action is refused. That is
`FR-7.10` and the reason roles are not carried on the access token — a role baked into a
fifteen-minute credential keeps working for fifteen minutes after it is revoked.

### `force-mute` — `AC-7.2`, `FR-7.5`, `FR-7.6`

The interesting assertion is a **reconnect**. The target drops its socket and resumes, and the mute
is still there and re-stated on the new connection.

Without that, a moderated participant could get a fresh LiveKit token with `canPublish: true` by
pressing reload, and a moderation action with a ten-second workaround is not one. The state lives on
the participant rather than on the socket, and the media grant is built from it.

The scenario also checks what observers are **not** told: every `PARTICIPANT_UPDATE` carrying
`moderation` must carry no actor and no reason. Everyone learns that somebody is muted, because a
room where one person has gone quiet needs to distinguish that from a broken microphone; only the
muted person is told who did it, because publishing that to the room turns every mute into an
announcement.

What cannot be asserted here is the SFU call itself. The harness runs without LiveKit by design, so
"cannot self-unmute" is tested as the property that makes it true — nothing a client sends changes
the server's copy, and it survives a reconnect. That LiveKit refuses the publish is the two-call
pattern in `MediaService`, and it is on the manual checklist.

### `kick-and-ban` — `AC-7.3`, `FR-7.7`, `FR-7.8`

A banned account is made to present a **valid resume token**. The Phase 7 notes name this one too:

> A kicked or banned identity presenting a valid resume token must be refused; the ban check belongs
> in the resume path too, not only in fresh joins.

A ban guarded only on the fresh-join branch passes every other assertion in this scenario and lasts
exactly until its target's client reconnects.

The two halves are tested on different subjects on purpose. **Kick** on a guest, because `FR-7.7`
says a kicked user may rejoin when not banned — so the assertion is that they _can_, and that the
short cooldown stops them doing it in the same instant. **Ban** on an account, because that is the
case `FR-7.8` is clean for; asserting the guest form would be asserting the strength of a cookie.

Lifting the ban readmits them, and the lifted row **stays in the list**. A ban that was issued and
quietly deleted is exactly what an audit trail exists to make visible.

### `access-controls` — `AC-7.4`, `FR-7.11`–`FR-7.15`

Four controls, six refusal codes, and the codes are most of the point: `space-locked`,
`password-required`, `password-incorrect`, `not-allowlisted`, `world-full` and `banned` all need
different things from the person reading them, and a merged refusal would leave the client unable to
offer any of them.

Capacity is reached by setting it to **one** against a world with one person in it, rather than
connecting fifty sockets. The scenario then reconnects that person and asserts they are let back in:
they are already counted, and refusing them would evict somebody for a dropped packet.

The admin exception is asserted rather than left implicit — an owner joins a locked space. Without
it, an admin who locks a space and then loses their connection has no way back in to unlock it.

### `blocking` — `AC-7.5`, `FR-7.16`, `FR-7.18`

The audience frame is checked in **both directions**, not just chat. The notes again:

> Blocks belong in `resolveAudience()`. Filtering blocked users in the UI leaves audio flowing and
> only hides it.

A scenario that only checked chat would pass against that bug, because chat is easy to filter in the
wrong place. And a one-directional check would miss the half that matters most: the blocked party
must stop reaching the blocker, not merely the reverse.

Three more things are asserted because each is a way of getting it subtly wrong:

- both parties stay **visible in presence**. The Rules require a block not to imply the blocker is
  offline, and disappearing is the loudest possible way to break that;
- the blocked sender gets **no `CHAT_REJECT`**. A refusal that only happened for blocked senders
  would itself be the disclosure;
- a **bystander** still hears them. A block is personal, not a mute.

Both parties are accounts, because `FR-7.18`'s durability is stated for accounts — a guest's blocks
are session-scoped and correctly do not survive one.

### `reports-and-audit` — `AC-7.6`, `FR-7.17`, `FR-7.19`, `FR-7.20`

The report's **context** is asserted against a known position: the target is stood at a specific
coordinate and the record has to agree. `DC-7.6` asks for where it happened, and it is captured
server-side because a client-supplied location is a fact about the accused supplied by the accuser.

Filing a report writes **no** audit row; handling one writes one. That asymmetry is the difference
between the two tables — a report is a queue item a moderator can empty, and the audit log is a
record of what moderators did, which the database will not let the application rewrite.

The report body is stamped with a timestamp, for the same reason the chat-history bodies are: the
table is durable, and a fixed sentence would match a report left behind by a previous run — one this
scenario has already marked handled, so the "unreviewed" assertion would fail against a row that was
never this run's.

---

<a name="the-avatar-generators-self-check"></a>

## The avatar generator's self-check

`assets/avatars/build-avatars.mjs` refuses to write an asset that fails four assertions. It is not
part of the harness — it needs no server and runs whenever the avatar is regenerated — but it is
part of how this project tests itself, and it exists because of a bug that got all the way to a
user.

The walk cycle shipped **backwards**. The knee flexed during stance rather than during swing, which
slides the planted foot forward under the body; every individual sign in the file was defensible,
the code read correctly, and the avatar moonwalked. What caught it was measuring the foot, not
reading the source — so that measurement is now a precondition of writing the file:

| Assertion                                               | The failure it catches                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The planted foot travels backwards relative to the hips | A knee flexing during stance — the avatar walks backwards                                              |
| Knees never rotate `+X`; elbows never rotate `−X`       | Joints bending the wrong way. Knees bend backwards, elbows forwards, and the two are easy to transpose |
| Emote clips start and end at the rest pose              | An additive clip whose first frame is not rest bakes its offset in permanently (`FR-4.16`)             |
| Emote clips animate nothing from the hips down          | The additive layer fights the locomotion clip and the legs stop mid-emote (`FR-4.16`)                  |

The legs are a planar chain of X rotations, so the forward kinematics is two lines and the check
needs no dependency at all. Anything that replaces the generator — including a real VRM — is worth
putting through the same measurement, because none of these failures looks like a bug in the thing
that caused it.

---

## What is verified by hand

Three acceptance criteria are about how movement _looks_, and there is no browser automation:

| Criterion | Check, with two browser windows                                       |
| --------- | --------------------------------------------------------------------- |
| `AC-1.1`  | Each window shows the other avatar moving in real time                |
| `AC-1.2`  | Remote movement is smooth, not teleporting                            |
| `AC-1.3`  | You cannot walk through walls or off the floor, and you stay grounded |

Phase 4 adds five more, all of them about appearance rather than about replication — the
replication is covered above:

| Criterion | Check, with two browser windows                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AC-4.1`  | Walk: the walk clip plays and the feet keep up. Stop: idle. Hold shift: run. The transitions cross-fade rather than cut                              |
| `AC-4.3`  | Unmute and talk: a ring appears on your own nameplate and on the other window's copy of it. Mute: it clears immediately and cannot be made to return |
| `AC-4.4`  | Set do-not-disturb: the glyph over your head changes shape, not only colour, in both windows                                                         |
| `AC-4.5`  | Press 1: the wave plays locally and remotely, the glyph rises, and the avatar returns to normal. Press it while walking — the legs must not stop     |
| `AC-4.6`  | Walk in a circle around someone: their avatar faces the way it is travelling, and their voice pans to match                                          |

`AC-4.5` while walking is the one worth doing deliberately. Emotes play on an additive layer over
locomotion; if a replacement avatar model animates the hips or legs in an emote clip, the legs
stop and the symptom is "emotes are broken" rather than "that clip is wrong".

Client performance (`NFR-11`–`NFR-15`) and the browser matrix (`NFR-27`–`NFR-29`) are also manual,
against the reference hardware named in [`specs/nfr.md`](../specs/nfr.md).

Four client behaviours the harness cannot reach either, because the bots have no renderer and
never disconnect involuntarily:

| Behaviour                                                                | Check                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Movement input ignored while reconnecting (`ux/phase-01-screens.md`)     | Kill the api mid-walk: the avatar stops and does not drift while the banner is up               |
| Loading step timeout, 30 s                                               | Point `VITE_API_URL` at a black-holed port; the loading screen must reach ERROR naming the step |
| Remote avatars fade rather than pop (`FR-1.17`)                          | Walk a second window out past 30 m — they fade, and do not vanish between frames                |
| GPU and WASM disposal (`NFR-14`)                                         | Retry from ERROR a few times; heap snapshots must not gain a world each cycle                   |
| Authored collision volumes block movement (`FR-3.4`, `FR-3.5`, `AC-3.1`) | Walk into the meeting table: you stop and slide along it, without jitter                        |

Phase 5 adds three, all of them about rendering rather than about delivery — the delivery is
covered above:

| Behaviour            | Check                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-5.14` formatting | Send `**bold** *italic* `code` https://example.com` and a two-line message: each renders, the URL is clickable, and the line break survives                                                                                       |
| `FR-5.14` injection  | Send `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))`: both must appear as literal text, and no dialogue opens. Nothing here builds an HTML string, so there is nothing to inject into — this checks that stays true |
| Typing does not walk | Open chat and type "was" — the avatar must not move, and `1`–`6` must not emote                                                                                                                                                   |

The injection check is worth running after any change to `chatMarkdown.tsx`. The renderer emits
React elements rather than HTML, which is what makes it safe; a well-meaning refactor to
`dangerouslySetInnerHTML` would reintroduce the entire class of bug at once.

Phase 6 adds four, and all of them are about the _browser's_ half of a credential — the server's
half is covered by the scenarios above:

| Behaviour                 | Check                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-6.17` across a reload | Sign in, reload the page: the entry screen offers "Enter as _you_" rather than a sign-in form. The access token died with the page; the refresh cookie did not            |
| Token expiry mid-session  | Set `ACCESS_TOKEN_TTL_MIN=1`, stay in the world for two minutes, then rename yourself in the account panel: it must succeed without a visible interruption                |
| `FR-6.5` end to end       | With Compose up, use "Forgot your password?", open Mailpit at <http://localhost:8025>, follow the link: the reset form appears and the token is gone from the address bar |
| Credentials leave the URL | Open an invite link: the banner names the space and `?invite=` is no longer in the address bar or the back button                                                         |

The last two are the reason `captureUrlCredentials` runs before React renders rather than in an
effect. An invite code in a shared screenshot is a door into the Space and a reset token in a
screen-shared address bar is a password, so the window in which either is visible should be as
short as it can be made.

Guest-to-account upgrade is covered by the harness and is also worth seeing once: enter as a guest,
pick an avatar, open **Account**, create one. The avatar must not move and the nameplate must
change in place.

Phase 7 adds four, and one of them is the half of `AC-7.2` no harness can reach:

| Behaviour                       | Check                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-7.5` at the SFU             | With LiveKit running and both windows unmuted, mute one from the other. Its audio stops, and pressing its own microphone button **cannot** bring it back. This is the half the harness cannot assert |
| `FR-7.6` covers screen share    | Turn off video for a window that is sharing its screen: the share stops too. Camera and screen share are one permission on the SFU                                                                   |
| `FR-7.5` after a reload         | Mute a window, then reload it. The button is still dark, still explains itself, and the token it was issued does not permit publishing                                                               |
| `FR-7.16` does not hide anybody | Block a window: it stays in the presence list, struck through, and goes silent both ways. It must not vanish — the Rules forbid implying the blocker is offline                                      |

The first is the one to run after any change to `MediaService`. Muting the published track without
also revoking `canPublish` looks correct from the server and from every assertion in the harness, and
the target can undo it with one click.

### Spatial media

`AC-2.1`–`AC-2.7`, `AC-3.2` and `AC-3.3` are worded in terms of hearing and seeing. Automated
testing of spatial audio _quality_ is not practical, so these are human checks. Everything they
depend on that a machine can judge — who is in the audience, at what gain, with which video flag,
and in what order streams are shed — is covered by the scenarios above.

Two browser windows, both unmuted, with `docker compose up -d livekit` running:

| Criterion | Check                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AC-2.1`  | Walk toward each other: louder. Apart: quieter. Past 12 m: silent, and the subscription is gone in `chrome://webrtc-internals`                                |
| `AC-2.2`  | A face appears inside 8 m and is gone outside it — note this is _nearer_ than the audible threshold, so there is a band where you hear someone you cannot see |
| `AC-2.3`  | No call or accept step exists anywhere in the flow; proximity alone connects                                                                                  |
| `AC-2.4`  | With many windows, active streams stay bounded at 12 audio / 6 video                                                                                          |
| `AC-2.5`  | Mute: outbound audio stops and the speaking ring clears immediately. The track is unpublished, not gated                                                      |
| `AC-2.6`  | A screen share appears for in-range participants and stops cleanly                                                                                            |
| `AC-2.7`  | Walking through a crowd does not break audio for bystanders                                                                                                   |
| `AC-3.2`  | Two inside `huddle-meeting` hear each other fully; a third standing just outside hears nothing, and is heard by nobody inside                                 |
| `AC-3.3`  | Standing on `stage` is heard across the whole map, while listeners still hear their own neighbours                                                            |
| `FR-2.10` | Walk around someone talking: their voice moves across the stereo field, and does **not** swing when you only orbit the camera                                 |
| `FR-2.5`  | Deny microphone permission at the browser prompt: a named message appears and presence is unaffected                                                          |

Directional audio must be verified in **Safari** specifically (`NFR-27`) — its `PannerNode`
orientation has historically diverged from Chrome's, which is why `spatialAudio` carries a legacy
`setPosition`/`setOrientation` branch.

The token path itself — that `JOINED` carries a well-formed grant and that the SFU accepts it — is
checked separately, since it needs a running LiveKit and the harness must not.

---

## Phase 8, 9 and 10 scenarios

Six scenarios, and what makes them worth their runtime is that almost every assertion is a claim
about something **not** happening — which is exactly the class of behaviour that ships broken and
stays broken because nothing errors.

### `cross-map-portal` — `FR-8.5`, `FR-8.6`, `FR-8.7`, `AC-8.1`, `AC-8.2`

Walk through a portal into another Map. Four things move together in one server-side method, and
the scenario asserts all four: the transfer names a destination and a spawn, somebody standing in
the destination sees the traveller arrive, somebody standing in the **origin** sees them leave, and
a room message sent afterwards does not cross back. The third is the half that fails silently — a
transfer that adds without removing leaves a ghost in the map behind — and the fourth is the one
that would be _retained_, because room history is.

### `space-directory` — `FR-8.12`, `FR-8.13`, `FR-8.14`, `AC-8.5`

The directory arrives unprompted inside the handshake, direct navigation lands in the Map it named,
and "go to a member" resolves **server-side**: the scenario sends a session id, never the instance
id the directory happens to hold, and asserts on the instance the server chose. Naming the instance
from the client would bypass the assignment rules `FR-8.14` requires it to reuse, and would go stale
between the push and the click. Both bots are guests, so it also asserts the names list is empty —
`FR-8.12`'s "subject to permissions", which the server draws at membership.

### `map-instancing` — `FR-8.8`, `FR-8.9`, `FR-8.10`, `AC-8.3`, `AC-8.4`

Capacity two, three arrivals. The first two must land in the **same** copy — `fill-then-spill` is the
default precisely because a balancer would scatter a team of six across three rooms — and the third
must spill, be told, and be unable to see or hear the first two. The chat assertion is the one that
matters most: a leak there is retained, so it outlives the session it happened in.

### `map-lifecycle` — `FR-8.15`, `FR-8.17`, `FR-8.18`, `AC-8.6`

A member is refused (403) before anything is created, a room is created and appears live in somebody
else's directory, archiving it moves the person inside out **with a notice and without
disconnecting them**, and deleting it is refused until the room's own slug is typed back.

### `map-editing` — `FR-9.4`, `FR-9.18`–`FR-9.22`, `AC-9.5`, `AC-9.6`

Reads the _published_ document through the public route rather than the editor's own view of the
draft — asserting on the editor's copy would prove nothing about what participants are standing in.
A stale save is asserted to be a **409**, not merely a failure: the code is what tells a client to
reload rather than retry, and retrying is the overwrite `FR-9.22` forbids. Reverting is asserted to
produce a _newer_ version and to leave the one reverted away from reachable, which a pointer rolled
backwards would not.

### `shared-objects` — `FR-10.11`–`FR-10.14`, `FR-10.16`, `AC-10.3`–`AC-10.6`

Drives the CRDT channel with a headless client speaking the same `y-protocols` the browser does, so
a change to the sync handshake, to `/collab`'s authorization or to the persistence flush fails here
rather than as a whiteboard that quietly forgot an afternoon. Convergence is asserted on **both**
documents, because a one-directional relay passes an assertion made on one. A bot standing across
the room is refused the channel, which is `FR-10.14` as an access control rather than a hint — the
prompt is client-side and anybody could skip it. And a content type outside the closed enum is
refused at publish, which is `AC-10.6` expressed as something a test can observe.

---

## Verifying the specification layer

The specs themselves have an invariant worth checking: the Implementation Notes were appended,
and no requirement text or ID was altered.

There is no git repository yet, so the check is a diff against a copy taken before editing:

```bash
diff -u baseline/phase-01-core-realtime-world.md specs/phase-01-core-realtime-world.md | grep '^-'
```

Only additions should appear. Once the project is under version control this becomes
`git diff --stat` and stops needing explanation.

---

## What is not covered

Stated so nobody assumes otherwise:

- **No browser automation.** `AC-1.1`–`AC-1.3` are manual.
- **No load testing beyond 50 bots.** `NFR-1` is the validated ceiling; nothing above it has been
  measured.
- **No injected latency or packet loss.** `NFR-21` defines "normal jitter" but the harness runs on
  loopback, so the interpolation buffer is not yet exercised under real conditions.
- **No client-side unit coverage.** The camera, the character controller and the interpolation
  buffer are verified by eye.
- **No rendering assertions.** The bots have no renderer, so `AC-4.1`, `AC-4.3` and `AC-4.6` — the
  animation blend, the speaking ring and avatar facing — are manual. What is automated is the data
  each of them is drawn from.
- **No security testing** beyond the frame-limit assertions in `presence-churn`.
- **The editor is manual.** `AC-9.1`–`AC-9.4` — placing and dragging with a gizmo, undo across zone
  and property edits, walking a draft in play-mode, and lighting changing the runtime look — need a
  browser to have an opinion about. What is automated is everything underneath: the draft, the
  versions, the locks and the publish.
- **The asset pipeline's output is not asserted.** That an upload is accepted, rejected with a
  reason, or simplified into level-of-detail variants is checked by hand against a real `.glb`; the
  harness has no models to upload and no object storage to upload them to.
- **The content types are manual.** `AC-10.1` and `AC-10.2` — that a prompt appears as you walk up,
  that a link opens, an image renders, a video plays and a note reads — are a browser doing its job.
  What is automated is the shared state underneath them.
