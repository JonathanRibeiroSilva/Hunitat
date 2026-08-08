# ADR 0011 — Authentication: local accounts, argon2id, JWT + rotated refresh cookie (no SSO)

**Status:** accepted · **Affects:** phases 6, 7

## Context

Phase 6 is unambiguous, twice:

> **Explicitly excluded:** single sign-on, external identity providers, and social login. This
> phase is local accounts + guests only. SSO is deferred for the whole project.

This deserves recording rather than silent obedience, because the deployment context is an
**internal company tool** — the one situation where corporate SSO is normally mandatory. The
question was put explicitly and the answer was to keep the spec: local accounts only.

The requirements themselves are conventional but specific. `FR-6.3` requires that secrets never
be stored recoverably. `FR-6.17` requires authentication to survive reconnects and refreshes.
`FR-6.18` says authenticated state is what binds a live WebSocket presence to a durable
identity. `FR-6.7` requires a guest to become an account while keeping their name and avatar,
mid-session where possible.

## Decision

**Local credentials only.** Username/email plus a secret, verified against
**argon2id** (`argon2` npm package, the OWASP-recommended algorithm and the current
Password Hashing Competition winner).

**Tokens:**

- **Access token** — JWT, short-lived (15 minutes), held in memory by the client, never in
  `localStorage`.
- **Refresh token** — opaque, random, stored hashed in the `refresh_tokens` table, delivered in
  an `httpOnly` `SameSite=Lax` `Secure` cookie, and **rotated on every use**. Reuse of a
  consumed token invalidates the whole family, which is what turns theft into a detectable
  event rather than a silent one.

**WebSocket authentication** happens in the handshake: the client presents its access token, the
server resolves it to an identity before the connection joins a world (`FR-6.18`). Guests
connect with an ephemeral identity and no token.

**Guest upgrade** (`FR-6.7`) copies the in-memory session payload — display name and avatar
appearance — into the new profile without dropping the WebSocket, so the user keeps their place.

**Invite consumption is transactional.** `FR-6.14` allows single-use invites, so redemption runs
inside a transaction with `SELECT ... FOR UPDATE` on the invite row. Two people clicking the
same single-use link simultaneously is a real race, not a theoretical one.

**Password recovery** (`FR-6.5`) uses a single-use, expiring token delivered over SMTP. SMTP is
configurable and optional; Compose ships **Mailpit** for development.

## Consequences

- No dependency on any identity provider. Guiding principle nº1 holds, and the system runs on an
  air-gapped network.
- Password reset is the only outbound network dependency in the whole product, and it is
  optional. An operator can disable it and reset passwords administratively.
- argon2 is a native module and must compile in the container image. Worth knowing before the
  first Docker build fails.
- Short access tokens plus a rotated refresh cookie means an expired token mid-session must be
  refreshed transparently, including on the WebSocket path. The client needs a refresh-and-retry
  wrapper; without it, users get logged out after 15 minutes of a long meeting.
- **If SSO is ever required, this is a new phase, not a patch.** Nothing here is designed to
  accept an external subject. That is the deliberate consequence of following the spec instead
  of hedging.
- Bans (`FR-7.8`) key cleanly off account identity. Guest bans cannot, and fall back to
  fingerprint plus IP with documented limitations — which the Phase 7 rules already anticipate.

## Alternatives rejected

- **OIDC / SAML from the start** (Keycloak, Authentik, or the company's Entra ID) — the normal
  answer for an internal tool, and a direct contradiction of Phase 6. Rejected by explicit
  decision.
- **A pluggable auth-provider abstraction now, SSO later** — a small hedge with real appeal.
  Rejected as speculative generality: an interface designed without a concrete second
  implementation usually turns out to be the wrong shape.
- **bcrypt** — fine and widely deployed, but argon2id resists GPU attacks better and is the
  current recommendation.
- **Session cookies with server-side sessions** — simpler than JWT and would need shared session
  storage the moment there is more than one process. Given [0009](0009-no-redis-in-memory-pgboss.md),
  that store would be Postgres; a stateless access token plus a durable refresh row achieves the
  same with fewer reads per request.
- **Long-lived access tokens without refresh** — simpler, and revocation becomes impossible,
  which breaks Phase 7 bans.
