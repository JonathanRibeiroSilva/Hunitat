/**
 * Runtime configuration.
 *
 * Several phases require these values to be adjustable without code changes to
 * feature logic (Phase 1 Rules, FR-2.7, Phase 5 Rules, NFR-39). So nothing reads
 * a literal at a call site — everything comes from here, and here reads the
 * environment with the defaults from @hubitat/protocol.
 */

import { TUNING, type ClientTuning } from '@hubitat/protocol';

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} is not a number: "${raw}"`);
  }
  return parsed;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

/**
 * Only the four spellings people actually type.
 *
 * `SPACE_ALLOW_GUESTS=yes` throwing beats it silently reading as false, which
 * would lock every guest out of a Space whose operator believed they had just
 * let them in — `AC-6.5`'s failure, produced by a typo instead of a policy.
 */
function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Environment variable ${key} must be true or false, got "${raw}".`);
}

function choice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(
    `Environment variable ${key} must be one of ${allowed.join(' | ')}, got "${raw}".`,
  );
}

/**
 * Where chat history lives — `FR-5.11`.
 *
 * `auto` is the default and the only one that is not a promise: it uses Postgres
 * when the connection succeeds and falls back to memory when it does not, which
 * keeps the no-Docker development flow in the README working. `postgres` is the
 * production setting — it refuses to boot rather than silently degrading a
 * durable channel to one that empties on restart, which is the failure nobody
 * notices until they go looking for a conversation. `memory` never opens a
 * connection at all.
 */
export type ChatPersistenceMode = 'auto' | 'postgres' | 'memory';

/**
 * Whether accounts are available — phase 6.
 *
 * Deliberately shaped like `CHAT_PERSISTENCE`, because it answers the same
 * question about the same connection and answering it two different ways would
 * be a trap. `auto` runs without accounts when there is no database, which is
 * what keeps the README's no-Docker flow working: guests still join, the entry
 * screen offers no sign-in, and nothing pretends. `required` refuses to boot
 * instead — the production setting, because a deployment that meant to require
 * accounts and silently admits everyone as a guest is `FR-6.8` inverted. `off`
 * never opens a connection for accounts at all.
 */
export type AccountsMode = 'auto' | 'required' | 'off';

export interface RuntimeConfig {
  port: number;
  tickRateHz: number;
  clientSendRateHz: number;
  interpolationBufferMs: number;
  aoiEnterRadiusM: number;
  aoiExitRadiusM: number;
  aoiCellSizeM: number;
  pingIntervalMs: number;
  staleSessionTimeoutMs: number;
  idleTimeoutMs: number;
  resumeTokenTtlMs: number;
  maxBufferedBytes: number;
  maxMessageBytes: number;
  maxInboundMsgsPerSec: number;
  maxDisplayNameChars: number;
  wsHandshakeTimeoutMs: number;
  worldMapId: string;
  worldAssetBaseUrl: string;

  // ── Avatars (phase 4) ─────────────────────────────────────────────────────
  /** Where the avatar model is served from. Separate from the world asset base
   *  because phase 9 moves uploaded assets to object storage and the avatar,
   *  which nobody uploads, stays where it is. */
  avatarAssetBaseUrl: string;
  avatarModelId: string;
  /** FR-4.16 — enforced here, not in the client. */
  emoteMinIntervalMs: number;
  emoteMaxDurationMs: number;
  animationCrossfadeMs: number;
  runAnimationThresholdMps: number;
  nameplateFadeStartM: number;
  nameplateHideM: number;

  // ── Zones and audience (phase 3) ──────────────────────────────────────────
  zoneHysteresisM: number;
  portalCooldownMs: number;
  portalExitClearanceM: number;
  /** Audience falloff. Phase 2 makes these audible; phase 3 already computes
   *  with them, so the numbers the server advertises and the numbers the client
   *  plays back come from one place (ADR 0007). */
  maxAudibleDistanceM: number;
  audioRefDistanceM: number;
  audioRolloffFactor: number;
  spotlightGain: number;
  privateZoneGain: number;

  // ── Spatial media (phase 2) ───────────────────────────────────────────────
  /** FR-2.7 — independent of the audible threshold. */
  maxVisibleDistanceM: number;
  /** Phase 2 Rules — the band that stops subscriptions thrashing at a boundary. */
  audioHysteresisM: number;
  /** FR-2.18 / NFR-20 — per-client stream ceilings. */
  maxConcurrentAudio: number;
  maxConcurrentVideo: number;

  /**
   * LiveKit (ADR 0006). Empty when media is not configured, which is a
   * supported state: Phase 1's development flow runs without Docker, so the
   * server must serve a world with no SFU behind it rather than refuse to boot.
   */
  livekitUrl: string;
  /**
   * The URL handed to BROWSERS, which is not always the one the server uses.
   *
   * Under Compose the server reaches the SFU at `ws://livekit:7880` — a name that
   * resolves only inside the Docker network. Putting that in the grant sends
   * every client to a host it cannot look up, and the failure surfaces as "voice
   * doesn't work in Docker" long after the code that caused it.
   *
   * Defaults to `livekitUrl`, which is correct whenever the two are the same
   * (bare-metal development, or a deployment where the SFU has one address).
   */
  livekitPublicUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitRoom: string;
  livekitTokenTtlSeconds: number;

