/**
 * Which keystrokes the world may claim.
 *
 * Global shortcuts in a 3D client have one recurring failure: a key that moves
 * the avatar is also a letter somebody is trying to type. Phase 4 hit it with
 * the emote digits; phase 5 makes it constant, because chat means there is
 * almost always a text field on screen.
 *
 * So the test lives in one place rather than being re-derived per shortcut. A
 * second copy is a second list of element types to remember, and the symptom of
 * forgetting one is a person walking into a wall while typing "swimming".
 */

/** A field where a keystroke is already text. */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable;
}

/**
 * A control where Enter or Space already means "activate this".
 *
 * Separate from `isTextEntry` because the two shortcuts want different answers:
 * the emote digits are free to fire while a button has focus, and Enter is not —
 * it would open chat *and* press the button.
 */
export function isActivatable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'BUTTON' || tag === 'SELECT' || tag === 'A' || tag === 'SUMMARY';
}
