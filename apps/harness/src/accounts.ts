/**
 * The harness's HTTP half — phase 6.
 *
 * Every scenario before this one asserted against WebSocket frames alone,
 * because everything before this phase happened there. Accounts do not: they are
 * created over REST and *used* on the socket, and `FR-6.18` is precisely the
 * seam between the two. A scenario that could only see one side could not test
 * it.
 *
 * ── Skipping, and why it is not cheating ────────────────────────────────────
 *
 * Accounts need a database. The README promises development works without
 * Docker, and the harness is documented as needing neither LiveKit nor Postgres.
 * So `probeAccounts` asks the server whether accounts exist, and the phase 6
 * scenarios skip — loudly, by name — when they do not. A skipped scenario says
 * so in the output; it does not pass quietly, which would be the actual cheat.
 */

import type {
  AccessPolicyDto,
  AccessPolicyUpdate,
  AccountDto,
  AuthConfigDto,
  BanDto,
  InviteDto,
  InvitePreviewDto,
  MapCreateRequest,
  MapRecordDto,
  MapUpdateRequest,
  ModerationOverviewDto,
  ReportDto,
  Role,
  SpaceOverviewDto,
} from '@hubitat/protocol';

/** Derived from the WebSocket url the runner was given, so one environment
 *  variable still points the whole harness at one server. */
export function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
}

export class SkipScenario extends Error {}

/**
 * A signed-in account, holding its credentials the way the browser client does:
 * the access token in memory, the refresh token in a cookie it never reads.
 */
export class Account {
  accessToken = '';
  private cookie: string | null = null;

  constructor(
    readonly base: string,
    readonly email: string,
    readonly password: string,
  ) {}

  get dto(): AccountDto {
    if (!this.account) throw new Error(`${this.email} has not signed in`);
    return this.account;
  }

  private account: AccountDto | null = null;

  async register(displayName?: string, inviteCode?: string): Promise<AccountDto> {
    const body = await this.call('POST', '/auth/register', {
      email: this.email,
      password: this.password,
      ...(displayName ? { displayName } : {}),
      ...(inviteCode ? { inviteCode } : {}),
    });
    return this.adopt(body);
  }

  async login(): Promise<AccountDto> {
    const body = await this.call('POST', '/auth/login', {
      email: this.email,
      password: this.password,
    });
    return this.adopt(body);
  }

  /** `FR-6.7` — becomes an account while the socket that guest is on stays up. */
  async upgrade(resumeToken: string, inviteCode?: string): Promise<AccountDto> {
    const body = await this.call('POST', '/auth/upgrade', {
      email: this.email,
      password: this.password,
      resumeToken,
      ...(inviteCode ? { inviteCode } : {}),
    });
    return this.adopt(body);
  }

  async me(): Promise<AccountDto> {
    return (await this.call('GET', '/auth/me')) as AccountDto;
  }

  async updateProfile(patch: Record<string, unknown>): Promise<AccountDto> {
    this.account = (await this.call('PATCH', '/auth/me', patch)) as AccountDto;
    return this.account;
  }

  async createInvite(options: { maxUses?: number | null; expiresInHours?: number } = {}) {
    return (await this.call('POST', '/spaces/default/invites', options)) as InviteDto;
  }

  /** `FR-6.8` — the setting an operator can actually change. */
  async setAllowGuests(allowGuests: boolean): Promise<void> {
    await this.call('PATCH', '/spaces/default', { allowGuests });
  }

  // ── Moderation (phase 7) ───────────────────────────────────────────────────

  /** `FR-7.3`, `FR-7.8`, `FR-7.11`–`FR-7.20` in one read. */
  async moderation(): Promise<ModerationOverviewDto> {
    return (await this.call('GET', '/spaces/default/moderation')) as ModerationOverviewDto;
  }

  /** `FR-7.3`. */
  async setRole(accountId: string, role: Exclude<Role, 'owner'>): Promise<void> {
    await this.call('PATCH', `/spaces/default/moderation/members/${accountId}/role`, { role });
  }

  /** `FR-7.11`–`FR-7.15`. */
  async setAccess(patch: AccessPolicyUpdate): Promise<AccessPolicyDto> {
    return (await this.call(
      'PATCH',
      '/spaces/default/moderation/access',
      patch,
    )) as AccessPolicyDto;
  }

  async addToAllowlist(email: string): Promise<AccessPolicyDto> {
    return (await this.call('POST', '/spaces/default/moderation/allowlist', {
      email,
    })) as AccessPolicyDto;
  }

  async removeFromAllowlist(email: string): Promise<AccessPolicyDto> {
    return (await this.call(
      'DELETE',
      `/spaces/default/moderation/allowlist/${encodeURIComponent(email)}`,
    )) as AccessPolicyDto;
  }

  async liftBan(id: string): Promise<BanDto[]> {
    return (await this.call('DELETE', `/spaces/default/moderation/bans/${id}`)) as BanDto[];
  }

  async reviewReport(id: string): Promise<ReportDto[]> {
    return (await this.call(
      'POST',
      `/spaces/default/moderation/reports/${id}/reviewed`,
    )) as ReportDto[];
  }

  // ── Spaces and maps (phase 8) ──────────────────────────────────────────────

  /** `FR-8.15`–`FR-8.17` in one read: the Maps, their policies, their live
   *  occupancy, and any portal left pointing nowhere. */
  async spaceOverview(): Promise<SpaceOverviewDto> {
    return (await this.call('GET', '/spaces/default/overview')) as SpaceOverviewDto;
  }

  /** `FR-8.16` — capacity, instancing policy, overflow rule, archive state. */
  async updateMap(mapId: string, patch: MapUpdateRequest): Promise<MapRecordDto> {
    return (await this.call('PATCH', `/spaces/default/maps/${mapId}`, patch)) as MapRecordDto;
  }

