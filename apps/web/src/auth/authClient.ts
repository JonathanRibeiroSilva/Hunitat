/**
 * The account client — phase 6.
 *
 * Lives outside React, like `net`, and for the same reason: it owns a credential
 * with a lifetime, and a credential that re-mounts with a component is a
 * credential that gets lost. The store next door holds what the interface
 * renders; this holds the token and the rules about it.
 *
 * ── Where the two credentials live ──────────────────────────────────────────
 *
 * The **access token** is a field on this object. In memory, never in
 * `localStorage` (ADR 0011) — a token in web storage survives the tab and is
 * readable by any script that gets injected into the page, and neither of those
 * is a property worth having for something that expires in fifteen minutes
 * anyway.
 *
 * The **refresh token** is a cookie this code never sees. `credentials:
 * 'include'` on every call is what sends it; `httpOnly` is what stops this file
 * from being able to read it even by accident.
 *
 * ── Refresh-and-retry, in one place ─────────────────────────────────────────
 *
 * A fifteen-minute token *will* expire mid-meeting — ADR 0011 names it as the
 * consequence to plan for. So there is no path here that calls `fetch` directly:
 * every request goes through `authed`, which refreshes once on a 401 and retries.
 * The WebSocket needs the same treatment on its own path, which `net` handles by
 * calling `ensureFresh()` before each `JOIN` (`FR-6.17`).
 */

import {
  type AccessPolicyDto,
  type AccessPolicyUpdate,
  type AccountDto,
  type AssetDto,
  type AssetUploadRequest,
  type AssetUploadTicketDto,
  type AuthConfigDto,
  type AuthSessionDto,
  type AvatarAppearance,
  type BanDto,
  type EditorStateDto,
  type MapDocument,
  type InviteDto,
  type InvitePreviewDto,
  type MapCreateRequest,
  type MapRecordDto,
  type MapUpdateRequest,
  type ModerationOverviewDto,
  type PresenceStatus,
  type ReportDto,
  type Role,
  type SpaceDto,
  type SpaceOverviewDto,
} from '@hubitat/protocol';

/** The same resolution `loadWorld` uses: empty stays relative so a tunnelled dev
 *  server works. See docs/remote-media-testing.md. */
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Refresh this long before the token actually expires.
 *
 * Without a margin the client refreshes only after something has already failed,
 * which turns every fifteen-minute boundary into one visible hiccup. Sixty
 * seconds is comfortably more than a round trip on any network this is deployed
 * on.
 */
