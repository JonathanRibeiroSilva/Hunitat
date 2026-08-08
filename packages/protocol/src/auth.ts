/**
 * Accounts, membership and invites — phase 6.
 *
 * Unlike every other file in this package, most of what follows never travels on
 * the WebSocket. It travels over HTTP, and it lives here anyway for the reason
 * ADR 0001 gives for the package existing at all: the client and the server must
 * agree on these shapes exactly, and a shape defined twice drifts silently. A
 * registration body that the browser spells one way and the server reads another
 * fails as "invalid request" with nothing to point at.
 *
 * Two things are deliberately NOT here:
 *
 *   - **Password rules beyond a hard ceiling.** `PASSWORD_MIN_LENGTH` is
 *     configurable (`FR-6.3`, tuning-defaults.md), so the minimum is enforced by
 *     the server and *advertised* through `authConfigSchema`. A minimum baked
 *     into a shared schema would be a second copy of a tunable value, and the
 *     client would go on refusing a password the server had started accepting.
 *   - **Anything secret.** No hash parameters, no token contents. The access
 *     token is an opaque string to everyone but the server that signed it.
 */

import { z } from 'zod';
import { avatarAppearanceSchema, presenceStatusSchema } from './messages.js';
import { TUNING } from './constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public server capabilities — `GET /auth/config`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the entry screen has to know **before** anyone connects.
 *
 * Fetched rather than assumed, and every field here is a decision the server
 * owns:
 *
 *   - `accountsEnabled` is false when there is no database (the README's
 *     no-Docker development flow). Guests still work; offering a sign-up form
 *     that cannot succeed does not.
 *   - `allowGuests` is `Space.allowGuests` (`FR-6.8`). A client that guessed
 *     would send people to a "Continue as guest" button that the server is going
 *     to refuse, which is precisely the failure `AC-6.5` is about.
 *   - `passwordMinLength` is tunable (`PASSWORD_MIN_LENGTH`), so it is told, not
 *     imported — otherwise the form goes on refusing what the server accepts.
 *   - `passwordResetEnabled` is false when no SMTP relay is configured. Recovery
 *     is the only outbound dependency in the product and it is optional
 *     (ADR 0011); a "Forgot your password?" link that silently does nothing is
 *     worse than no link.
 */
export const authConfigSchema = z.object({
  accountsEnabled: z.boolean(),
  allowGuests: z.boolean(),
  passwordMinLength: z.number().int().positive(),
  passwordResetEnabled: z.boolean(),
  spaceSlug: z.string(),
  spaceName: z.string(),
  /**
   * Phase 7, `FR-7.12` — whether entering needs a Space password.
   *
   * Advertised, never guessed, for the same reason `allowGuests` is: a client
   * that assumed would send people through a form the server is going to refuse.
   * It says only *that* one is required. Defaulted so a client talking to a
   * phase-6 server still parses this.
   */
  spacePasswordRequired: z.boolean().default(false),
  /**
   * Phase 7, `FR-7.11` — the Space admits nobody new right now.
   *
   * Told up front so the entry screen can say so instead of taking a name, a
   * password and a click before answering. It discloses nothing an attempted
   * join would not.
   */
  spaceLocked: z.boolean().default(false),
});

export type AuthConfigDto = z.infer<typeof authConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lowercased and trimmed at the schema, not at each call site.
 *
 * The uniqueness index is on the normalised value, so normalising anywhere else
 * would let `Ana@example.com` and `ana@example.com` become two accounts that
 * both believe they own the same mailbox — and password recovery would then
 * reach whichever of them the relay happened to deliver to.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .refine((value) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value), 'not a valid email address');

/**
 * A ceiling, never a floor.
 *
 * The 200-character cap is a denial-of-service bound: argon2id at the OWASP
 * floor costs 19 MiB and ~50 ms per verification, so an unbounded field is a
 * memory amplifier pointed at the login route. The *minimum* is
 * `PASSWORD_MIN_LENGTH` and lives on the server — see the file header.
 */
export const passwordSchema = z.string().min(1).max(200);

export const displayNameSchema = z.string().trim().min(1).max(TUNING.MAX_DISPLAY_NAME_CHARS);

/**
 * `FR-6.14` — invite codes.
 *
 * Case-insensitive on the way in because these get read off a screen and typed
 * by hand. They are generated from an unambiguous alphabet (no `0`/`O`, no
 * `1`/`I`/`l`) for the same reason.
 */
export const inviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(6)
  .max(32)
  .regex(/^[A-Z0-9-]+$/, 'not a valid invite code');

/** `FR-6.1`. An invite code may ride along, so "accept invite" is one step for
 *  somebody who has no account yet rather than register-then-redeem. */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  /** `FR-6.7` — carried over from the guest session where there is one. */
  appearance: avatarAppearanceSchema.optional(),
  inviteCode: inviteCodeSchema.optional(),
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

