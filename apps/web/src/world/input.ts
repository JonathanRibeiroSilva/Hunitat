/**
 * Keyboard and pointer input.
 *
 * Module-level mutable state read inside `useFrame`. Routing key presses
 * through React state would re-render the tree on every keydown, which is both
 * pointless and expensive next to a 3D scene (ADR 0002).
 *
 * Bindings: specs/conventions/coordinates-and-units.md#input-mapping
 */

export interface InputState {
  forward: number;
  right: number;
  run: boolean;
  jump: boolean;
  /** Camera orbit deltas, consumed and cleared each frame. */
  yawDelta: number;
  pitchDelta: number;
  zoomDelta: number;
  /** Anything that counts as activity, for the idle timer (FR-1.22). */
  lastActivityAt: number;
}

export const input: InputState = {
  forward: 0,
  right: 0,
  run: false,
  jump: false,
  yawDelta: 0,
  pitchDelta: 0,
  zoomDelta: 0,
  lastActivityAt: performance.now(),
};

const pressed = new Set<string>();
const MOUSE_SENSITIVITY = 0.0028;

export function attachInput(canvas: HTMLElement): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    pressed.add(event.code);
    input.lastActivityAt = performance.now();
    if (event.code === 'Space') {
      input.jump = true;
      // Otherwise the page scrolls under the canvas.
      event.preventDefault();
    }
    updateAxes();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    pressed.delete(event.code);
    updateAxes();
  };

  // Release everything when focus leaves. Without this, alt-tabbing while
  // holding W leaves the avatar walking into a wall forever.
  const onBlur = () => {
    pressed.clear();
    updateAxes();
  };

  let dragging = false;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerUp = (event: PointerEvent) => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    input.yawDelta -= event.movementX * MOUSE_SENSITIVITY;
    input.pitchDelta -= event.movementY * MOUSE_SENSITIVITY;
    input.lastActivityAt = performance.now();
  };

  const onWheel = (event: WheelEvent) => {
    input.zoomDelta += Math.sign(event.deltaY) * 0.5;
    input.lastActivityAt = performance.now();
    event.preventDefault();
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    pressed.clear();
  };
}

function updateAxes(): void {
  const forward = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
  const right = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);

  input.forward = forward;
  input.right = right;
  input.run = has('ShiftLeft', 'ShiftRight');

  if (forward !== 0 || right !== 0) input.lastActivityAt = performance.now();
}

function has(...codes: string[]): boolean {
  return codes.some((code) => pressed.has(code));
}

/** Arrow keys alone must be enough to move and look — no action may require a
 *  mouse drag (specs/ux/phase-01-screens.md, accessibility floor). */
export function applyKeyboardCameraOrbit(delta: number): void {
  const speed = 1.8 * delta;
  if (has('KeyQ')) input.yawDelta += speed;
  if (has('KeyE')) input.yawDelta -= speed;
  if (has('PageUp')) input.pitchDelta += speed;
  if (has('PageDown')) input.pitchDelta -= speed;
}
