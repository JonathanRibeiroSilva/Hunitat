# Protocol — HTTP API

**Status:** normative · **Applies to:** phase 6 onward · **Implemented by:** `apps/api/src/auth`,
`apps/api/src/moderation`, `packages/protocol/src/auth.ts`, `packages/protocol/src/moderation.ts`

The companion to [wire-protocol.md](wire-protocol.md), and it exists for the same reason: the phase
specs describe _what_ must happen and never _how_, so the shapes have to be fixed somewhere or the
client and the server will spell them differently.

Everything before phase 6 happened on the WebSocket. Accounts cannot: a person has to be able to
reset a password from a link in an email with no world open, follow an invite before they have an
identity to open one with, and — crucially — **sign in without dropping the socket they are already
standing in** (`FR-6.7`). None of those fit inside a connection that requires a `JOIN` first.

Request bodies are Zod schemas exported from `packages/protocol/src/auth.ts` and validated on
receipt, exactly as JSON frames are on the socket (`NFR-31`). The schemas also **normalise**: an
email is lowercased and trimmed, an invite code uppercased. Everything downstream may assume it.

---

## The two credentials

| Credential        | Form                       | Where it lives                                  | Lifetime                                              |
| ----------------- | -------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| **Access token**  | signed JWT                 | response body → client **memory**               | `ACCESS_TOKEN_TTL_MIN` (15 min)                       |
| **Refresh token** | opaque, 256 bits of CSPRNG | `httpOnly` cookie, `Path=/auth`, `SameSite=Lax` | `REFRESH_TOKEN_TTL_DAYS` (30 d), rotated on every use |

Chosen in [ADR 0011](../../docs/adr/0011-auth-local-accounts.md). Three properties are load-bearing
and each is a rule rather than a preference:

**The access token is never written to `localStorage`.** It expires in fifteen minutes and there is
nothing to gain from a store that outlives the tab and that any injected script can read.

**The refresh token is never readable by JavaScript.** `httpOnly` is what makes that true of the
attacker's script as well as ours. It is scoped to `/auth` so the browser attaches it to five
endpoints rather than to every request the application makes.

**Only the digest of the refresh token is stored.** SHA-256, not argon2: the input is 256 bits of
CSPRNG output, so there is no guessable structure for a slow hash to defend, and a slow hash on the
refresh path would cost 50 ms on every request made after an expiry.

### Rotation, reuse, and leeway

Every successful refresh consumes its token and issues a successor in the same **family** — one
family per sign-in. Rotation without reuse detection would be decorative, so:

- A consumed token presented **later than `REFRESH_REUSE_LEEWAY_MS`** revokes the whole family,
  including the legitimate holder's current token. One of the two parties holding it is a thief and
  the server cannot tell which, so the session ends for both and the real owner signs in again.
- A consumed token presented **within** that window is treated as one client racing itself. Two
  browser tabs restored at the same instant read one cookie out of a shared jar and both refresh
  before either `Set-Cookie` has landed; revoking there would sign somebody out of both tabs for
  opening two tabs, which breaks `FR-6.17` in the ordinary case to defend against an attack that is
  not happening.

The cost is stated plainly: a thief replaying a token inside the same few seconds as its owner is
not caught. That window is far narrower than the alternative, which is having no rotation at all
because it made the product unusable with two tabs.

### Cookie attributes

`Secure` is decided per request under `AUTH_COOKIE_SECURE=auto`, from `req.secure` or
`x-forwarded-proto`. Neither fixed answer is right everywhere: always-on silently discards the
cookie on plain HTTP against a LAN address — sign-in appears to work and the first refresh 401s —
and always-off puts a bearer credential on the wire in cleartext.

`SameSite=Lax` is correct while the client and the api share a registrable domain, which includes
`localhost:5173` → `localhost:3000` (same **site** despite being cross-origin). Genuinely different
domains need `AUTH_COOKIE_SAMESITE=none`, which forces `Secure`.

**A cookie must be cleared with the same attributes it was set with.** Name, path, domain and
`Secure` all participate in the match; getting one wrong leaves the old cookie in place, so the
client keeps presenting a revoked token and every refresh 401s — a failure that looks exactly like
a broken session and has nothing to do with sessions.

---

## Endpoints

`✓` = requires `Authorization: Bearer <access token>`.

### Identity

