# Phase 6 — Accounts, Identity & Membership

## Overview

**Goal.** Turn ephemeral guests into durable identities: local accounts with login,
persistent profiles, invites, and membership of a Space — while still allowing guest access.

**Value.** Persistence unlocks everything that should outlast a session — your avatar, your
name, who belongs to a space, and (later) your roles. It also gates who can get in.

**Depends on.** Phase 1 (sessions/identity), and it gives durable backing to identity used by
Phases 4 (avatar), 5 (DMs/history), 7 (roles), 8 (membership).

**Delivers.** A user can create a local account, log in, keep a profile and avatar across
sessions, join a Space via an invite or code, and the system distinguishes members from guests.

> **Explicitly excluded:** single sign-on, external identity providers, and social login.
> This phase is local accounts + guests only. SSO is deferred for the whole project.

---

## In scope

- Local account creation and login (self-hosted credential auth).
- Guest access, with an option to upgrade a guest into an account.
- Persistent profile (display name, avatar, status preferences).
- Invite links / join codes for a Space.
- Space membership (member vs. guest).
- Session/auth lifecycle (stay logged in, log out) and password recovery basics.

## Out of scope

- **SSO / OIDC / social login — deferred for the entire project.**
- Roles, capabilities, and moderation (Phase 7) — this phase only establishes _who_ someone is
  and _that they belong_, not _what they can do_ beyond the member/guest distinction.
- Organization/Space management UI and multi-map structure (Phase 8).

---

## Functional Requirements

### Local accounts

- **FR-6.1** A user can create a local account using a self-hosted credential (e.g., email or
  username plus a secret), without any external identity provider.
- **FR-6.2** A user can log in with their credentials and is recognized as the same identity
  across sessions and devices.
- **FR-6.3** Credentials are stored securely (secrets never stored in plaintext; verification
  done safely). Exact mechanism deferred, but the requirement to never store recoverable secrets stands.
- **FR-6.4** A user can log out, ending their authenticated session.
- **FR-6.5** A user can recover/reset access if they lose their secret, through a safe
  self-hosted flow (mechanism deferred).

### Guests

- **FR-6.6** A user can enter as a guest without creating an account, retaining the Phase 1
  ephemeral identity behavior.
- **FR-6.7** A guest can upgrade to a full account, carrying over their current session identity
  (e.g., chosen display name and avatar) where possible.
- **FR-6.8** Whether guests are allowed is configurable per Space (a Space can require accounts).

### Profile & persistence

- **FR-6.9** An account has a persistent profile including at least display name and avatar
  appearance (from Phase 4), retained across sessions.
- **FR-6.10** Profile changes persist and are reflected the next time the user appears.
- **FR-6.11** The identity referenced by other phases (avatar ownership, DM target, role holder)
  is the durable account identity for logged-in users, and the ephemeral one for guests.

### Invites & membership

- **FR-6.12** A Space can produce invite links and/or join codes that let a user join the Space.
- **FR-6.13** Joining via an invite makes the user a **member** of that Space; entering without
  membership (where allowed) makes them a **guest** of that Space.
- **FR-6.14** Invites can be limited (e.g., expiry and/or single-use vs. reusable) — at least one
  bound mechanism is required.
- **FR-6.15** Membership is durable: a returning member is recognized without re-invitation.
- **FR-6.16** A user can be a member of multiple Spaces; their account is shared across them.

### Session lifecycle

- **FR-6.17** A logged-in user remains authenticated across reconnects/refreshes until they log
  out or their session expires.
- **FR-6.18** Authenticated state is what binds a live presence (Phase 1 session) to a durable
  identity.

---

## Data Concepts

- **DC-6.1 Account** — durable identity: credential reference, profile, the Spaces it belongs to.
- **DC-6.2 Profile** — display name, avatar appearance, status preferences; owned by an Account
  (or transiently by a guest).
- **DC-6.3 Guest Identity** — ephemeral, session-scoped identity; upgradeable to an Account.
- **DC-6.4 Membership** — the relationship between an Account and a Space (member), with the date
  joined; distinct from being a transient guest of a Space.
- **DC-6.5 Invite** — a link/code granting membership to a Space, with its limits (expiry/uses).
- **DC-6.6 Auth Session** — the authenticated lifetime of a logged-in user.

---

## Rules & Edge Cases

- Guest-to-account upgrade must not lose the user's place/state mid-session where avoidable.
- A Space configured to disallow guests must reject guest entry with a clear message and an
  invite path.
- Invites that are expired/used must be rejected clearly.
- Logging out must end the authenticated session everywhere it should, and return the user to a
  guest/login state, not a broken one.
- Identity used elsewhere (DMs, avatar, roles) must resolve consistently to the durable account
  for logged-in users.

---

## Acceptance Criteria

- **AC-6.1** A user creates a local account, logs out, logs back in, and finds the same profile
  and avatar — no external provider involved.
- **AC-6.2** A guest can enter (where allowed) and later upgrade to an account, keeping their name
  and avatar.
- **AC-6.3** An invite link/code grants Space membership; a returning member is recognized without
  a new invite.
