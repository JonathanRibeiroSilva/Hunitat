# ADR 0013 — Permissions: a shared capability matrix, guarded on both transports, with an append-only audit log

**Status:** accepted · **Affects:** phases 7, 8

## Context

Phase 7 leaves three decisions open by name:

> **Deferred decisions:** how enforcement is implemented authoritatively, how bans key off
> identity, and audit storage are chosen later; this spec fixes the required behavior and
> guarantees.

Each of the three has a failure mode that is invisible from the outside, which is why they are
worth recording rather than settling in a pull request.

**Enforcement.** `NFR-34` requires authorization on **both** HTTP and WebSocket paths, and the
Phase 7 implementation notes name the unguarded gateway handler as the single most likely way the
phase ships broken. The socket carries `EMOTE` and `CHAT_SEND` already; adding moderation frames to
it means a guard on the REST controllers protects nothing a modified client would use.

**Bans.** `FR-7.8` requires banned identities to be unable to re-enter. That is exact for an
account and impossible for a guest, and the Rules ask for the gap to be documented rather than
papered over.

**Audit.** `FR-7.20` asks for a log "tamper-evident enough to be trusted (append-only in intent)".
Intent is not a mechanism, and a log the application can rewrite is a log that says whatever the
last bug wrote.

## Decision

### One matrix, two guards

`CAPABILITIES: Record<Role, Capability[]>` lives in `packages/protocol` — the package the client,
the server and the bots all compile against (ADR 0001). It is **computed** as a running union over
four roles rather than written out four times, so `FR-7.2`'s "higher roles include lower-role
abilities" holds by construction.

Both enforcement points call the same two functions from it:

| Path      | Where                                                      | Asks                               |
| --------- | ---------------------------------------------------------- | ---------------------------------- |
| HTTP      | `RolesGuard` + `@RequireCapability(…)`                     | `hasCapability`, then handler      |
| WebSocket | `ModerationService.authorize`, from the gateway's dispatch | `hasCapability` **and** `outranks` |

The client imports the same matrix to decide which controls to draw. That is a convenience and
never a control: every action it enables is re-checked on the server.

**`outranks` is strict.** `FR-7.3` says admins cannot remove the owner; strictness adds the thing
the requirement does not say and every deployment needs — two admins cannot moderate each other,
and nobody can moderate themselves. Equal rank would make a disagreement between moderators a race
decided by whoever clicked first, and there is no way to undo a ban from the session it removed.

**Roles are read per request, never carried on the access token.** A token lives fifteen minutes
(`ACCESS_TOKEN_TTL_MIN`); a role baked into one keeps working for fifteen minutes after it is
revoked, which makes `FR-7.3` advisory. The cost is one indexed lookup on paths that already did
several.

### Roles live on `memberships`, access policy on `spaces`

Neither gets a table. A role is what an identity _is within a Space_, which is exactly what the
phase 6 membership row records; an access policy is a property of a Space. Separate tables would
make "does this account belong here" and "is this Space locked" questions with two answers, and the
safe default for a missing row is the opposite of the safe default for a missing column.

`guest` is therefore the absence of a membership rather than a stored value, and revoking somebody's
role revokes the row — which is what "revoke" means in `FR-7.3`.

The founding member becomes the **owner** on first sight. Phase 6 already had this bootstrap one
level down: it admitted the first account "because there was nobody to issue an invite", and a Space
whose members are all `member` has nobody who can appoint an admin.

### Bans key off durable identity, and say so when they cannot

| Subject     | Keys on                       | Strength                                                     |
| ----------- | ----------------------------- | ------------------------------------------------------------ |
| **Account** | `account_id`                  | Exact. Survives browsers, networks and reconnects            |
| **Guest**   | browser fingerprint **or** IP | Weak, and documented as weak in the interface that issues it |

The guest form is defeated by clearing site data, by a different browser, and — when it matches on
an address — catches everybody behind the same NAT. All three are stated to the admin at the moment
they ban a guest, together with the real remedy: requiring accounts (`FR-6.8`), which is one
checkbox away in the same panel.

The ban check runs on the **resume path** as well as on fresh joins. A ban that only guarded fresh
joins would last exactly until the target's client reconnected.

A kick additionally sets a ten-second per-identity cooldown, keyed on the fingerprint as well for a
guest — whose identity is scoped to a session the kick has just destroyed. It is a debounce on a
reconnect loop (`NFR-23` backs off from 500 ms), not a sentence.