  // ── Chat (phase 5) ────────────────────────────────────────────────────────
  /**
   * `FR-5.2`. Defaults to `MAX_AUDIBLE_DISTANCE_M` and tracks it unless
   * overridden, which is the Phase 5 consistency rule expressed as a default
   * rather than as a comment somebody has to remember.
   */
  chatNearbyRadiusM: number;
  chatMaxMessageChars: number;
  /** `FR-5.12` — how far back a persistent channel can be scrolled. */
  chatHistoryLimit: number;
  /** `FR-5.11` — how long stored history is kept. */
  chatHistoryRetentionDays: number;
  typingIndicatorTtlMs: number;
  chatRateLimitPerMin: number;
  chatPersistence: ChatPersistenceMode;

  // ── PostgreSQL (ADR 0008) ─────────────────────────────────────────────────
  postgresHost: string;
  postgresPort: number;
  postgresUser: string;
  postgresPassword: string;
  postgresDb: string;

  // ── Accounts, sessions and invites (phase 6, ADR 0011) ────────────────────
  accounts: AccountsMode;
  /**
   * The signing key for access tokens.
   *
   * Empty is legal and means "generate one at boot", which is right for
   * development and wrong for anything with more than one process or more than
   * one restart: every signed token dies with the process. `main.ts` warns when
   * it happens, because the symptom — everybody signed out after a deploy —
   * looks like a session bug rather than a missing variable.
   */
  authJwtSecret: string;
  accessTokenTtlMin: number;
  refreshTokenTtlDays: number;
  passwordMinLength: number;
  argon2MemoryKib: number;
  argon2Iterations: number;
  argon2Parallelism: number;
  inviteDefaultTtlHours: number;
  resetTokenTtlMin: number;

  /**
   * `Secure` on the refresh cookie. `auto` decides per request from whether the
   * connection arrived over TLS.
   *
   * Not a plain boolean, because both fixed answers are wrong somewhere. Always
   * on breaks plain-HTTP development on a LAN address (the browser accepts the
   * cookie on `localhost` and silently drops it on `192.168.x.x`, so sign-in
   * appears to succeed and the next refresh 401s). Always off would ship a
   * bearer credential over cleartext.
   */
  authCookieSecure: 'auto' | 'true' | 'false';
  /**
   * `Lax` is the ADR 0011 default and is correct while the client and the api
   * share a registrable domain — including `localhost:5173` → `localhost:3000`,
   * which is same-*site* even though it is cross-origin. Serving them from
   * genuinely different domains needs `none`, which forces `Secure`.
   */
  authCookieSameSite: 'lax' | 'strict' | 'none';

  /** `DC-6.4` — the single Space this world instance belongs to. Phase 8 makes
   *  this a table with more than one row in it. */
  spaceSlug: string;
  spaceName: string;
  /** `FR-6.8` — the seed value. Once the Space row exists the database is
   *  authoritative, so flipping this later does not silently override an
   *  operator who changed it through the API. */
  spaceAllowGuests: boolean;

  /** Where invite and reset links point. Empty means "derive from the request",
   *  which is right behind a tunnel or a proxy whose public name nobody knows at
   *  boot. */
  publicWebUrl: string;

  // ── Capacity and moderation (phase 7) ─────────────────────────────────────
  /**
   * `FR-7.14` — the ceiling when a Space has not set its own.
   *
   * A default rather than the value: `spaces.capacity` overrides it, because a
   * Space can legitimately want to be smaller than the map, and an operator
   * changing an environment variable must not silently override a decision
   * somebody made through the API. The same relationship `SPACE_ALLOW_GUESTS`
   * has with `spaces.allow_guests`.
   */
  defaultMapCapacity: number;

  // ── Object storage and the asset pipeline (phase 9) ───────────────────────
  /**
   * MinIO, S3-compatible (ADR 0010). Empty disables uploads entirely, which is a
   * supported state and not a failure: the built-in asset library still works,
   * so a Map can be authored with no object storage at all (`FR-9.15`).
   */
  minioEndpoint: string;
  minioPort: number;
  minioUseSsl: boolean;
  minioAccessKey: string;
  minioSecretKey: string;
  minioBucket: string;
  /**
   * The address handed to **browsers**, which under Compose is not the server's.
   *
   * Exactly the problem `LIVEKIT_PUBLIC_URL` exists for, one phase later: the api
   * reaches MinIO at `http://minio:9000`, a name that resolves only inside the
   * Docker network, and a presigned URL signed against it sends every client to a
   * host it cannot look up. The failure surfaces as "assets don't load in
   * Docker" long after the code that caused it.
   */
  minioPublicUrl: string;
  /** How long a presigned upload or download URL stays valid. Short for uploads
   *  — it is write access to a bucket — and the same value serves reads, which
   *  are re-issued per request anyway. */
  assetUrlTtlSeconds: number;
  /**
   * Whether the api queues optimization jobs at all (`FR-9.13`).
   *
   * `auto` queues when there is a database to queue into and runs without the
   * pipeline otherwise — an uploaded model is then usable as-is, with no
   * level-of-detail variants, which is honest and is what a development machine
   * with no worker container has. `off` never queues.
   */
  assetPipeline: 'auto' | 'off';

  // ── SMTP (phase 6, FR-6.5) ────────────────────────────────────────────────
  /** Empty disables password recovery entirely, which ADR 0011 explicitly
   *  supports: it is the only outbound network dependency in the product. */
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpSecure: boolean;

