import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
}

const VARIANTS = {
  primary: 'bg-sky-500 text-white hover:bg-sky-400 active:bg-sky-600',
  ghost: 'bg-white/10 text-slate-100 hover:bg-white/20 active:bg-white/5',
} as const;

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium',
        'transition-colors duration-150',
        // A visible focus ring is the floor for keyboard navigation
        // (specs/ux/phase-01-screens.md).
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
