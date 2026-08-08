/**
 * The avatar vocabulary — phase 4.
 *
 * `DC-4.1 Avatar Appearance` and `DC-4.4 Emote` are the two data concepts the
 * phase spec leaves abstract. This file fixes them, and it lives in the shared
 * package for the same reason the byte layouts do: the client renders from this
 * list, the server validates against it, and the bots assert on it. One list, or
 * a customization that looks different to the person who chose it than to
 * everyone else.
 *
 * The spec is deliberate that the option taxonomy is "left to design"
 * (`FR-4.5`), so what is normative here is the *shape* — a base model, a set of
 * colours, a set of accessories — not the particular hats.
 *
 * This package must not import Node or DOM APIs.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Appearance (DC-4.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body build.
 *
 * Height is NOT a variant. `AVATAR_HEIGHT_M` sizes the physics capsule, the
 * camera target and the nameplate anchor, so a taller avatar would either
 * collide differently from how it looks or wear its own name at someone else's
 * eye level. Build varies girth only, which is free of all three.
 */
export const AVATAR_BASE_MODELS = ['standard', 'slim', 'broad'] as const;
export type AvatarBaseModel = (typeof AVATAR_BASE_MODELS)[number];

export const AVATAR_ACCESSORIES = ['cap', 'glasses', 'backpack'] as const;
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];

/**
 * Palettes are indices, not hex strings.
 *
 * Bounded by construction — a `z.string()` colour would let a client publish
 * `#000000` on a black background and become invisible to everyone else, which
 * is a moderation problem invented for no gain. Indices are also two bytes on
 * the wire against eight, and `PARTICIPANT_UPDATE` carries the whole appearance.
 */
export const SKIN_COLORS = [
  '#f2d0b6',
  '#e3b590',
  '#c98e63',
  '#a06841',
  '#754c2e',
  '#4b3020',
] as const;

export const HAIR_COLORS = [
  '#2b2118',
  '#5a3a22',
  '#a8672c',
  '#d8b26a',
  '#9aa3ad',
  '#f1f5f9',
  '#7c3aed',
  '#0ea5e9',
] as const;

export const TOP_COLORS = [
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#a78bfa',
  '#f472b6',
  '#e2e8f0',
  '#334155',
] as const;

export const BOTTOM_COLORS = [
  '#1e293b',
  '#334155',
  '#3f3f46',
  '#4c1d95',
  '#155e75',
  '#78350f',
  '#0f766e',
  '#94a3b8',
] as const;

/** The four palettes, by the key they colour. Iterated by the customization UI
 *  so adding a slot is a change here rather than in three files. */
export const AVATAR_PALETTES = {
  skin: SKIN_COLORS,
  hair: HAIR_COLORS,
  top: TOP_COLORS,
  bottom: BOTTOM_COLORS,
} as const;

export type AvatarColorSlot = keyof typeof AVATAR_PALETTES;

export interface AvatarColors {
  skin: number;
  hair: number;
  top: number;
  bottom: number;
}

/** `DC-4.1` — the selections that define how a participant looks. */
export interface AvatarAppearance {
  baseModel: AvatarBaseModel;
  colors: AvatarColors;
  accessories: AvatarAccessory[];
}

export const DEFAULT_APPEARANCE: AvatarAppearance = {
  baseModel: 'standard',
  colors: { skin: 1, hair: 0, top: 0, bottom: 0 },
  accessories: [],
};

/** Resolve a palette index to a colour, clamping rather than throwing: an index
 *  out of range is a client from a future version, and a wrong-but-visible
 *  avatar beats a crashed render loop. */
export function colorFor(slot: AvatarColorSlot, index: number): string {
  const palette = AVATAR_PALETTES[slot];
  const clamped = Math.min(Math.max(Math.trunc(index) || 0, 0), palette.length - 1);
  return palette[clamped]!;
}

/**
 * A distinct-looking appearance derived from a number.
 *
 * Guests get one at join so a room of people who never opened the customizer is
 * still a room of distinguishable people — which is what `colorForId` did for
 * the phase 1 capsules. Deterministic on purpose: the same participant looks the
 * same to everyone, including to a bot asserting on it.
 *
 * The three multipliers are coprime with the palette lengths, so consecutive
 * local ids differ in every slot rather than cycling one at a time.
 */