  clientTuning: ClientTuning;
}

export function loadConfig(): RuntimeConfig {
  const config: RuntimeConfig = {
    port: num('API_PORT', 3000),
    tickRateHz: num('TICK_RATE_HZ', TUNING.TICK_RATE_HZ),
    clientSendRateHz: num('CLIENT_SEND_RATE_HZ', TUNING.CLIENT_SEND_RATE_HZ),
    interpolationBufferMs: num('INTERPOLATION_BUFFER_MS', TUNING.INTERPOLATION_BUFFER_MS),
    aoiEnterRadiusM: num('AOI_ENTER_RADIUS_M', TUNING.AOI_ENTER_RADIUS_M),
    aoiExitRadiusM: num('AOI_EXIT_RADIUS_M', TUNING.AOI_EXIT_RADIUS_M),
    aoiCellSizeM: num('AOI_CELL_SIZE_M', TUNING.AOI_CELL_SIZE_M),
    pingIntervalMs: num('PING_INTERVAL_MS', TUNING.PING_INTERVAL_MS),
    staleSessionTimeoutMs: num('STALE_SESSION_TIMEOUT_MS', TUNING.STALE_SESSION_TIMEOUT_MS),
    idleTimeoutMs: num('IDLE_TIMEOUT_MS', TUNING.IDLE_TIMEOUT_MS),
    resumeTokenTtlMs: num('RESUME_TOKEN_TTL_MS', TUNING.RESUME_TOKEN_TTL_MS),
    maxBufferedBytes: num('MAX_BUFFERED_BYTES', TUNING.MAX_BUFFERED_BYTES),
    maxMessageBytes: num('MAX_MESSAGE_BYTES', TUNING.MAX_MESSAGE_BYTES),
    maxInboundMsgsPerSec: num('MAX_INBOUND_MSGS_PER_SEC', TUNING.MAX_INBOUND_MSGS_PER_SEC),
    maxDisplayNameChars: num('MAX_DISPLAY_NAME_CHARS', TUNING.MAX_DISPLAY_NAME_CHARS),
    wsHandshakeTimeoutMs: num('WS_HANDSHAKE_TIMEOUT_MS', TUNING.WS_HANDSHAKE_TIMEOUT_MS),
    worldMapId: str('WORLD_MAP_ID', 'office'),
    worldAssetBaseUrl: str('WORLD_ASSET_BASE_URL', '/assets/world'),

    avatarAssetBaseUrl: str('AVATAR_ASSET_BASE_URL', '/assets/avatars'),
    avatarModelId: str('AVATAR_MODEL_ID', 'avatar'),
    emoteMinIntervalMs: num('EMOTE_MIN_INTERVAL_MS', TUNING.EMOTE_MIN_INTERVAL_MS),
    emoteMaxDurationMs: num('EMOTE_MAX_DURATION_MS', TUNING.EMOTE_MAX_DURATION_MS),
    animationCrossfadeMs: num('ANIMATION_CROSSFADE_MS', TUNING.ANIMATION_CROSSFADE_MS),
    runAnimationThresholdMps: num(
      'RUN_ANIMATION_THRESHOLD_MPS',
      TUNING.RUN_ANIMATION_THRESHOLD_MPS,
    ),
    nameplateFadeStartM: num('NAMEPLATE_FADE_START_M', TUNING.NAMEPLATE_FADE_START_M),
    nameplateHideM: num('NAMEPLATE_HIDE_M', TUNING.NAMEPLATE_HIDE_M),

    zoneHysteresisM: num('ZONE_HYSTERESIS_M', TUNING.ZONE_HYSTERESIS_M),
    portalCooldownMs: num('PORTAL_COOLDOWN_MS', TUNING.PORTAL_COOLDOWN_MS),
    portalExitClearanceM: num('PORTAL_EXIT_CLEARANCE_M', TUNING.PORTAL_EXIT_CLEARANCE_M),
    maxAudibleDistanceM: num('MAX_AUDIBLE_DISTANCE_M', TUNING.MAX_AUDIBLE_DISTANCE_M),
    audioRefDistanceM: num('AUDIO_REF_DISTANCE_M', TUNING.AUDIO_REF_DISTANCE_M),
    audioRolloffFactor: num('AUDIO_ROLLOFF_FACTOR', TUNING.AUDIO_ROLLOFF_FACTOR),
    spotlightGain: num('SPOTLIGHT_GAIN', TUNING.SPOTLIGHT_GAIN),
    privateZoneGain: num('PRIVATE_ZONE_GAIN', TUNING.PRIVATE_ZONE_GAIN),

    maxVisibleDistanceM: num('MAX_VISIBLE_DISTANCE_M', TUNING.MAX_VISIBLE_DISTANCE_M),
    audioHysteresisM: num('AUDIO_HYSTERESIS_M', TUNING.AUDIO_HYSTERESIS_M),
    maxConcurrentAudio: num('MAX_CONCURRENT_AUDIO', TUNING.MAX_CONCURRENT_AUDIO),
    maxConcurrentVideo: num('MAX_CONCURRENT_VIDEO', TUNING.MAX_CONCURRENT_VIDEO),

    livekitUrl: str('LIVEKIT_URL', ''),
    livekitPublicUrl: str('LIVEKIT_PUBLIC_URL', str('LIVEKIT_URL', '')),
    livekitApiKey: str('LIVEKIT_API_KEY', ''),
    livekitApiSecret: str('LIVEKIT_API_SECRET', ''),
    // One World Instance = one Room (ADR 0006). Phase 8 makes this per-instance.
    livekitRoom: str('LIVEKIT_ROOM', `world-${str('WORLD_MAP_ID', 'office')}`),
    livekitTokenTtlSeconds: num('LIVEKIT_TOKEN_TTL_SECONDS', 6 * 60 * 60),

    // The default IS `MAX_AUDIBLE_DISTANCE_M`, resolved through the same
    // environment lookup rather than through TUNING's literal — so an operator
    // who widens audible range widens chat reach with it, and the Phase 5
    // consistency rule survives a configuration change nobody thought was about
    // chat.
    chatNearbyRadiusM: num(
      'CHAT_NEARBY_RADIUS_M',
      num('MAX_AUDIBLE_DISTANCE_M', TUNING.MAX_AUDIBLE_DISTANCE_M),
    ),
    chatMaxMessageChars: num('CHAT_MAX_MESSAGE_CHARS', TUNING.CHAT_MAX_MESSAGE_CHARS),
    chatHistoryLimit: num('CHAT_HISTORY_LIMIT', TUNING.CHAT_HISTORY_LIMIT),
    chatHistoryRetentionDays: num(
      'CHAT_HISTORY_RETENTION_DAYS',
      TUNING.CHAT_HISTORY_RETENTION_DAYS,
    ),
    typingIndicatorTtlMs: num('TYPING_INDICATOR_TTL_MS', TUNING.TYPING_INDICATOR_TTL_MS),
    chatRateLimitPerMin: num('CHAT_RATE_LIMIT_PER_MIN', TUNING.CHAT_RATE_LIMIT_PER_MIN),
    chatPersistence: choice('CHAT_PERSISTENCE', ['auto', 'postgres', 'memory'] as const, 'auto'),

    postgresHost: str('POSTGRES_HOST', 'localhost'),
    postgresPort: num('POSTGRES_PORT', 5432),
    postgresUser: str('POSTGRES_USER', 'hubitat'),
    postgresPassword: str('POSTGRES_PASSWORD', ''),
    postgresDb: str('POSTGRES_DB', 'hubitat'),

    accounts: choice('ACCOUNTS', ['auto', 'required', 'off'] as const, 'auto'),
    authJwtSecret: str('AUTH_JWT_SECRET', ''),
    accessTokenTtlMin: num('ACCESS_TOKEN_TTL_MIN', TUNING.ACCESS_TOKEN_TTL_MIN),
    refreshTokenTtlDays: num('REFRESH_TOKEN_TTL_DAYS', TUNING.REFRESH_TOKEN_TTL_DAYS),
    passwordMinLength: num('PASSWORD_MIN_LENGTH', TUNING.PASSWORD_MIN_LENGTH),
    argon2MemoryKib: num('ARGON2_MEMORY_KIB', TUNING.ARGON2_MEMORY_KIB),
    argon2Iterations: num('ARGON2_ITERATIONS', TUNING.ARGON2_ITERATIONS),
    argon2Parallelism: num('ARGON2_PARALLELISM', TUNING.ARGON2_PARALLELISM),
    inviteDefaultTtlHours: num('INVITE_DEFAULT_TTL_HOURS', TUNING.INVITE_DEFAULT_TTL_HOURS),
    resetTokenTtlMin: num('RESET_TOKEN_TTL_MIN', TUNING.RESET_TOKEN_TTL_MIN),

    authCookieSecure: choice('AUTH_COOKIE_SECURE', ['auto', 'true', 'false'] as const, 'auto'),
    authCookieSameSite: choice('AUTH_COOKIE_SAMESITE', ['lax', 'strict', 'none'] as const, 'lax'),

    spaceSlug: str('SPACE_SLUG', 'default'),
    spaceName: str('SPACE_NAME', 'hubitat'),
    spaceAllowGuests: bool('SPACE_ALLOW_GUESTS', true),

    publicWebUrl: str('PUBLIC_WEB_URL', ''),

    defaultMapCapacity: num('DEFAULT_MAP_CAPACITY', TUNING.DEFAULT_MAP_CAPACITY),

    minioEndpoint: str('MINIO_ENDPOINT', ''),
    minioPort: num('MINIO_PORT', 9000),
    minioUseSsl: bool('MINIO_USE_SSL', false),
    minioAccessKey: str('MINIO_ROOT_USER', str('MINIO_ACCESS_KEY', '')),
    minioSecretKey: str('MINIO_ROOT_PASSWORD', str('MINIO_SECRET_KEY', '')),
    minioBucket: str('MINIO_BUCKET', 'hubitat-assets'),
    // Defaults to the server's own address, which is correct whenever the two
    // are the same — bare-metal development, or a deployment where object
    // storage has one address.
    minioPublicUrl: str(
      'MINIO_PUBLIC_URL',
      str('MINIO_ENDPOINT', '')
        ? `${bool('MINIO_USE_SSL', false) ? 'https' : 'http'}://${str('MINIO_ENDPOINT', '')}:${num('MINIO_PORT', 9000)}`
        : '',
    ),
    assetUrlTtlSeconds: num('ASSET_URL_TTL_SECONDS', 15 * 60),
    assetPipeline: choice('ASSET_PIPELINE', ['auto', 'off'] as const, 'auto'),

    smtpHost: str('SMTP_HOST', ''),
    smtpPort: num('SMTP_PORT', 1025),
    smtpUser: str('SMTP_USER', ''),
    smtpPassword: str('SMTP_PASSWORD', ''),
    smtpFrom: str('SMTP_FROM', 'noreply@hubitat.local'),
    smtpSecure: bool('SMTP_SECURE', false),

    clientTuning: {
      tickRateHz: num('TICK_RATE_HZ', TUNING.TICK_RATE_HZ),
      clientSendRateHz: num('CLIENT_SEND_RATE_HZ', TUNING.CLIENT_SEND_RATE_HZ),
      interpolationBufferMs: num('INTERPOLATION_BUFFER_MS', TUNING.INTERPOLATION_BUFFER_MS),
      aoiEnterRadiusM: num('AOI_ENTER_RADIUS_M', TUNING.AOI_ENTER_RADIUS_M),
      aoiExitRadiusM: num('AOI_EXIT_RADIUS_M', TUNING.AOI_EXIT_RADIUS_M),
      idleTimeoutMs: num('IDLE_TIMEOUT_MS', TUNING.IDLE_TIMEOUT_MS),
      walkSpeedMps: num('WALK_SPEED_MPS', TUNING.WALK_SPEED_MPS),
      runSpeedMps: num('RUN_SPEED_MPS', TUNING.RUN_SPEED_MPS),
      accelerationMps2: num('ACCELERATION_MPS2', TUNING.ACCELERATION_MPS2),
      jumpHeightM: num('JUMP_HEIGHT_M', TUNING.JUMP_HEIGHT_M),
      gravityMps2: num('GRAVITY_MPS2', TUNING.GRAVITY_MPS2),
      characterStepOffsetM: num('CHARACTER_STEP_OFFSET_M', TUNING.CHARACTER_STEP_OFFSET_M),
      characterSlopeLimitDeg: num('CHARACTER_SLOPE_LIMIT_DEG', TUNING.CHARACTER_SLOPE_LIMIT_DEG),
      characterSnapToGroundM: num('CHARACTER_SNAP_TO_GROUND_M', TUNING.CHARACTER_SNAP_TO_GROUND_M),
      avatarHeightM: TUNING.AVATAR_HEIGHT_M,
      avatarRadiusM: TUNING.AVATAR_RADIUS_M,
      maxAudibleDistanceM: num('MAX_AUDIBLE_DISTANCE_M', TUNING.MAX_AUDIBLE_DISTANCE_M),
      maxVisibleDistanceM: num('MAX_VISIBLE_DISTANCE_M', TUNING.MAX_VISIBLE_DISTANCE_M),
      audioRefDistanceM: num('AUDIO_REF_DISTANCE_M', TUNING.AUDIO_REF_DISTANCE_M),
      audioRolloffFactor: num('AUDIO_ROLLOFF_FACTOR', TUNING.AUDIO_ROLLOFF_FACTOR),

      animationCrossfadeMs: num('ANIMATION_CROSSFADE_MS', TUNING.ANIMATION_CROSSFADE_MS),
      runAnimationThresholdMps: num(
        'RUN_ANIMATION_THRESHOLD_MPS',
        TUNING.RUN_ANIMATION_THRESHOLD_MPS,
      ),
      nameplateFadeStartM: num('NAMEPLATE_FADE_START_M', TUNING.NAMEPLATE_FADE_START_M),
      nameplateHideM: num('NAMEPLATE_HIDE_M', TUNING.NAMEPLATE_HIDE_M),
      emoteMinIntervalMs: num('EMOTE_MIN_INTERVAL_MS', TUNING.EMOTE_MIN_INTERVAL_MS),
      emoteMaxDurationMs: num('EMOTE_MAX_DURATION_MS', TUNING.EMOTE_MAX_DURATION_MS),

      chatNearbyRadiusM: num(
        'CHAT_NEARBY_RADIUS_M',
        num('MAX_AUDIBLE_DISTANCE_M', TUNING.MAX_AUDIBLE_DISTANCE_M),
      ),
      chatMaxMessageChars: num('CHAT_MAX_MESSAGE_CHARS', TUNING.CHAT_MAX_MESSAGE_CHARS),
      chatHistoryLimit: num('CHAT_HISTORY_LIMIT', TUNING.CHAT_HISTORY_LIMIT),
      typingIndicatorTtlMs: num('TYPING_INDICATOR_TTL_MS', TUNING.TYPING_INDICATOR_TTL_MS),
      chatRateLimitPerMin: num('CHAT_RATE_LIMIT_PER_MIN', TUNING.CHAT_RATE_LIMIT_PER_MIN),
    },
  };

  validate(config);
  return config;
}