const REFRESH_MARGIN_MS = 60_000;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class AuthClient {
  private accessToken: string | null = null;
  private expiresAt = 0;

  /**
   * The refresh in flight, if any.
   *
   * Two components mounting at once, or a burst of requests all hitting an
   * expired token, must produce **one** refresh. Concurrent refreshes each
   * present the same cookie, the second one presents a token the first has
   * already consumed, and the server correctly reads that as reuse and revokes
   * the whole family — signing the user out because their own client raced
   * itself. This promise is what makes that impossible.
   */
  private refreshing: Promise<boolean> | null = null;

  private onSignedOut: (() => void) | null = null;

  /** Called when a refresh fails and the session is genuinely over, so the store
   *  can drop the account rather than showing a signed-in interface with no
   *  credential behind it. */
  bindSignOutHandler(handler: () => void): void {
    this.onSignedOut = handler;
  }

  get token(): string | null {
    return this.accessToken;
  }

  get signedIn(): boolean {
    return this.accessToken !== null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public capabilities
  // ───────────────────────────────────────────────────────────────────────────

  /** What this server allows, fetched before the entry screen renders a form. */
  async config(): Promise<AuthConfigDto> {
    return this.call<AuthConfigDto>('GET', '/auth/config');
  }

  /**
   * `FR-6.17` — "remains authenticated across reconnects/refreshes".
   *
   * Called once at startup. The access token died with the previous page, but
   * the refresh cookie did not, so this is what turns a reload into a continued
   * session rather than a sign-in screen. Silent on failure: not being signed in
   * is the ordinary case, not an error worth showing anybody.
   */
  async restore(): Promise<AccountDto | null> {
    const restored = await this.refresh();
    if (!restored) return null;
    try {
      return await this.me();
    } catch {
      return null;
    }
  }

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    appearance?: AvatarAppearance;
    inviteCode?: string;
  }): Promise<AccountDto> {
    return this.adopt(await this.call<AuthSessionDto>('POST', '/auth/register', input));
  }

  async login(email: string, password: string): Promise<AccountDto> {
    return this.adopt(await this.call<AuthSessionDto>('POST', '/auth/login', { email, password }));
  }

  /**
   * `FR-6.7` — become an account without leaving the world.
   *
   * The resume token is what proves this caller owns the guest session; a
   * session id would not, because every participant in range is told one.
   */
  async upgrade(input: {
    email: string;
    password: string;
    resumeToken: string;
    inviteCode?: string;
  }): Promise<AccountDto> {
    return this.adopt(await this.call<AuthSessionDto>('POST', '/auth/upgrade', input));
  }

  /** `FR-6.4`. The cookie is cleared by the server; the in-memory token is
   *  dropped here. Both halves, or the client goes on presenting a token whose
   *  family has been revoked. */
  async logout(): Promise<void> {
    try {
      await this.call('POST', '/auth/logout');
    } finally {
      this.clear();
    }
  }

  me(): Promise<AccountDto> {
    return this.authed<AccountDto>('GET', '/auth/me');
  }

  /** `FR-6.10`. */
  updateProfile(patch: {
    displayName?: string;
    appearance?: AvatarAppearance;
    statusPreference?: PresenceStatus;
  }): Promise<AccountDto> {
    return this.authed<AccountDto>('PATCH', '/auth/me', patch);
  }

  // ── Invites and the space ──────────────────────────────────────────────────

  /** Unauthenticated: somebody following an invite link usually has no account
   *  yet, which is the entire point of the link. */
  previewInvite(code: string): Promise<InvitePreviewDto> {
    return this.call<InvitePreviewDto>('GET', `/invites/${encodeURIComponent(code)}`);
  }

  /** `FR-6.13`. Returns the account, because its membership list is what
   *  changed. */
  redeemInvite(code: string): Promise<AccountDto> {
    return this.authed<AccountDto>('POST', `/invites/${encodeURIComponent(code)}/redeem`);
  }

  createInvite(
    slug: string,
    options: { maxUses?: number | null; expiresInHours?: number },
  ): Promise<InviteDto> {
    return this.authed<InviteDto>('POST', `/spaces/${slug}/invites`, options);
  }

  listInvites(slug: string): Promise<InviteDto[]> {
    return this.authed<InviteDto[]>('GET', `/spaces/${slug}/invites`);
  }

  revokeInvite(slug: string, id: string): Promise<void> {
    return this.authed<void>('DELETE', `/spaces/${slug}/invites/${id}`);
  }

  /** `FR-6.8` — the setting, changed by somebody who belongs here. */
  setAllowGuests(slug: string, allowGuests: boolean): Promise<SpaceDto> {
    return this.authed<SpaceDto>('PATCH', `/spaces/${slug}`, { allowGuests });
  }

  // ── Moderation (phase 7) ───────────────────────────────────────────────────
  //
  // The durable half. Everything that acts on a *live session* — mute, kick,
  // ban somebody standing in front of you, respawn, block, report — is a
  // WebSocket frame instead, because it needs a session to address and
  // `FR-7.10` requires it to land immediately. See `net.moderate`.

  /** Roles, access policy, bans, reports and the audit log in one response.
   *  What comes back depends on the caller's role, so a member gets their own
   *  capabilities and empty lists rather than a 403. */
  moderationOverview(slug: string): Promise<ModerationOverviewDto> {
    return this.authed<ModerationOverviewDto>('GET', `/spaces/${slug}/moderation`);
  }

  /** `FR-7.3`. `owner` is not accepted — ownership moves through `transferOwnership`. */
  setRole(slug: string, accountId: string, role: Exclude<Role, 'owner'>): Promise<{ role: Role }> {
    return this.authed('PATCH', `/spaces/${slug}/moderation/members/${accountId}/role`, { role });
  }

  /** The Rules' explicit ownership-transfer path. */
  transferOwnership(slug: string, accountId: string): Promise<{ ok: true }> {
    return this.authed('POST', `/spaces/${slug}/moderation/transfer-ownership`, { accountId });
  }

  /** `FR-7.11`–`FR-7.15`. `password: null` clears it; a string sets it. */
  updateAccess(slug: string, patch: AccessPolicyUpdate): Promise<AccessPolicyDto> {
    return this.authed<AccessPolicyDto>('PATCH', `/spaces/${slug}/moderation/access`, patch);
  }

  addToAllowlist(slug: string, email: string): Promise<AccessPolicyDto> {
    return this.authed<AccessPolicyDto>('POST', `/spaces/${slug}/moderation/allowlist`, { email });
  }

  removeFromAllowlist(slug: string, email: string): Promise<AccessPolicyDto> {
    return this.authed<AccessPolicyDto>(
      'DELETE',
      `/spaces/${slug}/moderation/allowlist/${encodeURIComponent(email)}`,
    );
  }

  /** `FR-7.8` against somebody who is not connected. The socket handles the
   *  case where they are. */
  banAccount(
    slug: string,
    input: { accountId: string; reason?: string; durationMinutes?: number },
  ): Promise<BanDto[]> {
    return this.authed<BanDto[]>('POST', `/spaces/${slug}/moderation/bans`, input);
  }

  liftBan(slug: string, id: string): Promise<BanDto[]> {
    return this.authed<BanDto[]>('DELETE', `/spaces/${slug}/moderation/bans/${id}`);
  }

  reviewReport(slug: string, id: string): Promise<ReportDto[]> {
    return this.authed<ReportDto[]>('POST', `/spaces/${slug}/moderation/reports/${id}/reviewed`);
  }

  // ── Spaces and maps — phase 8, `FR-8.15`–`FR-8.17` ────────────────────────
  //
  // The lifecycle half. Navigating between Maps is a WebSocket frame, because it
  // acts on a session and its answer is a whole world; everything here outlives
  // every session and is answered with a row.

  spaceOverview(slug: string): Promise<SpaceOverviewDto> {
    return this.authed<SpaceOverviewDto>('GET', `/spaces/${slug}/overview`);
  }

  createMap(slug: string, body: MapCreateRequest): Promise<MapRecordDto> {
    return this.authed<MapRecordDto>('POST', `/spaces/${slug}/maps`, body);
  }

  updateMap(slug: string, mapId: string, patch: MapUpdateRequest): Promise<MapRecordDto> {
    return this.authed<MapRecordDto>('PATCH', `/spaces/${slug}/maps/${mapId}`, patch);
  }

  /** `FR-8.17` — the confirmation is the Map's own slug, typed. A boolean would
   *  be one mis-click on the wrong row. */
  deleteMap(
    slug: string,
    mapId: string,
    confirm: string,
  ): Promise<{ deleted: string; brokenPortals: unknown[] }> {
    return this.authed('DELETE', `/spaces/${slug}/maps/${mapId}`, { confirm });
  }

  // ── The editor and the asset library — phase 9 ─────────────────────────────
  //
  // `FR-9.21`: every one of these is refused for a role without `manage-maps`,
  // on the server. The editor hides itself from anybody else, which is a
  // courtesy and not the enforcement (`NFR-34`).

  editorState(slug: string, mapId: string): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('GET', `/spaces/${slug}/editor/maps/${mapId}`);
  }

  /** `FR-9.4` — the whole document, with the revision it was edited against.
   *  A 409 means somebody else saved first; the editor reloads rather than
   *  retrying, because retrying is the overwrite `FR-9.22` forbids. */
  saveDraft(
    slug: string,
    mapId: string,
    document: MapDocument,
    revision: number,
  ): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('PUT', `/spaces/${slug}/editor/maps/${mapId}/draft`, {
      document,
      revision,
    });
  }

  discardDraft(slug: string, mapId: string): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('DELETE', `/spaces/${slug}/editor/maps/${mapId}/draft`);
  }

  /** `FR-9.18`. */
  publishMap(slug: string, mapId: string, notes?: string): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('POST', `/spaces/${slug}/editor/maps/${mapId}/publish`, {
      ...(notes ? { notes } : {}),
    });
  }

  /** `FR-9.19` — copy an older version forward. */
  revertMap(
    slug: string,
    mapId: string,
    version: number,
    publish: boolean,
  ): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('POST', `/spaces/${slug}/editor/maps/${mapId}/revert`, {
      version,
      publish,
    });
  }

  /** `FR-9.22` — take the lock, and beat on it while the editor is open. */
  lockMap(slug: string, mapId: string): Promise<EditorStateDto> {
    return this.authed<EditorStateDto>('POST', `/spaces/${slug}/editor/maps/${mapId}/lock`);
  }

  unlockMap(slug: string, mapId: string): Promise<void> {
    return this.authed('DELETE', `/spaces/${slug}/editor/maps/${mapId}/lock`);
  }

  /** `FR-9.11` — a presigned PUT. The bytes go straight to object storage; this
   *  client sends them, and the api never sees them. */
  requestAssetUpload(slug: string, body: AssetUploadRequest): Promise<AssetUploadTicketDto> {
    return this.authed<AssetUploadTicketDto>('POST', `/spaces/${slug}/editor/assets`, body);
  }

  completeAssetUpload(slug: string, assetId: string): Promise<AssetDto> {
    return this.authed<AssetDto>('POST', `/spaces/${slug}/editor/assets/${assetId}/complete`);
  }

  /** `FR-9.14` — blocked, not warned, when a map is standing on it. */
  deleteAsset(slug: string, assetId: string): Promise<void> {
    return this.authed('DELETE', `/spaces/${slug}/editor/assets/${assetId}`);
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  /** `FR-6.5`. Always resolves — the server answers 202 for every address so
   *  that this cannot be used to find out who has an account. */
  requestPasswordReset(email: string): Promise<void> {
    return this.call<void>('POST', '/auth/password-reset/request', { email });
  }

  confirmPasswordReset(token: string, password: string): Promise<void> {
    return this.call<void>('POST', '/auth/password-reset/confirm', { token, password });
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A valid access token, refreshing first if the current one is close to
   * expiry.
   *
   * `net` calls this before every `JOIN`, which is the WebSocket half of
   * refresh-and-retry: a reconnect after a long pause would otherwise present an
   * expired token and be refused with `auth-required`.
   */
  async ensureFresh(): Promise<string | null> {
    if (!this.accessToken) return null;
    if (Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.accessToken;
    await this.refresh();
    return this.accessToken;
  }

  /**
   * One refresh at a time — see `refreshing`.
   *
   * Returns whether there is a usable token afterwards. A failure is not thrown:
   * every caller's response is the same either way, and the one that matters
   * (`restore` at startup) is not an error path at all.
   */
  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const session = await this.call<AuthSessionDto>('POST', '/auth/refresh');
        this.accessToken = session.accessToken;
        this.expiresAt = Date.now() + session.expiresInSeconds * 1000;
        return true;
      } catch {
        // The session is over: the cookie was missing, expired, revoked, or
        // replayed. Clearing here is what stops the interface showing a signed-in
        // state with nothing behind it.
        const wasSignedIn = this.accessToken !== null;
        this.clear();
        if (wasSignedIn) this.onSignedOut?.();
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  private adopt(session: AuthSessionDto): AccountDto {
    this.accessToken = session.accessToken;
    this.expiresAt = Date.now() + session.expiresInSeconds * 1000;
    return session.account;
  }

  private clear(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  /**
   * An authenticated request, with exactly one refresh-and-retry.
   *
   * One, not a loop: if a freshly-minted token is also rejected then the problem
   * is not expiry, and retrying would spin against a server that has already
   * given its answer.
   */
  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureFresh();

    try {
      return await this.call<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 401) throw error;
      if (!(await this.refresh())) throw error;
      return this.call<T>(method, path, body);
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    let response: Response;
    try {
      response = await fetch(API_URL + path, {
        method,
        headers,
        // Without this the refresh cookie is not sent and `FR-6.17` cannot work
        // at all. The server's CORS reflects the origin rather than allowing
        // `*`, because `*` and credentials are incompatible.
        credentials: 'include',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // A network failure and a rejection are different problems and get
      // different messages. "Sign in failed" for an unreachable server sends
      // somebody looking for a typo in a password that was correct.
      throw new AuthError(0, `Could not reach the server. ${String(error)}`);
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new AuthError(
        response.status,
        detail?.message ?? `That request failed (${response.status}).`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export const auth = new AuthClient();