| Method  | Path                           | Auth | Requirement | Notes                                                 |
| ------- | ------------------------------ | :--: | ----------- | ----------------------------------------------------- |
| `GET`   | `/auth/config`                 |      | `FR-6.8`    | What this server allows. Fetched before any form      |
| `POST`  | `/auth/register`               |      | `FR-6.1`    | May carry `inviteCode` and an `appearance`            |
| `POST`  | `/auth/login`                  |      | `FR-6.2`    |                                                       |
| `POST`  | `/auth/upgrade`                |      | `FR-6.7`    | Guest → account, in place. Requires a `resumeToken`   |
| `POST`  | `/auth/refresh`                |      | `FR-6.17`   | Cookie only. 200 with a new session, or 401 and clear |
| `POST`  | `/auth/logout`                 |      | `FR-6.4`    | Revokes the family, not just the token presented      |
| `GET`   | `/auth/me`                     |  ✓   | `FR-6.9`    | Profile and every membership                          |
| `PATCH` | `/auth/me`                     |  ✓   | `FR-6.10`   | Any subset of name, appearance, status preference     |
| `POST`  | `/auth/password-reset/request` |      | `FR-6.5`    | **Always 202** — see below                            |
| `POST`  | `/auth/password-reset/confirm` |      | `FR-6.5`    | Single-use, expiring; revokes every session           |

### Spaces and invites

| Method   | Path                        | Auth | Requirement | Notes                                             |
| -------- | --------------------------- | :--: | ----------- | ------------------------------------------------- |
| `GET`    | `/invites/:code`            |      | `AC-6.4`    | Preview before acting. Deliberately vague         |
| `POST`   | `/invites/:code/redeem`     |  ✓   | `FR-6.13`   | Returns the account; membership is what changed   |
| `POST`   | `/spaces/:slug/invites`     |  ✓   | `FR-6.12`   | Members only                                      |
| `GET`    | `/spaces/:slug/invites`     |  ✓   | —           | Including spent and expired ones                  |
| `DELETE` | `/spaces/:slug/invites/:id` |  ✓   | —           | Withdraw a link that went to the wrong list       |
| `PATCH`  | `/spaces/:slug`             |  ✓   | `FR-6.8`    | `allowGuests`. Needs `manage-access` from phase 7 |

`GET /invites/:code` is unauthenticated **by necessity**: somebody following an invite link usually
has no account yet, which is the entire point of the link.

Membership was the only authorization check in phase 6, because member-versus-guest was the only
distinction that phase defined (`FR-6.13`).

### Moderation — phase 7

Every route here requires `Authorization: Bearer` **and** a capability from the matrix in
`packages/protocol/src/moderation.ts`. The same matrix guards the WebSocket path, which is what
`NFR-34` actually asks for: one set of rules, not one decorator.

| Method   | Path                                               | Capability           | Requirement         |
| -------- | -------------------------------------------------- | -------------------- | ------------------- |
| `GET`    | `/spaces/:slug/moderation`                         | any signed-in        | —                   |
| `PATCH`  | `/spaces/:slug/moderation/members/:accountId/role` | `manage-roles`       | `FR-7.3`            |
| `POST`   | `/spaces/:slug/moderation/transfer-ownership`      | `transfer-ownership` | Phase 7 Rules       |
| `PATCH`  | `/spaces/:slug/moderation/access`                  | `manage-access`      | `FR-7.11`–`FR-7.15` |
| `POST`   | `/spaces/:slug/moderation/allowlist`               | `manage-access`      | `FR-7.13`           |
| `DELETE` | `/spaces/:slug/moderation/allowlist/:email`        | `manage-access`      | `FR-7.13`           |
| `POST`   | `/spaces/:slug/moderation/bans`                    | `ban`                | `FR-7.8`            |
| `DELETE` | `/spaces/:slug/moderation/bans/:id`                | `ban`                | `FR-7.8`            |
| `POST`   | `/spaces/:slug/moderation/reports/:id/reviewed`    | `review`             | `FR-7.17`           |

**`GET …/moderation` is open to any signed-in account, and returns different things to different
people.** A member gets their own role, their capability list, the access policy and empty arrays;
somebody with `review` gets the members, bans, reports and audit log as well. That is the honest
answer rather than a 403, and it is what lets a client decide whether to offer the panel at all
without a second endpoint to ask.

One response rather than six, because five of the six are useless alone: a member list with no roles,
or a ban list with no audit trail, is a view somebody has to reconcile by hand.

**What is deliberately not here:** mute, kick, respawn, block and report. Each addresses a **session**
— somebody standing in the room — and `FR-7.10` requires the effect immediately rather than on their
next join. They are WebSocket frames; see [wire-protocol.md](wire-protocol.md).

The split is the same one phase 6 drew and for the same reason: a role outlives every session, a ban
must be issuable against somebody who logged off an hour ago, and an access policy is read at the door
by people who are not through it yet. None of that fits on a connection that requires a `JOIN` first.

### The capability matrix