/**
 * Configurations that are legal but usually mistakes.
 *
 * The same distinction the Map Document draws between an error and a warning:
 * refusing these would block a deliberate choice, and staying silent lets an
 * accidental one ship. Logged once at boot by `main.ts`.
 */
export function configWarnings(config: RuntimeConfig): string[] {
  const warnings: string[] = [];

  // The Phase 5 consistency rule, in the only form that can be automated:
  // "diverging them knowingly is allowed; diverging them by accident is a bug".
  // Nobody can tell which this is from the outside — so say it happened, and let
  // whoever set it recognise their own decision.
  if (config.chatNearbyRadiusM !== config.maxAudibleDistanceM) {
    warnings.push(
      `CHAT_NEARBY_RADIUS_M (${config.chatNearbyRadiusM} m) differs from ` +
        `MAX_AUDIBLE_DISTANCE_M (${config.maxAudibleDistanceM} m). Local chat will reach a ` +
        `different set of people than voice does, which the Phase 5 consistency rule allows ` +
        `deliberately and warns about otherwise.`,
    );
  }

  // ── Capacity (phase 7) ─────────────────────────────────────────────────────

  // `NFR-1` is explicit: 50 concurrent participants is the figure the
  // architecture was designed and verified against, and "beyond it nothing has
  // been validated". A warning rather than a refusal, because raising it is a
  // legitimate decision somebody may have measured for themselves — and because
  // the failure it produces is a tick that overruns its budget, which is visible
  // on `/health` (`NFR-38`) rather than silent.
  if (config.defaultMapCapacity > TUNING.DEFAULT_MAP_CAPACITY) {
    warnings.push(
      `DEFAULT_MAP_CAPACITY is ${config.defaultMapCapacity}, above the ${TUNING.DEFAULT_MAP_CAPACITY} ` +
        `this architecture was verified against (NFR-1). Watch lastTickMs on /health: past the ` +
        `tick budget the world stutters for everybody at once, not just for the newcomers.`,
    );
  }

  // ── Accounts (phase 6) ─────────────────────────────────────────────────────

  // Not fatal, because it is exactly right for `npm run dev`: a generated key
  // means nobody has to invent one to try the thing. It is disastrous unnoticed,
  // because the symptom of a restart — everyone signed out, every refresh token
  // rejected — reads as a session bug rather than as a missing variable.
  if (config.accounts !== 'off' && !config.authJwtSecret) {
    warnings.push(
      `AUTH_JWT_SECRET is not set. A random signing key is generated at boot, so every ` +
        `access token becomes invalid when this process restarts and everybody is signed ` +
        `out. Set it to a long random string for anything that is not a development run.`,
    );
  }

  // ADR 0011: recovery is the only outbound dependency in the product and it is
  // optional. Silent is the wrong way to be optional — "forgot password does
  // nothing" is a support ticket nobody can trace to an unset variable.
  if (config.accounts !== 'off' && !config.smtpHost) {
    warnings.push(
      `SMTP_HOST is not set, so password recovery (FR-6.5) is disabled and the client is ` +
        `told so. Reset a password administratively, or point SMTP_* at a relay ` +
        `(docker compose runs Mailpit for development).`,
    );
  }

  // `SameSite=None` without `Secure` is rejected outright by every current
  // browser. The cookie is simply never stored, so sign-in appears to work and
  // the first refresh fails — the hardest possible way to learn this.
  if (config.authCookieSameSite === 'none' && config.authCookieSecure === 'false') {
    warnings.push(
      `AUTH_COOKIE_SAMESITE=none requires the Secure attribute; with ` +
        `AUTH_COOKIE_SECURE=false browsers will discard the refresh cookie and every ` +
        `session will end after ${config.accessTokenTtlMin} minutes.`,
    );
  }

  return warnings;
}

