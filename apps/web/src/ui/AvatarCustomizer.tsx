/**
 * Avatar customization — FR-4.5, FR-4.6, FR-4.7.
 *
 * There is deliberately **no preview pane**. The camera is third-person
 * ([coordinates-and-units.md](../../../../specs/conventions/coordinates-and-units.md#camera)),
 * so you are already looking at your own avatar — a second, smaller copy of it
 * inside a panel would be a second renderer to keep in step with the first, and
 * the first is the one that tells the truth. Every change applies to the world
 * immediately, which is what `FR-4.7` asks for.
 *
 * Changes are optimistic: the local store updates on click and the frame goes
 * out alongside it. The server echoes it back as a `PARTICIPANT_UPDATE` that
 * lands on the same value, so there is nothing to reconcile — and a colour that
 * waited for a round trip would feel broken on a bad connection.
 */

import { useState } from 'react';
import {
  AVATAR_ACCESSORIES,
  AVATAR_BASE_MODELS,
  AVATAR_PALETTES,
  appearanceForSeed,
  type AvatarAccessory,
  type AvatarAppearance,
  type AvatarColorSlot,
} from '@hubitat/protocol';
import { Button, Panel, cn } from '@hubitat/ui';
import { auth } from '../auth/authClient.js';
import { net } from '../net/client.js';
import { useAuthStore } from '../state/authStore.js';
import { useStore } from '../state/store.js';

const BUILD_LABEL: Record<string, string> = {
  standard: 'Standard',
  slim: 'Slim',
  broad: 'Broad',
};

const SLOT_LABEL: Record<AvatarColorSlot, string> = {
  skin: 'Skin',
  hair: 'Hair',
  top: 'Top',
  bottom: 'Bottom',
};

const ACCESSORY_LABEL: Record<AvatarAccessory, string> = {
  cap: 'Cap',
  glasses: 'Glasses',
  backpack: 'Backpack',
};

export function AvatarCustomizer({ onClose }: { onClose: () => void }) {
  const appearance = useStore((state) => state.appearance);

  const apply = (next: AvatarAppearance): void => {
    useStore.getState().setAppearance(next);
    net.setAppearance(next);
    /**
     * Phase 6, `FR-6.9`/`FR-6.10` — an account's avatar lives in its profile.
     *
     * Fire-and-forget alongside the socket frame rather than instead of it. The
     * frame is what everybody in the room sees *now*; this is what makes it
     * still true tomorrow, and on the person's other machine. Guests skip it and
     * keep the phase 4 behaviour: remembered per browser, because until phase 6
     * there was no identity to remember it with.
     *
     * A failure is swallowed. The change has already been applied and
     * broadcast, and a toast saying the profile did not save would be about a
     * hat.
     */
    if (auth.signedIn) {
      void auth
        .updateProfile({ appearance: next })
        .then((account) => useAuthStore.getState().setAccount(account))
        .catch(() => undefined);
    }
  };

  return (
    <Panel
      role="dialog"
      aria-label="Customize your avatar"
      /*
       * Placed by the right rail, directly above the status panel that opens
       * it. It used to pin itself to `bottom-20`, which on a narrow window put
       * it across the centred emote bar.
       *
       * Scrolls rather than growing: four palettes and the accessory row run to
       * around 30rem, which on a short viewport would otherwise reach up into
       * the presence list.
       */
      className="pointer-events-auto max-h-[min(32rem,calc(100vh-9rem))] w-72
                 max-w-(--hud-rail) shrink-0 overflow-y-auto p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Your avatar</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close avatar customization"
          className="rounded px-1.5 text-slate-500 hover:text-slate-200
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          ×
        </button>
      </div>

      <Field label="Build">
        <div className="flex gap-1">
          {AVATAR_BASE_MODELS.map((model) => (
            <Chip
              key={model}
              selected={appearance.baseModel === model}
              onClick={() => apply({ ...appearance, baseModel: model })}
            >
              {BUILD_LABEL[model] ?? model}
            </Chip>
          ))}
        </div>
      </Field>

      {(Object.keys(AVATAR_PALETTES) as AvatarColorSlot[]).map((slot) => (
        <Field key={slot} label={SLOT_LABEL[slot]}>
          <div className="flex flex-wrap gap-1.5">
            {AVATAR_PALETTES[slot].map((color, index) => (
              <button
                key={color}
                type="button"
                onClick={() =>
                  apply({
                    ...appearance,
                    colors: { ...appearance.colors, [slot]: index },
                  })
                }
                aria-label={`${SLOT_LABEL[slot]} colour ${index + 1}`}
                aria-pressed={appearance.colors[slot] === index}
                style={{ backgroundColor: color }}
                className={cn(
                  'h-6 w-6 rounded-full border transition-transform',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
                  // Selection is a ring and a scale, not a tint: on a palette of
                  // colours, a colour cannot be the thing that marks a colour.
                  appearance.colors[slot] === index
                    ? 'scale-110 border-white ring-2 ring-white/70'
                    : 'border-white/20 hover:scale-105',
                )}
              />
            ))}
          </div>
        </Field>
      ))}

      <Field label="Accessories">
        <div className="flex flex-wrap gap-1">
          {AVATAR_ACCESSORIES.map((accessory) => {
            const worn = appearance.accessories.includes(accessory);
            return (
              <Chip
                key={accessory}
                selected={worn}
                onClick={() =>
                  apply({
                    ...appearance,
                    accessories: worn
                      ? appearance.accessories.filter((item) => item !== accessory)
                      : [...appearance.accessories, accessory],
                  })
                }
              >
                {ACCESSORY_LABEL[accessory]}
              </Chip>
            );
          })}
        </div>
      </Field>

      <Button
        variant="ghost"
        className="mt-4 w-full"
        // Seeded from the clock rather than from the local id: a "surprise me"
        // that returns the same avatar every time is not one.
        onClick={() => apply(appearanceForSeed(Date.now()))}
      >
        Surprise me
      </Button>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      {children}
    </div>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'rounded-lg px-2.5 py-1 text-xs transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300',
        selected
          ? 'bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/50'
          : 'bg-white/5 text-slate-300 hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}
