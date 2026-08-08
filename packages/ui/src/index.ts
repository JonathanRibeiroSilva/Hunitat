/**
 * @hubitat/ui — shared interface primitives.
 *
 * shadcn/ui's model: the components live in the repository rather than in a
 * dependency, so they can be shaped to fit an overlay on a 3D canvas without
 * fighting a library's theming (ADR 0002).
 *
 * Consumed as source by the Vite app, so Tailwind's scanner sees the class
 * names — a pre-built package would have them compiled away.
 */

export { Button } from './Button.js';
export { Panel } from './Panel.js';
export { StatusDot } from './StatusDot.js';
export { PresenceDot, type Presence } from './PresenceDot.js';
export { cn } from './cn.js';