- **AC-6.4** An expired or used-up invite is rejected with a clear message.
- **AC-6.5** A Space set to require accounts blocks guest entry and points to login/invite.
- **AC-6.6** A logged-in user stays logged in across refresh/reconnect and can log out cleanly.

---

## Non-Goals & Deferred

- **SSO / external identity providers / social login — deferred for the whole project.**
- Roles and capabilities beyond member/guest (Phase 7).
- Space/org management surfaces (Phase 8).
- **Deferred decisions:** credential mechanism, secret handling, session token approach, and
  recovery flow specifics are chosen later; this spec fixes the required behavior and guarantees.

---

## Implementation Notes

> **Non-normative.** The requirements above are the authority on behavior.
> See [`docs/adr/`](../docs/adr/README.md) and [`docs/architecture.md`](../docs/architecture.md).

### A note on the SSO exclusion

This project is deployed as an **internal company tool** — the one context where corporate SSO is
normally mandatory. The exclusion above was therefore re-examined explicitly rather than followed
by default, and the decision was to keep the spec: local accounts only. Recorded in
[ADR 0011](../docs/adr/0011-auth-local-accounts.md).

The consequence is deliberate and worth stating plainly: **nothing here is designed to accept an
external subject.** If SSO is ever required it is a new phase, not a patch. We chose that over a
speculative pluggable-provider abstraction, which without a concrete second implementation
usually turns out to be the wrong shape.

### Requirement mapping

| Requirement          | Implementation                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FR-6.1`, `FR-6.2`   | `Account` entity; `@nestjs/passport` with `passport-local`                                                                                                                                                         |
| `FR-6.3`             | **argon2id** at the OWASP floor — 19456 KiB memory, 2 iterations, parallelism 1. Only the hash is stored, never anything recoverable                                                                               |
| `FR-6.4`             | Logout revokes the refresh-token family and clears the cookie                                                                                                                                                      |
| `FR-6.5`             | Single-use expiring token over SMTP. **The only outbound network dependency in the product, and it is optional** — an operator can disable it and reset administratively. Mailpit ships in Compose for development |
| `FR-6.6`             | Guests keep the Phase 1 ephemeral path unchanged                                                                                                                                                                   |
| `FR-6.7`             | Upgrade copies the in-memory session payload (display name, avatar appearance) into the new `Profile` **without dropping the WebSocket**, so the user keeps their place                                            |
| `FR-6.8`             | `Space.allowGuests`, checked at join                                                                                                                                                                               |
| `FR-6.9`, `FR-6.10`  | `Profile` entity with `avatar_appearance jsonb` — the durable home for what Phase 4 kept in session                                                                                                                |
| `FR-6.11`            | Identity resolves to the account for logged-in users, the ephemeral session for guests. One resolver, used everywhere                                                                                              |
| `FR-6.12`–`FR-6.14`  | `Invite` entity with `expires_at`, `max_uses`, `uses`                                                                                                                                                              |
| `FR-6.15`, `FR-6.16` | `Membership` join table; an account may hold many                                                                                                                                                                  |
| `FR-6.17`            | 15-minute access JWT held in memory + opaque refresh token in an `httpOnly` `SameSite=Lax` `Secure` cookie, **rotated on every use**                                                                               |
| `FR-6.18`            | The WebSocket handshake resolves the access token to an identity **before** the connection joins a world                                                                                                           |

### Two things that are easy to get wrong

**Invite redemption is a real race.** `FR-6.14` allows single-use invites, and two people
clicking the same link at the same moment is not hypothetical. Redemption runs inside a
transaction with `SELECT ... FOR UPDATE` on the invite row. Checking `uses < max_uses` and then
incrementing without a lock will over-issue.

**Refresh-token rotation needs reuse detection.** When a rotated token is presented a second
time, the whole family is invalidated. Without this, rotation is theatre — a stolen token stays
valid alongside the legitimate one and nothing ever notices.

### Rules

- **Guest upgrade must not lose the user's place.** It is an HTTP call alongside a live socket,
  not a reload.
- **A guest-disallowed Space rejects with a clear message and an invite path**, never a generic
  denial.
- **Expired or exhausted invites are rejected distinctly** — "this invite has expired" and "this
  invite has already been used" are different problems for the user.

### Risks and sharp edges

1. **argon2 is a native module** and must compile in the container image. Worth knowing before
   the first Docker build fails at an unhelpful moment.
2. **A 15-minute access token will expire mid-meeting.** The client needs transparent
   refresh-and-retry covering both HTTP and the WebSocket reconnect path, or users are silently
   logged out of long sessions.
3. **Phase 1 wrote nothing to the database.** This is where persistence actually starts, so the
   first real migration lands here — the empty initial migration from Phase 1 exists precisely so
   this is not the first time the path is exercised.
4. **Bans (Phase 7) key off account identity.** Guests cannot be banned reliably; that limitation
   is inherited and documented there, not solved here.

### References

[ADR 0011](../docs/adr/0011-auth-local-accounts.md) ·
[ADR 0008](../docs/adr/0008-persistence-postgres-typeorm.md) ·
[tuning-defaults.md](conventions/tuning-defaults.md) ·
[nfr.md](nfr.md)