| Capability           | guest | member | admin | owner |
| -------------------- | :---: | :----: | :---: | :---: |
| `block`, `report`    |   ✓   |   ✓    |   ✓   |   ✓   |
| `manage-invites`     |       |   ✓    |   ✓   |   ✓   |
| `moderate`, `ban`    |       |        |   ✓   |   ✓   |
| `manage-access`      |       |        |   ✓   |   ✓   |
| `review`             |       |        |   ✓   |   ✓   |
| `manage-roles`       |       |        |       |   ✓   |
| `transfer-ownership` |       |        |       |   ✓   |

Higher roles include lower-role abilities (`FR-7.2`), and the matrix is **computed** as a running
union rather than written out four times — the fourth list is where somebody eventually forgets to
repeat an entry.

Two rules on top of the matrix:

- **Rank is strict.** An actor may only act on somebody of strictly lower rank. That is `FR-7.3`'s
  "admins cannot remove the owner" plus the thing it does not say: two admins cannot moderate each
  other, and nobody can moderate themselves.
- **`owner` is never assignable.** `PATCH …/role` refuses it at the schema and again in the service.
  Ownership moves only through `POST …/transfer-ownership`, which is the Phase 7 Rules' "explicit
  ownership-transfer path" — a generic role endpoint that happened to accept `owner` is exactly how a
  Space ends up with two of them or none.

**Roles are resolved per request, never carried on the access token.** A token lives
`ACCESS_TOKEN_TTL_MIN` (15 minutes); a role baked into one keeps working for fifteen minutes after it
is revoked, which would make `FR-7.3` advisory.

---

## Rules that are not obvious from the table

### Nothing here may be used to enumerate accounts

For an internal company tool, "does this address have an account" is a staff list.

- `POST /auth/login` answers identically for an unknown address and a wrong password, **and spends
  the same time on both**. The unknown-address path hashes a throwaway string, because otherwise it
  answers in 2 ms where a known address takes 60 and the difference is a reliable oracle.
- `POST /auth/password-reset/request` answers **202 for every address**, including addresses with no
  account and every case where the relay is unreachable. A failure there must not become a 500,
  because a 500 on one path and a 202 on the other gives the game away.
- `GET /invites/:code` returns `reason: "unknown"` for an invented code, a malformed one and a real
  one that has been revoked — and attaches a Space name only to an invite that would actually work.

### Refusals are specific where the recovery differs

The Phase 6 Rules require expired and used-up invites to read as different problems, because one
needs a fresh link from the same person and the other needs a link at all. They are distinct
`reason` values all the way to the wire and distinct sentences in the client.

The same applies to the two ways a socket can be refused (see wire-protocol.md): `guests-not-allowed`
is "this space requires an account", `auth-required` is "your token did not work". A client cannot
offer the right next step in response to a merged code.

### Status codes carry meaning

| Code  | Means                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` | The credential is missing, expired or rejected. **The client's correct response is to refresh and retry** — this is what makes a 15-minute token survivable |
| `403` | Authenticated, and not allowed. A non-member creating an invite; a member changing access policy. Retrying will not help                                    |
| `409` | The request conflicts with existing state: an address already registered, a password too short                                                              |
| `422` | Well-formed, and refused by state: an invite that is expired, exhausted or revoked                                                                          |
| `503` | Accounts are not available on this server because it has no database. A configuration fact, not a failure                                                   |

`404` is deliberately rare. It confirms what exists.

### Registering with a bad invite still registers

Somebody who followed a stale link and typed a password has created the account they asked for.
Failing the whole request would leave them unable to try again with the address they just used — so
the refusal is logged, they arrive as a non-member, and the client tells them which of the two
things happened.

---

## Running without a database

`ACCOUNTS=auto` (the default) turns every route in this document into `503` when no database is
reachable, and `GET /auth/config` reports `accountsEnabled: false` so the client never renders a
form that cannot succeed. Guests still enter, which is what every build before phase 6 did.

This is not a degraded mode nobody exercises: it is the README's no-Docker development flow, and
the harness asserts it by skipping its phase 6 scenarios with a named reason rather than passing.

`ACCOUNTS=required` refuses to boot instead. That is the production setting, because a deployment
that meant to require accounts and instead admits everybody as a guest is `FR-6.8` inverted.

---

## Related

- [wire-protocol.md](wire-protocol.md) — `JOIN.accessToken`, the `IDENTITY` frame, and the
  `guests-not-allowed` / `auth-required` refusals
- [tuning-defaults.md](../conventions/tuning-defaults.md) — every constant named here
- [phase-06-accounts-membership.md](../phase-06-accounts-membership.md) — the requirements
- [ADR 0011](../../docs/adr/0011-auth-local-accounts.md) — why local accounts, argon2id and a
  rotated refresh cookie, and why no SSO
