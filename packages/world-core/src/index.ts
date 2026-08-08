/**
 * @hubitat/world-core — pure world logic, shared by the browser, the server and
 * the test bots.
 *
 * No Node APIs, no DOM APIs, no framework. That constraint is load-bearing: it
 * is what lets the same interest-management and audience code run in all three
 * places, which is how FR-1.16 and the Phase 5 consistency rule are met without
 * two implementations drifting apart (ADR 0001).
 */

export * from './spatial-grid.js';
export * from './aoi.js';
export * from './zones.js';
export * from './resolve-audience.js';
export * from './chat-recipients.js';
export * from './interpolation.js';
