# Phase 7 — Permissions & Moderation

## Overview

**Goal.** Make spaces safe and governable: define roles and what they can do, give
moderators tools to act on bad behavior, control who can enter, and let users protect
themselves.

**Value.** No space can be opened to others without this. Roles gate authority; moderation
tools handle disruption; access controls keep the wrong people out; blocking/reporting give
users agency; an audit trail keeps moderators accountable.

**Depends on.** Phase 6 (accounts/membership → roles attach to identities), Phase 2 (media,
to force-mute/disable), Phase 5 (chat, to mute/remove).

**Delivers.** Owners/admins with real powers, the ability to kick/ban/mute/respawn
disruptive participants, lockable/password/allowlisted spaces, user-level blocking and
reporting, and a log of moderation actions.

---

## In scope

- Roles (owner, admin, member, guest) and a capability matrix.
- Moderation actions: force-mute, disable media, kick, ban, respawn/teleport.
- Space access controls: lock, password, allowlist, capacity gating.
- User-level reporting and blocking.
- An audit log of moderation actions.

## Out of scope

- Automated content moderation / toxicity detection.
- Appeals workflows and ban-duration scheduling beyond basic timed/permanent.

---

## Functional Requirements

### Roles & capabilities

- **FR-7.1** Every participant in a Space has a role; baseline roles are **owner**, **admin**,
  **member**, **guest**.
- **FR-7.2** Capabilities are governed by role via a documented capability matrix (who can
  moderate, edit access settings, manage roles, etc.). Higher roles include lower-role abilities.
- **FR-7.3** An owner can assign/revoke admin (and other manageable) roles; admins can moderate but
  cannot remove the owner.
- **FR-7.4** A participant cannot perform an action their role doesn't permit; attempts are refused.

### Moderation actions

- **FR-7.5** A moderator (admin/owner) can **force-mute** a participant's microphone; the target is
  notified and cannot transmit audio until unmuted/permitted.
- **FR-7.6** A moderator can **disable** a participant's camera/screen share similarly.
- **FR-7.7** A moderator can **kick** a participant, removing them from the current world instance;
  the kicked user may rejoin only if not also banned.
- **FR-7.8** A moderator can **ban** a participant from the Space (permanent or time-limited);
  banned identities cannot re-enter until the ban ends/lifts.
- **FR-7.9** A moderator can **respawn/teleport** a participant (e.g., move a disruptive user to a
  spawn or out of a zone).
- **FR-7.10** Moderation actions take effect promptly and reliably across the target's session.

### Access controls

- **FR-7.11** A Space/map can be **locked** so no new participants may enter.
- **FR-7.12** A Space/map can require a **password** to enter.
- **FR-7.13** A Space can use an **allowlist** so only specified identities may enter.
- **FR-7.14** A Space/map can enforce a **capacity** limit; entry beyond capacity is refused or
  routed to overflow handling (defined in Phase 8).
- **FR-7.15** Access-control changes apply to new entries immediately and are configurable by
  permitted roles only.

### User self-protection

- **FR-7.16** A participant can **block** another participant: the blocker stops receiving the
  blocked user's media and chat, and vice-versa as appropriate, without needing moderator action.
- **FR-7.17** A participant can **report** another participant, creating a record for moderators
  with context (who, where, optional reason).
- **FR-7.18** Blocking is personal and durable for the blocker's identity (persists across sessions
  for accounts).

### Audit & accountability

- **FR-7.19** Moderation actions (mute, disable, kick, ban, role changes, access changes) are
  recorded in an audit log with actor, target, action, time, and scope.
- **FR-7.20** Permitted roles can review the audit log; it is tamper-evident enough to be trusted
  (append-only in intent).

---

## Data Concepts

- **DC-7.1 Role** — a named authority level held by an identity within a Space.
- **DC-7.2 Capability Matrix** — mapping of roles to allowed actions.
- **DC-7.3 Moderation Action** — actor, target, type (mute/disable/kick/ban/respawn/role/access),
  parameters (e.g., ban duration), timestamp, scope.
- **DC-7.4 Access Policy** — a Space/map's lock state, password requirement, allowlist, and capacity.
- **DC-7.5 Block** — a personal relationship hiding two identities' media/chat from each other.
- **DC-7.6 Report** — a user-filed record for moderator review.
- **DC-7.7 Audit Log** — the append-only record of moderation/access/role events.

---

## Rules & Edge Cases

- Role checks must be enforced authoritatively, not just hidden in the UI (a client cannot perform a
  disallowed action by bypassing the interface).
- A banned identity must be recognizable on re-entry attempts (ties to durable identity, Phase 6);
  guests may be banned by available identifying signals, with known limitations documented.
- Force-mute must override the target's own unmute until lifted.
- Blocks must apply symmetrically enough that a blocked user can't harass via media or chat, while
  not falsely implying the blocker is offline.
- Capacity/overflow interplay with Phase 8 instancing must be consistent (refuse vs. shard).
- The owner role must not be removable by anyone but through an explicit ownership-transfer path.

---

## Acceptance Criteria

- **AC-7.1** A member cannot perform admin-only actions; an admin can; the owner can do everything an
  admin can plus manage roles.
- **AC-7.2** Force-mute silences a target's audio until lifted; the target is informed and cannot
  self-unmute.
- **AC-7.3** Kick removes a participant immediately; ban prevents re-entry for its duration.
- **AC-7.4** A locked/password/allowlisted/at-capacity Space refuses ineligible entrants with a clear
  reason.
- **AC-7.5** Blocking another user stops their media and chat for the blocker, persisting across the
  blocker's sessions.
- **AC-7.6** A report is recorded and visible to moderators; every moderation action appears in the
  audit log with actor, target, and time.

---

## Non-Goals & Deferred