/**
 * `FR-6.7` — a guest becoming an account **without dropping the socket**.
 *
 * `resumeToken`, not `sessionId`, and the difference matters. A session id is
 * broadcast to every participant in range on `PARTICIPANT_ADD`, so accepting one
 * here would let anybody in the room mint an account wearing a stranger's name
 * and avatar. The resume token is held only by the guest whose session it is.
 */
export const upgradeRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  resumeToken: z.string().min(1).max(128),
  inviteCode: inviteCodeSchema.optional(),
});

/** `FR-6.10` — every field optional; absent means "leave it alone". */
export const profileUpdateRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    appearance: avatarAppearanceSchema.optional(),
    /** `DC-6.2` "status preferences" — what to come back as, not what you are
     *  right now. The live value stays a `SET_STATUS` frame. */
    statusPreference: presenceStatusSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'nothing to update',
  );

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(16).max(128),
  password: passwordSchema,
});

/**
 * `FR-6.14` — an invite must carry at least one bound, and both are allowed.
 *
 * Omitting `expiresInHours` yields `INVITE_DEFAULT_TTL_HOURS` rather than "never
 * expires": an invite link with no bound at all is a permanent, unrevoked door
 * into the Space, and the requirement asks for at least one limit. Passing
 * `maxUses: null` explicitly means unlimited *uses*, which is fine because the
 * expiry is still there.
 */
export const inviteCreateRequestSchema = z.object({
  expiresInHours: z.number().int().positive().max(8760).optional(),
  maxUses: z.number().int().positive().max(10_000).nullable().optional(),
});

/**
 * `FR-6.8` — the one Space setting phase 6 exposes.
 *
 * A single field, because it is the only Space property this phase defines any
 * behaviour for. Renaming a Space, transferring it, adding maps to it — all of
 * that is Phase 8, and adding fields here now would be designing that schema
 * blind.
 */
export const spaceUpdateRequestSchema = z.object({
  allowGuests: z.boolean().optional(),
});

export type SpaceUpdateRequest = z.infer<typeof spaceUpdateRequestSchema>;

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmSchema>;
export type InviteCreateRequest = z.infer<typeof inviteCreateRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

/** `DC-8.1 Space`, in the form phase 6 needs — what it is called and whether it
 *  admits guests (`FR-6.8`). */
export const spaceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  allowGuests: z.boolean(),
});

export type SpaceDto = z.infer<typeof spaceSchema>;

/** `DC-6.4 Membership` as the owner is told about it. */
export const membershipSchema = z.object({
  spaceId: z.string(),
  spaceSlug: z.string(),
  spaceName: z.string(),
  /** ISO 8601. `DC-6.4` asks for the date joined. */
  joinedAt: z.string(),
});

/** `DC-6.1` + `DC-6.2` — the account and its profile, as its owner sees them. */
export const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  appearance: avatarAppearanceSchema,
  statusPreference: presenceStatusSchema,
  /** `FR-6.16` — an account may hold many. */
  memberships: z.array(membershipSchema),
});

/**
 * `DC-6.6 Auth Session` — what a successful login hands back.
 *
 * The refresh token is **not** in here, and its absence is the design: it is set
 * as an `httpOnly` cookie the browser cannot read (ADR 0011). Only the
 * short-lived access token crosses into JavaScript, and only into memory.
 */
export const authSessionSchema = z.object({
  accessToken: z.string(),
  /** So the client can refresh *before* a request fails, rather than after. */
  expiresInSeconds: z.number().int().positive(),
  account: accountSchema,
});

/** `DC-6.5 Invite`, to the member who created it. */
export const inviteSchema = z.object({
  id: z.string(),
  code: z.string(),
  spaceSlug: z.string(),
  /** Absolute, ready to paste. Built from the request's own origin, so a
   *  deployment behind a tunnel or a reverse proxy produces links that work. */
  url: z.string(),
  /** ISO 8601. Always present — every invite is bounded (`FR-6.14`). */
  expiresAt: z.string(),
  /** Null means unlimited uses; the expiry is still the bound. */
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  revoked: z.boolean(),
  createdAt: z.string(),
});

/**
 * What a *recipient* is told about an invite before they act on it.
 *
 * Deliberately says almost nothing when the invite is bad. `reason` distinguishes
 * expired from exhausted, which the Phase 6 Rules require to be different
 * messages — but it never confirms whether an unknown code was ever real, which
 * would turn this into an oracle for guessing them.
 */
export const invitePreviewSchema = z.object({
  code: z.string(),
  valid: z.boolean(),
  spaceName: z.string().optional(),
  reason: z.enum(['ok', 'expired', 'exhausted', 'revoked', 'unknown']),
});

export type MembershipDto = z.infer<typeof membershipSchema>;
export type AccountDto = z.infer<typeof accountSchema>;
export type AuthSessionDto = z.infer<typeof authSessionSchema>;
export type InviteDto = z.infer<typeof inviteSchema>;
export type InvitePreviewDto = z.infer<typeof invitePreviewSchema>;
