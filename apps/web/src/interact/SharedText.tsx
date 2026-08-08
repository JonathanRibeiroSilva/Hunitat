/**
 * `FR-10.8`, `FR-10.11` — a note two people can edit at once.
 *
 * ── Why `Y.Text` and not a shared string ────────────────────────────────────
 *
 * A string in a `Y.Map` converges — the last write wins — and that is precisely
 * wrong for text: two people typing in different paragraphs would each lose the
 * other's paragraph, alternately, for as long as they both kept typing. `Y.Text`
 * merges at the character level, so both edits survive and the cursor stays
 * where its owner left it.
 *
 * ── Why the textarea is patched rather than replaced ────────────────────────
 *
 * Writing the whole value back on every keystroke would delete and re-insert the
 * document, which is a CRDT operation the size of the note and would move
 * everybody else's cursor to the end. So the change is reduced to the smallest
 * `{ index, remove, insert }` that explains it, which for ordinary typing is one
 * character.
 */

import { useEffect, useRef } from 'react';
import { YJS_KEYS } from '@hubitat/protocol';
import type { CollabSession } from './collabClient.js';
import { useCollab } from './useCollab.js';

export function SharedText({
  session,
  placeholder,
}: {
  session: CollabSession;
  placeholder: string;
}) {
  const { status } = useCollab(session);
  const area = useRef<HTMLTextAreaElement>(null);
  const text = session.doc.getText(YJS_KEYS.text);
  const value = text.toString();

  // A note that has never been opened starts as what its author typed into the
  // editor. Seeded once, and only when genuinely empty — seeding a document
  // people have already cleared would re-fill it every time the last person left.
  useEffect(() => {
    if (status !== 'ready') return;
    if (text.length > 0 || placeholder.length === 0) return;
    session.mutate(() => text.insert(0, placeholder));
  }, [status, text, placeholder, session]);

  if (status !== 'ready') {
    return (
      <p className="py-8 text-center text-sm text-slate-500">
        {status === 'refused'
          ? (session.refusal ?? 'You cannot open this from here.')
          : 'Loading this note…'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        ref={area}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          const patch = diff(value, next);
          if (!patch) return;
          session.mutate(() => {
            if (patch.remove > 0) text.delete(patch.index, patch.remove);
            if (patch.insert) text.insert(patch.index, patch.insert);
          });
        }}
        className="h-[50vh] w-full resize-none rounded-lg border border-white/10 bg-slate-950/60 p-3 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      />
      <p className="text-[11px] text-slate-500">
        Shared — everybody here is editing the same text, and it merges rather than overwriting.
      </p>
    </div>
  );
}

/**
 * The smallest edit that turns `before` into `after`.
 *
 * Common prefix, common suffix, and whatever is between them. That is exactly
 * right for the way a textarea actually changes — a keystroke, a paste, a
 * selection replaced — and it is what keeps an ordinary character insertion from
 * being a document-sized CRDT operation.
 */
function diff(
  before: string,
  after: string,
): { index: number; remove: number; insert: string } | null {
  if (before === after) return null;

  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;

  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }

  return {
    index: start,
    remove: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}
