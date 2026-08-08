/**
 * ERROR — the state the Phase 1 Rules demand:
 *
 *   > If the static world fails to load, the client must show a clear failure
 *   > state rather than dropping the user into an empty void.
 *
 * Retry appears only where retrying can plausibly work. A retry button on a
 * corrupt world file teaches users that buttons lie.
 */

import { useState } from 'react';
import { Button, Panel } from '@hubitat/ui';
import { useStore } from '../state/store.js';

export function ErrorScreen({ onRetry, onBack }: { onRetry: () => void; onBack: () => void }) {
  const failure = useStore((state) => state.failure);
  const [showTechnical, setShowTechnical] = useState(false);

  if (!failure) return null;

  return (
    <div className="flex h-full items-center justify-center bg-slate-950 p-6">
      <Panel className="w-full max-w-md p-8">
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-rose-400" />
          <div>
            <h2 className="text-lg font-medium">{failure.title}</h2>
            <p className="mt-2 text-sm text-slate-400">{failure.detail}</p>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          {failure.retryable && <Button onClick={onRetry}>Retry</Button>}
          <Button variant="ghost" onClick={onBack}>
            Back to start
          </Button>
        </div>

        {failure.technical && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <button
              onClick={() => setShowTechnical((value) => !value)}
              className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-300
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              {showTechnical ? 'Hide' : 'Show'} technical detail
            </button>
            {showTechnical && (
              <pre
                className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg
                              bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400"
              >
                {failure.technical}
              </pre>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