- Automated/AI content moderation, appeals workflows, granular custom roles beyond the baseline set
  (could extend the capability matrix later).
- **Deferred decisions:** how enforcement is implemented authoritatively, how bans key off identity,
  and audit storage are chosen later; this spec fixes the required behavior and guarantees.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### The rule that catches people out

From the Rules section:

> Role checks must be enforced authoritatively, not just hidden in the UI.

The half that gets forgotten is the **WebSocket**. Guarding HTTP controllers is routine; the
socket carries `EMOTE`, `CHAT_SEND` and moderation frames too, and an unguarded gateway handler
is a complete bypass of every role check in the product.

So: the capability matrix is a constant in `packages/protocol`, and `RolesGuard` is applied to
**both** HTTP controllers and WebSocket handlers. `NFR-34` states this as a testable
requirement.

### Force-mute needs two calls, not one

`FR-7.5` requires the target to be unable to transmit _until unmuted_. LiveKit's
`mutePublishedTrack` alone does not achieve that — the client can simply re-enable its own track.

```
RoomServiceClient.mutePublishedTrack(...)                  // stops it now
RoomServiceClient.updateParticipant(..., { canPublish: false })  // stops it staying stopped
```

Both, always. The same pattern applies to `FR-7.6` for camera and screen share.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FR-7.1`, `FR-7.2`   | `Role` on `Membership`; `CAPABILITIES: Record<Role, Capability[]>` in `packages/protocol`, higher roles supersetting lower                                                |
| `FR-7.3`             | Owner-only role assignment; the owner role is not assignable or removable except through an explicit ownership transfer                                                   |
| `FR-7.4`             | `RolesGuard` on HTTP **and** WebSocket; refusal returns a clear reason, never a silent no-op                                                                              |
| `FR-7.5`, `FR-7.6`   | The two-call pattern above ([ADR 0006](../docs/adr/0006-media-livekit-sfu.md))                                                                                            |
| `FR-7.7`             | `removeParticipant` on LiveKit + socket close + a short instance denylist so they cannot rejoin the same tick                                                             |
| `FR-7.8`             | `bans` table with optional `expires_at`, checked at join                                                                                                                  |
| `FR-7.9`             | `FORCE_TRANSFORM` with `reason: "moderation"` — the same override portals use                                                                                             |
| `FR-7.10`            | Actions apply to live state immediately, not on next join                                                                                                                 |
| `FR-7.11`–`FR-7.15`  | `AccessPolicy` on the Space: locked, password hash, allowlist, capacity. Evaluated at join; changes affect new entries immediately                                        |
| `FR-7.16`, `FR-7.18` | `blocks` table, enforced **inside `resolveAudience()`** — so a block is one more input to the function Phases 2, 3 and 5 already use, rather than a parallel filter       |
| `FR-7.17`            | `reports` table with location and context captured at filing time                                                                                                         |
| `FR-7.19`, `FR-7.20` | `audit_log`, append-only by database grant **and** by a trigger — the grant stops the application, the trigger stops a superuser, which the default Compose deployment is |

### Bans and guests

`FR-7.8` is clean for accounts and genuinely weak for guests, which the Rules section already
anticipates by asking for _"available identifying signals, with known limitations documented"_.

Guest bans key on a persistent browser fingerprint cookie plus IP. **Documented limitations:**
clearing cookies defeats it, a different browser defeats it, and shared corporate NAT means an
IP ban can catch bystanders. For an internal tool this is acceptable — the real remedy for a
guest is requiring accounts (`FR-6.8`), and the UI should say so at the moment an admin bans a
guest.

### Rules

- **Force-mute overrides self-unmute** until lifted. That is what revoking `canPublish` buys.
- **Blocks are symmetric enough to prevent harassment** but must not imply the blocker is
  offline — they remain visible in presence, just silent.
- **Capacity interacts with Phase 8 instancing.** `FR-7.14` and `FR-8.8` must agree: refuse or
  shard, one configured policy, not two independent checks.
- **The owner role is removable only by explicit transfer.** Guard this specifically; a generic
  "change role" endpoint will otherwise let an admin orphan a Space.

### Risks and sharp edges

1. **The unguarded WebSocket handler.** Stated above; it is the single most likely way this phase
   ships broken.
2. **`audit_log` append-only is a grant, not a convention.** Without the grant, `FR-7.20`'s
   tamper-evidence is a comment in the code. Built, this needed a **second** mechanism: a superuser
   bypasses grants entirely, and under Compose the application connects as the database owner — so
   there is a `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger as well. See
   [ADR 0013](../docs/adr/0013-roles-capabilities-and-audit.md).

   The interceptor in the table above did not survive contact either, and for a reason worth
   recording: a NestJS interceptor cannot see WebSocket frames, and mute, kick, ban and respawn all
   arrive as frames. A log silent about exactly the actions people care about is worse than no log,
   because it looks complete. The calls are explicit, and made _after_ the action succeeds.

3. **Blocks belong in `resolveAudience()`.** Filtering blocked users in the UI leaves audio
   flowing and only hides it.
4. **Moderation must reach a reconnecting target.** A kicked or banned identity presenting a
   valid resume token must be refused; the ban check belongs in the resume path too, not only in
   fresh joins.

### References

[ADR 0013](../docs/adr/0013-roles-capabilities-and-audit.md) — the three decisions this phase
defers, settled: how authorization is enforced, how bans key off identity, and where the audit log
lives ·
[ADR 0006](../docs/adr/0006-media-livekit-sfu.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[ADR 0011](../docs/adr/0011-auth-local-accounts.md) ·
[architecture.md](../docs/architecture.md#media-precedence--resolving-fr-319-and-fr-320) ·
[nfr.md](nfr.md) ·
[wire-protocol.md](protocol/wire-protocol.md)
