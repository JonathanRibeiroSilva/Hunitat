import type { HTMLAttributes } from 'react';
import { cn } from './cn.js';

/**
 * A translucent surface for HUD elements sitting over the 3D canvas.
 *
 * The backdrop blur and dark tint are not decoration: text contrast against a
 * moving 3D scene cannot be guaranteed, so HUD panels need a scrim to stay
 * legible (specs/ux/phase-01-screens.md, accessibility floor).
 */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-white/10 bg-slate-900/70 backdrop-blur-md',
        'text-slate-100 shadow-lg shadow-black/20',
        className,
      )}
      {...props}
    />
  );
}
