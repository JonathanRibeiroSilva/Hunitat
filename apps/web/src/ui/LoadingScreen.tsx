/**
 * LOADING — specs/ux/phase-01-screens.md
 *
 * Not a decorative spinner: each step is real work, and naming the current one
 * is what makes a failure actionable. NFR-13 budgets 8 s for all of it.
 */

import { Panel } from '@hubitat/ui';
import { useStore, type LoadStep } from '../state/store.js';

const STEPS: { key: LoadStep; label: string }[] = [
  { key: 'connecting', label: 'Connecting to server' },
  { key: 'physics', label: 'Initialising physics' },
  { key: 'downloading-world', label: 'Downloading world' },
  { key: 'building-collision', label: 'Building collision' },
  { key: 'loading-avatar', label: 'Loading avatars' },
  { key: 'entering', label: 'Entering world' },
];

export function LoadingScreen() {
  const current = useStore((state) => state.loadStep);
  const progress = useStore((state) => state.loadProgress);
  const currentIndex = STEPS.findIndex((step) => step.key === current);

  return (
    <div className="flex h-full items-center justify-center bg-slate-950 p-6">
      <Panel className="w-full max-w-sm p-8">
        <h2 className="text-lg font-medium">Entering the world…</h2>

        <ol className="mt-6 space-y-3">
          {STEPS.map((step, index) => {
            const done = index < currentIndex;
            const active = index === currentIndex;
            return (
              <li key={step.key} className="flex items-center gap-3 text-sm">
                <span
                  aria-hidden
                  className={
                    done
                      ? 'h-2 w-2 rounded-full bg-emerald-400'
                      : active
                        ? 'h-2 w-2 animate-pulse rounded-full bg-sky-400'
                        : 'h-2 w-2 rounded-full bg-slate-600'
                  }
                />
                <span className={done || active ? 'text-slate-200' : 'text-slate-500'}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <div
          className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-slate-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        </div>
      </Panel>
    </div>
  );
}
