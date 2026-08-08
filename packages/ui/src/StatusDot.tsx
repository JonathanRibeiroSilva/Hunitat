import { cn } from './cn.js';

export type Activity = 'active' | 'idle';

/**
 * Colour is never the only signal (specs/ux/phase-01-screens.md), so the dot
 * carries a shape difference too — filled for active, hollow for idle — and a
 * title for assistive technology.
 */
export function StatusDot({ activity, className }: { activity: Activity; className?: string }) {
  const isActive = activity === 'active';
  return (
    <span
      role="img"
      aria-label={isActive ? 'active' : 'idle'}
      title={isActive ? 'Active' : 'Idle'}
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full border',
        isActive ? 'border-emerald-400 bg-emerald-400' : 'border-slate-400 bg-transparent',
        className,
      )}
    />
  );
}
