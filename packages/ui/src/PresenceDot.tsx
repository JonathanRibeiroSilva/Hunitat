import { cn } from './cn.js';

export type Presence = 'available' | 'away' | 'do-not-disturb';

const LABEL: Record<Presence, string> = {
  available: 'Available',
  away: 'Away',
  'do-not-disturb': 'Do not disturb',
};

/**
 * `DC-4.3` presence status — phase 4.
 *
 * Distinct from `StatusDot`, which shows *activity* (`FR-1.22`, server-derived).
 * The two are different facts and the presence list shows both: someone can be
 * available and idle, or at their desk with do-not-disturb on.
 *
 * Shape as well as colour, matching the glyph over the avatar's head: filled for
 * available, hollow for away, a bar for do-not-disturb. Colour is never the only
 * signal (specs/ux/phase-01-screens.md), and the world and the HUD must agree
 * about what a status looks like.
 */
export function PresenceDot({ status, className }: { status: Presence; className?: string }) {
  return (
    <span
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
      className={cn(
        'inline-block shrink-0',
        status === 'do-not-disturb'
          ? 'h-1 w-2.5 rounded-sm bg-rose-400'
          : status === 'away'
            ? 'h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-transparent'
            : 'h-2.5 w-2.5 rounded-full border border-emerald-400 bg-emerald-400',
        className,
      )}
    />
  );
}