### The audit log is append-only twice

`audit_log` is `BIGSERIAL`-keyed, timestamped by the database, and protected by **two** mechanisms
because they stop different things:

- **`REVOKE UPDATE, DELETE, TRUNCATE`** stops the application, and any future endpoint that forgets
  this table is not supposed to be writable twice. This is the one that matters for the bug actually
  being defended against.
- **A `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger** stops a superuser, which the grant cannot —
  and `docker-compose.yml` connects as `POSTGRES_USER`, which in the default Compose setup owns the
  database and bypasses grants entirely. Without the trigger, the revoke would be a no-op in
  precisely the deployment this project ships.

Rows store a **verb and a `jsonb` detail blob**, never a sentence. Sentences are built at read time,
so a wording change does not require rewriting rows the database will not let anybody rewrite.

Writing an audit row **never** undoes the moderation it records: a failed write is logged at `error`
and the action stands. The point of the log is accountability, and refusing to act unaccountably
would mean not acting at all.

### Reports are a queue, not a log

`reports` is editable — a report can be marked handled, because a queue that cannot be emptied is a
queue nobody works. Filing one writes no audit row (a user acted); **handling** one does (a moderator
took responsibility).

### Blocks are one more input to `resolveAudience()`

`FR-7.16` is enforced inside the function phases 2, 3 and 5 already use, through a `symmetricBlocks`
helper in `world-core`. Filtering blocked users anywhere else leaves audio flowing and only hides
it — and it is what keeps "who can hear me" and "who my message reaches" agreeing about a block, the
same property the Phase 5 consistency rule buys for distance.

Blocks key on the phase 6 identity string, which makes `FR-7.18`'s durability fall out rather than
need implementing: `acct:<id>` outlives a session and `guest:<session>` does not.

## Consequences

**Accepted:**

- A role lookup on every guarded request. Measured against a fifteen-minute window in which a removed
  admin could still act, this is the right trade.
- Holders of `manage-access` bypass lock, password, allowlist **and capacity**. Without it, an admin
  who locks a Space and then loses their connection has no way back in to unlock it. The ceiling is
  soft by the number of moderators; the alternative is a Space that becomes ungovernable exactly when
  it is busiest.
- Guest bans are weak and will be evaded by anybody who wants to. The product's answer is `FR-6.8`.
- A database administrator can drop the trigger. That is the honest limit of "tamper-evident enough":
  the log defends against accident and against the application, and a DBA is outside its threat model
  as they are for every other table here.
- `FR-7.14` refuses rather than shards. The Phase 7 Rules require capacity and `FR-8.8` to agree
  rather than be decided twice, and there is one instance until phase 8 builds more — so refusing is
  the only policy this build can implement honestly.

**Rejected:**

- **Roles in the JWT.** Removes the per-request lookup and makes revocation take up to fifteen
  minutes. `FR-7.3` is not a suggestion.
- **A NestJS interceptor for the audit log**, which the Phase 7 notes suggest. It cannot see
  WebSocket frames, and the actions `FR-7.19` names — mute, kick, ban, respawn — arrive as frames. A
  log silent about exactly the actions people care about is worse than no log, because it looks
  complete.
- **A permissions table with custom roles.** The Non-Goals rule out "granular custom roles beyond the
  baseline set", and four roles in a constant is a matrix a reviewer can hold in their head.
- **Hashing the Space password with SHA-256** because "it is only a room password". It is typed by
  people, shared out loud, and therefore the credential most likely to be reused in a whole company.
  It gets argon2id like every other password here.
- **Hiding blocked participants from the presence list.** The Rules require a block not to falsely
  imply the blocker is offline, and disappearing is the loudest possible way to break that.

## Related

- [0006](0006-media-livekit-sfu.md) — the two-call force-mute pattern this ADR's `FR-7.5`
  enforcement depends on
- [0008](0008-persistence-postgres-typeorm.md) — migrations, and why the schema is hand-written
- [0011](0011-auth-local-accounts.md) — the identities roles attach to, and the token lifetime that
  makes per-request role resolution necessary
- [phase-07-permissions-moderation.md](../../specs/phase-07-permissions-moderation.md) — the
  requirements
- [nfr.md](../../specs/nfr.md) — `NFR-34`
