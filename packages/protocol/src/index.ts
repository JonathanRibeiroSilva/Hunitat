/**
 * @hubitat/protocol — the single definition of what goes on the wire.
 *
 * Imported by apps/web, apps/api and apps/harness. A change to a byte layout
 * breaks all three compilations at once instead of producing silent runtime
 * drift (ADR 0001).
 *
 * This package must not import Node or DOM APIs.
 */

export * from './constants.js';
export * from './opcodes.js';
export * from './binary.js';
export * from './avatar.js';
export * from './chat.js';
export * from './identity.js';
export * from './moderation.js';
export * from './messages.js';
export * from './auth.js';
export * from './map-document.js';
export * from './space.js';
export * from './editor.js';
export * from './interactive.js';
