/**
 * Root Prettier configuration.
 *
 * A re-export rather than a copy: `packages/config` is where the shared style
 * lives, and two files claiming to define it is how they drift.
 *
 * It has to exist **at the root**, though, and that is the part worth writing
 * down. Prettier resolves configuration by walking up from each file it
 * formats, and it stops at the repository root — a config that only exists
 * inside `packages/config` is never found for anything outside it. Without this
 * file, `npm run format` silently used Prettier's defaults and rewrote the
 * entire codebase from single quotes to double, in one pass, with no error.
 */

export { default } from './packages/config/prettier.config.js';