  /** `FR-8.15`. */
  async createMap(body: MapCreateRequest): Promise<MapRecordDto> {
    return (await this.call('POST', '/spaces/default/maps', body)) as MapRecordDto;
  }

  /** `FR-8.17` — the confirmation is the Map's own slug, typed. */
  async deleteMap(mapId: string, confirm: string): Promise<{ deleted: string }> {
    return (await this.call('DELETE', `/spaces/default/maps/${mapId}`, { confirm })) as {
      deleted: string;
    };
  }

  /**
   * The status rather than the body, for the routes `AC-7.1` expects to be
   * **refused**.
   *
   * `NFR-34` is about both transports reaching the same answer, so a scenario
   * has to be able to assert an HTTP 403 as precisely as it asserts a
   * `forbidden` frame — and a helper that threw would make "refused correctly"
   * and "the server fell over" the same result.
   */
  async tryCall(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; message: string }> {
    const response = await this.raw(method, path, body);
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    return { status: response.status, message: payload?.message ?? '' };
  }

  /**
   * The parsed body on success, `null` on any refusal — phase 9.
   *
   * `tryCall` above answers "what status did that get", which is what a scenario
   * asserting a *refusal* needs. The editor scenarios need the opposite for the
   * calls that are supposed to work: the whole editor state comes back from four
   * different routes, and a typed wrapper per route would be four methods with
   * one caller each.
   */
  async tryJson(method: string, path: string, body?: unknown): Promise<unknown | null> {
    const response = await this.raw(method, path, body);
    if (!response.ok) return null;
    return response.status === 204 ? null : response.json();
  }

  /** Returns the HTTP status rather than throwing, because a *refused*
   *  redemption is what `AC-6.4` asserts. */
  async tryRedeem(code: string): Promise<{ status: number; message: string }> {
    const response = await this.raw('POST', `/invites/${code}/redeem`);
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (response.ok) this.account = body as unknown as AccountDto;
    return { status: response.status, message: body?.message ?? '' };
  }

  private adopt(body: unknown): AccountDto {
    const session = body as { accessToken: string; account: AccountDto };
    this.accessToken = session.accessToken;
    this.account = session.account;
    return session.account;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.raw(method, path, body);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${method} ${path} → ${response.status} ${detail.slice(0, 200)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    const response = await fetch(this.base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

    // The refresh cookie, kept the way a browser would so rotation can be
    // exercised end to end.
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      if (pair?.startsWith('hubitat_refresh=')) {
        this.cookie = pair.endsWith('=') ? null : pair;
      }
    }
    return response;
  }
}

/**
 * A fresh, never-before-used address.
 *
 * The harness runs against a live server whose database persists between runs,
 * so a fixed address would collide with yesterday's account on the second run
 * and the failure would read as a registration bug.
 */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@harness.local`;
}

/**
 * A member of the Space, shared by every phase 6 scenario that needs one.
 *
 * ── Why this is a fixed address, when everything else here is unique ────────
 *
 * Membership cannot be conjured. `FR-6.13` says an invite is how you get it, and
 * the only exception is the founding account on a Space that has none — which is
 * a bootstrap, not a back door. So a scenario that needs to *issue* an invite
 * needs somebody who already belongs.
 *
 * A unique address per run cannot be that somebody: it would be the founder on
 * the first run and a stranger on every run after, and the scenarios would pass
 * once and then fail for a reason that has nothing to do with the code. A fixed
 * address is the founder on the first run and signs back in as the same member
 * on all the others — which is exactly `FR-6.15`, so the arrangement is also
 * the thing being relied upon.
 *
 * Established from `requireAccounts`, before any scenario registers anything, so
 * the founding slot is never taken by an incidental account.
 */
const MEMBER_EMAIL = 'harness-member@harness.local';
const MEMBER_PASSWORD = 'harness-member-passphrase-1234';

let sharedMember: Account | null = null;

/**
 * Throws `SkipScenario` when this server has no accounts, or when its Space has
 * members but not ours — see the header.
 */
export async function requireAccounts(
  wsUrl: string,
): Promise<{ base: string; config: AuthConfigDto; member: Account }> {
  const base = httpBase(wsUrl);
  const response = await fetch(`${base}/auth/config`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`GET /auth/config → ${response.status}`);

  const config = (await response.json()) as AuthConfigDto;
  if (!config.accountsEnabled) {
    throw new SkipScenario(
      'accounts are disabled on this server (no database). Start Postgres and set ' +
        'ACCOUNTS=auto, or run: docker compose up -d postgres',
    );
  }

  return { base, config, member: await ensureMember(base) };
}

async function ensureMember(base: string): Promise<Account> {
  if (sharedMember) return sharedMember;

  const member = new Account(base, MEMBER_EMAIL, MEMBER_PASSWORD);

  // Sign in if this database has seen a previous run; register otherwise. Which
  // of the two happened is not interesting — that it ends up a member is.
  try {
    await member.login();
  } catch {
    await member.register('Harness Member');
  }

  if (member.dto.memberships.length === 0) {
    throw new SkipScenario(
      `${MEMBER_EMAIL} exists but is not a member of this space, so the invite and ` +
        `guest-policy scenarios cannot run. This happens when the space was populated by ` +
        `something other than the harness. Redeem an invite for that address, or reset the ` +
        `database: docker compose down -v && docker compose up -d postgres`,
    );
  }

  sharedMember = member;
  return member;
}

export async function previewInvite(base: string, code: string): Promise<InvitePreviewDto> {
  const response = await fetch(`${base}/invites/${code}`, { signal: AbortSignal.timeout(5000) });
  return (await response.json()) as InvitePreviewDto;
}