export function appearanceForSeed(seed: number): AvatarAppearance {
  const n = Math.abs(Math.trunc(seed) || 0);
  return {
    baseModel: AVATAR_BASE_MODELS[n % AVATAR_BASE_MODELS.length]!,
    colors: {
      skin: (n * 3) % SKIN_COLORS.length,
      hair: (n * 5) % HAIR_COLORS.length,
      top: (n * 7) % TOP_COLORS.length,
      bottom: (n * 11) % BOTTOM_COLORS.length,
    },
    accessories: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emotes (DC-4.4)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmoteDefinition {
  id: string;
  label: string;
  /** Shown in the emote bar and burst above the avatar — the "emoji burst" of
   *  `FR-4.14`, and the fallback for an avatar whose model has no such clip. */
  glyph: string;
  /** Animation clip name in the avatar asset. */
  clip: string;
  /**
   * How long it plays, before `EMOTE_MAX_DURATION_MS` clamps it.
   *
   * Authored per emote rather than one constant: a wave that lasts as long as a
   * dance either ends mid-gesture or leaves the dancer standing still. The
   * clamp is the guarantee (`FR-4.16`); this is the intent.
   */
  durationMs: number;
}

/**
 * The catalogue. `FR-4.14` names wave, thumbs-up, dance and an emoji burst as
 * examples; all four are here.
 */
export const EMOTES: readonly EmoteDefinition[] = [
  { id: 'wave', label: 'Wave', glyph: '👋', clip: 'wave', durationMs: 2200 },
  {
    id: 'thumbs-up',
    label: 'Thumbs up',
    glyph: '👍',
    clip: 'point',
    durationMs: 1800,
  },
  { id: 'clap', label: 'Clap', glyph: '👏', clip: 'clap', durationMs: 2400 },
  { id: 'dance', label: 'Dance', glyph: '🕺', clip: 'dance', durationMs: 4800 },
  { id: 'cheer', label: 'Cheer', glyph: '🎉', clip: 'cheer', durationMs: 2600 },
  {
    id: 'think',
    label: 'Thinking',
    glyph: '🤔',
    clip: 'think',
    durationMs: 3000,
  },
];

const EMOTES_BY_ID = new Map(EMOTES.map((emote) => [emote.id, emote]));

// ─────────────────────────────────────────────────────────────────────────────
// Animation (DC-4.2)
// ─────────────────────────────────────────────────────────────────────────────

/** The locomotion states `FR-4.2` asks for: idle and walk at minimum, run and
 *  an in-air state recommended — and movement supports both, so both exist. */
export const LOCOMOTION_CLIPS = ['idle', 'walk', 'run', 'jump'] as const;
export type LocomotionClip = (typeof LOCOMOTION_CLIPS)[number];

/**
 * The ground speed each locomotion clip was authored at, in metres per second.
 *
 * `FR-4.3` requires feet that match the actual speed, which is a playback rate
 * of `speed / reference`. The numbers are a property of the *asset*: they are
 * mirrored in `assets/avatars/build-avatars.mjs`, exactly as `office.map.json`
 * mirrors the layout in `build-world.mjs`. The client checks the clip *names*
 * against a loaded model and complains loudly if they have drifted — a silent
 * mismatch here is an avatar skating, which nobody traces back to a constant.
 */
export const CLIP_REFERENCE_SPEED_MPS: Record<'walk' | 'run', number> = {
  walk: 3.0,
  run: 6.0,
};

/** Every clip the avatar model must contain: locomotion plus one per emote. */
export const REQUIRED_AVATAR_CLIPS: readonly string[] = [
  ...LOCOMOTION_CLIPS,
  ...new Set(EMOTES.map((emote) => emote.clip)),
];

/**
 * Returns undefined for an unknown id.
 *
 * Callers drop those silently. An emote this build has never heard of is a
 * newer client talking to an older server, which the versioning rule in
 * wire-protocol.md says to ignore rather than to reject.
 */
export function emoteById(id: string): EmoteDefinition | undefined {
  return EMOTES_BY_ID.get(id);
}