/**
 * Fail at boot, loudly, rather than misbehaving quietly at runtime.
 *
 * Both of these have bitten real systems: equal AOI radii produce avatars
 * flickering in and out at a boundary, and a stale timeout below two ping
 * intervals evicts healthy sessions on a single dropped pong. Neither looks like
 * a configuration problem when you are debugging it.
 */
function validate(config: RuntimeConfig): void {
  if (config.aoiExitRadiusM <= config.aoiEnterRadiusM) {
    throw new Error(
      `AOI_EXIT_RADIUS_M (${config.aoiExitRadiusM}) must exceed AOI_ENTER_RADIUS_M ` +
        `(${config.aoiEnterRadiusM}). The gap is the hysteresis that stops the ` +
        `interest set flapping at a boundary (FR-1.17).`,
    );
  }

  if (config.staleSessionTimeoutMs <= config.pingIntervalMs * 2) {
    throw new Error(
      `STALE_SESSION_TIMEOUT_MS (${config.staleSessionTimeoutMs}) must exceed ` +
        `2 x PING_INTERVAL_MS (${config.pingIntervalMs * 2}), or a single dropped ` +
        `pong evicts a healthy session (FR-1.6).`,
    );
  }

  if (config.tickRateHz <= 0 || config.tickRateHz > 120) {
    throw new Error(`TICK_RATE_HZ out of range: ${config.tickRateHz}`);
  }

  // Same failure as equal AOI radii, one phase later. A negative hysteresis makes
  // the exit volume SMALLER than the enter volume, so a participant standing on
  // an edge enters and exits every tick — twenty private-zone isolation flips a
  // second, which in phase 2 terms is audio connecting and dropping continuously.
  if (config.zoneHysteresisM < 0) {
    throw new Error(
      `ZONE_HYSTERESIS_M (${config.zoneHysteresisM}) cannot be negative: the exit ` +
        `test would be smaller than the enter test and zone membership would flap ` +
        `on every edge (Phase 3 Rules).`,
    );
  }

  // Clearance is the primary defence against a portal firing again the instant it
  // delivers you; the cooldown is only the safety net. At zero clearance the
  // arrival point can be inside the portal it came from, and the cooldown is then
  // load-bearing rather than a backstop.
  if (config.portalExitClearanceM <= 0) {
    throw new Error(
      `PORTAL_EXIT_CLEARANCE_M (${config.portalExitClearanceM}) must be positive, or ` +
        `a portal can deliver a participant inside itself and re-trigger (Phase 3 Rules).`,
    );
  }

  for (const [key, value] of [
    ['SPOTLIGHT_GAIN', config.spotlightGain],
    ['PRIVATE_ZONE_GAIN', config.privateZoneGain],
  ] as const) {
    if (value < 0 || value > 1) {
      throw new Error(`${key} must be within 0..1, got ${value}.`);
    }
  }

  // Third spelling of the same failure, one phase later again. At zero, someone
  // standing on the audible threshold subscribes and unsubscribes a WebRTC track
  // on every tick — twenty renegotiations a second, audible as clicking.
  if (config.audioHysteresisM < 0) {
    throw new Error(
      `AUDIO_HYSTERESIS_M (${config.audioHysteresisM}) cannot be negative: the exit ` +
        `threshold would sit inside the enter threshold and media subscriptions ` +
        `would thrash at every range boundary (Phase 2 Rules).`,
    );
  }

  for (const [key, value] of [
    ['MAX_AUDIBLE_DISTANCE_M', config.maxAudibleDistanceM],
    ['MAX_VISIBLE_DISTANCE_M', config.maxVisibleDistanceM],
    ['MAX_CONCURRENT_AUDIO', config.maxConcurrentAudio],
    ['MAX_CONCURRENT_VIDEO', config.maxConcurrentVideo],
  ] as const) {
    if (value <= 0) throw new Error(`${key} must be positive, got ${value}.`);
  }

  // Audible range must stay inside the interest radius, or a speaker can be
  // audible while never having been announced to the listener — the AUDIENCE
  // frame would name a participant the client has no record of.
  if (config.maxAudibleDistanceM >= config.aoiEnterRadiusM) {
    throw new Error(
      `MAX_AUDIBLE_DISTANCE_M (${config.maxAudibleDistanceM}) must be smaller than ` +
        `AOI_ENTER_RADIUS_M (${config.aoiEnterRadiusM}), or someone can become audible ` +
        `before they are ever announced as present (FR-1.16, FR-2.6).`,
    );
  }

  // ── Avatars (phase 4) ──────────────────────────────────────────────────────

  // Fourth spelling of the boundary failure, one phase later again. Hiding a
  // nameplate before it has finished fading is a pop, which is precisely what
  // "unobtrusive when far" (FR-4.9) rules out — and it reads as a rendering bug,
  // not as two numbers in the wrong order.
  if (config.nameplateHideM <= config.nameplateFadeStartM) {
    throw new Error(
      `NAMEPLATE_HIDE_M (${config.nameplateHideM}) must exceed NAMEPLATE_FADE_START_M ` +
        `(${config.nameplateFadeStartM}), or nameplates vanish instead of fading (FR-4.9).`,
    );
  }

  // Outside this band the locomotion blend has no middle: at or above run speed
  // the run clip never plays, at or below zero nobody ever walks. Both look like
  // a broken animation graph.
  if (
    config.runAnimationThresholdMps <= 0 ||
    config.runAnimationThresholdMps >= config.clientTuning.runSpeedMps
  ) {
    throw new Error(
      `RUN_ANIMATION_THRESHOLD_MPS (${config.runAnimationThresholdMps}) must sit between 0 ` +
        `and RUN_SPEED_MPS (${config.clientTuning.runSpeedMps}), or one of the locomotion ` +
        `states can never be reached (FR-4.2).`,
    );
  }

  if (config.animationCrossfadeMs < 0) {
    throw new Error(
      `ANIMATION_CROSSFADE_MS (${config.animationCrossfadeMs}) cannot be negative (FR-4.3).`,
    );
  }

  // A zero-length emote is accepted, broadcast, and never visible — the reports
  // read as "emotes don't work" rather than as a duration of nothing.
  if (config.emoteMaxDurationMs <= 0) {
    throw new Error(
      `EMOTE_MAX_DURATION_MS (${config.emoteMaxDurationMs}) must be positive, or every ` +
        `emote is clamped to nothing and none of them are ever seen (FR-4.16).`,
    );
  }

  if (config.emoteMinIntervalMs < 0) {
    throw new Error(`EMOTE_MIN_INTERVAL_MS (${config.emoteMinIntervalMs}) cannot be negative.`);
  }

  // ── Chat (phase 5) ─────────────────────────────────────────────────────────

  for (const [key, value] of [
    ['CHAT_NEARBY_RADIUS_M', config.chatNearbyRadiusM],
    ['CHAT_MAX_MESSAGE_CHARS', config.chatMaxMessageChars],
    ['CHAT_HISTORY_LIMIT', config.chatHistoryLimit],
    ['CHAT_HISTORY_RETENTION_DAYS', config.chatHistoryRetentionDays],
    ['CHAT_RATE_LIMIT_PER_MIN', config.chatRateLimitPerMin],
    ['TYPING_INDICATOR_TTL_MS', config.typingIndicatorTtlMs],
  ] as const) {
    if (value <= 0) throw new Error(`${key} must be positive, got ${value}.`);
  }

  // A nearby radius outside the interest set would deliver a message from
  // somebody the recipient has never been told is present. The message itself
  // carries its sender's name so it would still *render* — which is worse than
  // failing, because the reply goes to a person the client cannot locate and the
  // symptom is "chat from nowhere".
  if (config.chatNearbyRadiusM >= config.aoiEnterRadiusM) {
    throw new Error(
      `CHAT_NEARBY_RADIUS_M (${config.chatNearbyRadiusM}) must be smaller than ` +
        `AOI_ENTER_RADIUS_M (${config.aoiEnterRadiusM}), or a nearby message can arrive ` +
        `from someone the recipient has never been told is present (FR-1.16, FR-5.2).`,
    );
  }

  // Partial credentials are the silent-failure case: media appears configured,
  // every token is rejected, and the symptom is "nobody can hear anyone".
  const livekit = [config.livekitUrl, config.livekitApiKey, config.livekitApiSecret];
  if (livekit.some(Boolean) && !livekit.every(Boolean)) {
    throw new Error(
      'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together. ' +
        'Leave all three empty to run without voice and video (phase 1 development), ' +
        'or set all three to enable it.',
    );
  }

  // ── Capacity (phase 7) ─────────────────────────────────────────────────────

  // One is not a capacity, it is a private room with a lock on it. Every
  // requirement in this product is about more than one person being present, so
  // a Space nobody can be joined in is a configuration that has switched the
  // product off — and it would present as "the second person cannot connect".
  if (config.defaultMapCapacity < 2) {
    throw new Error(
      `DEFAULT_MAP_CAPACITY (${config.defaultMapCapacity}) must be at least 2. Below that ` +
        `nobody can ever be joined by anybody, which is not a capacity limit (FR-7.14).`,
    );
  }

  // ── Accounts (phase 6) ─────────────────────────────────────────────────────

  if (config.accounts === 'off') return;

  // FR-6.3 names the OWASP floor, and these are the one set of numbers in this
  // file where a lower value produces no symptom at all — logins get faster and
  // an offline attack against a stolen table gets cheaper, and nothing in the
  // running system ever mentions it. So it is a refusal, not a warning.
  if (config.argon2MemoryKib < TUNING.ARGON2_MEMORY_KIB) {
    throw new Error(
      `ARGON2_MEMORY_KIB (${config.argon2MemoryKib}) is below the OWASP argon2id floor of ` +
        `${TUNING.ARGON2_MEMORY_KIB} KiB. FR-6.3 requires credentials to be stored safely, ` +
        `and lowering this weakens exactly that with no visible symptom.`,
    );
  }

  if (config.argon2Iterations < TUNING.ARGON2_ITERATIONS) {
    throw new Error(
      `ARGON2_ITERATIONS (${config.argon2Iterations}) is below the OWASP floor of ` +
        `${TUNING.ARGON2_ITERATIONS} (FR-6.3).`,
    );
  }

  if (config.argon2Parallelism < 1 || config.argon2Parallelism > 4) {
    throw new Error(
      `ARGON2_PARALLELISM (${config.argon2Parallelism}) must be within 1..4 ` +
        `(specs/conventions/tuning-defaults.md).`,
    );
  }

  // Eight is the NIST 800-63B minimum. Below it the field is decorative.
  if (config.passwordMinLength < 8) {
    throw new Error(
      `PASSWORD_MIN_LENGTH (${config.passwordMinLength}) must be at least 8 (FR-6.3).`,
    );
  }

  // A short secret is a signing key that can be brute-forced offline from a
  // single captured token, at which point anybody can mint an identity.
  if (config.authJwtSecret && config.authJwtSecret.length < 32) {
    throw new Error(
      `AUTH_JWT_SECRET is ${config.authJwtSecret.length} characters. Use at least 32: it ` +
        `signs every access token, and a short one can be recovered offline from a single ` +
        `captured token.`,
    );
  }

  for (const [key, value] of [
    ['ACCESS_TOKEN_TTL_MIN', config.accessTokenTtlMin],
    ['REFRESH_TOKEN_TTL_DAYS', config.refreshTokenTtlDays],
    ['INVITE_DEFAULT_TTL_HOURS', config.inviteDefaultTtlHours],
    ['RESET_TOKEN_TTL_MIN', config.resetTokenTtlMin],
  ] as const) {
    if (value <= 0) throw new Error(`${key} must be positive, got ${value}.`);
  }

  // The refresh token exists to outlive the access token. Inverted, every
  // refresh returns a token that is already older than the session it is meant
  // to extend, and the client loops between a 401 and a refresh that fixes
  // nothing — which presents as "the server logs me out at random".
  if (config.accessTokenTtlMin >= config.refreshTokenTtlDays * 24 * 60) {
    throw new Error(
      `ACCESS_TOKEN_TTL_MIN (${config.accessTokenTtlMin} min) must be shorter than ` +
        `REFRESH_TOKEN_TTL_DAYS (${config.refreshTokenTtlDays} d), or refreshing a session ` +
        `can never extend it (FR-6.17).`,
    );
  }

  // Same shape as the LiveKit triple, and the same failure: a relay that accepts
  // the connection and rejects every message looks exactly like recovery being
  // broken, with nothing in the logs about an empty envelope sender.
  if (config.smtpHost && !config.smtpFrom) {
    throw new Error(
      'SMTP_HOST is set but SMTP_FROM is empty. A relay will accept the connection and ' +
        'reject every message, which presents as password recovery being broken rather ' +
        'than misconfigured. Leave SMTP_HOST empty to disable recovery (FR-6.5).',
    );
  }
}
