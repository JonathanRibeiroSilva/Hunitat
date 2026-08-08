/**
 * Binary codecs for the hot path. See specs/protocol/wire-protocol.md.
 *
 * This is the only place byte offsets are written. Client, server and the test
 * bots all encode and decode through here — that shared implementation is the
 * one thing preventing silent disagreement about layout (ADR 0001, ADR 0003).
 *
 * All multi-byte integers are little-endian.
 */

import { Op } from './opcodes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Quantization
//
// Position: i16 centimetres → 1 cm resolution, hard range ±327.67 m.
// Yaw:      u8              → 2π/256 ≈ 1.4°.
//
// The position range is a hard limit on world size, enforced by the Map Document
// validator so it fails at authoring time rather than as visual corruption.
// ─────────────────────────────────────────────────────────────────────────────

export const POSITION_SCALE = 100;
export const POSITION_MIN_M = -327.68;
export const POSITION_MAX_M = 327.67;
export const YAW_STEPS = 256;
const TWO_PI = Math.PI * 2;

/** Metres → i16 centimetres. Clamping is silent: a client reporting an
 *  out-of-bounds position has already failed collision, and a well-formed frame
 *  beats propagating a bad value. */
export function quantizePosition(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  const cm = Math.round(metres * POSITION_SCALE);
  return Math.max(-32768, Math.min(32767, cm));
}

export function dequantizePosition(centimetres: number): number {
  return centimetres / POSITION_SCALE;
}

/** Radians → u8. Normalises to [0, 2π) first, so 2π wraps to 0 rather than
 *  overflowing. */
export function quantizeYaw(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const normalized = ((radians % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((normalized / TWO_PI) * YAW_STEPS) & 0xff;
}

export function dequantizeYaw(value: number): number {
  return (value & 0xff) * (TWO_PI / YAW_STEPS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Transform {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const Flags = {
  GROUNDED: 1 << 0,
  RUNNING: 1 << 1,
  JUMPING: 1 << 2,
} as const;

export interface TransformFrame {
  transform: Transform;
  flags: number;
}

export interface BatchEntry {
  id: number;
  transform: Transform;
  flags: number;
}

export const TRANSFORM_FRAME_BYTES = 9;
export const BATCH_HEADER_BYTES = 3;
export const BATCH_ENTRY_BYTES = 10;

// ─────────────────────────────────────────────────────────────────────────────
// View helper
//
// In Node, `ws` hands us a Buffer, which is often a view into a larger pooled
// ArrayBuffer. Ignoring byteOffset here reads someone else's bytes — a bug that
// only appears under load, when pooling kicks in.
// ─────────────────────────────────────────────────────────────────────────────

export function toDataView(data: ArrayBuffer | ArrayBufferView): DataView {
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  return new DataView(data);
}

export function readOpcode(data: ArrayBuffer | ArrayBufferView): number | null {
  const view = toDataView(data);
  if (view.byteLength < 1) return null;
  return view.getUint8(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x01 TRANSFORM — client → server
// ─────────────────────────────────────────────────────────────────────────────

export function encodeTransform(transform: Transform, flags = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(TRANSFORM_FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, Op.TRANSFORM);
  view.setInt16(1, quantizePosition(transform.x), true);
  view.setInt16(3, quantizePosition(transform.y), true);
  view.setInt16(5, quantizePosition(transform.z), true);
  view.setUint8(7, quantizeYaw(transform.yaw));
  view.setUint8(8, flags & 0xff);
  return buffer;
}

/** Returns null on a malformed frame. Length is validated before any offset is
 *  read — a truncated frame must never be read past its end. */
export function decodeTransform(data: ArrayBuffer | ArrayBufferView): TransformFrame | null {
  const view = toDataView(data);
  if (view.byteLength !== TRANSFORM_FRAME_BYTES) return null;
  if (view.getUint8(0) !== Op.TRANSFORM) return null;

  return {
    transform: {
      x: dequantizePosition(view.getInt16(1, true)),
      y: dequantizePosition(view.getInt16(3, true)),
      z: dequantizePosition(view.getInt16(5, true)),
      yaw: dequantizeYaw(view.getUint8(7)),
    },
    flags: view.getUint8(8),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x02 TRANSFORM_BATCH — server → client
//
// One frame per recipient per tick, carrying only that recipient's current
// area-of-interest set (FR-1.16). 10 bytes per participant against roughly 40
// as JSON.
// ─────────────────────────────────────────────────────────────────────────────

export function encodeTransformBatch(entries: readonly BatchEntry[]): ArrayBuffer {
  const count = Math.min(entries.length, 0xffff);
  const buffer = new ArrayBuffer(BATCH_HEADER_BYTES + count * BATCH_ENTRY_BYTES);
  const view = new DataView(buffer);

  view.setUint8(0, Op.TRANSFORM_BATCH);
  view.setUint16(1, count, true);

  for (let i = 0; i < count; i++) {
    const entry = entries[i]!;
    const at = BATCH_HEADER_BYTES + i * BATCH_ENTRY_BYTES;
    view.setUint16(at, entry.id & 0xffff, true);
    view.setInt16(at + 2, quantizePosition(entry.transform.x), true);
    view.setInt16(at + 4, quantizePosition(entry.transform.y), true);
    view.setInt16(at + 6, quantizePosition(entry.transform.z), true);
    view.setUint8(at + 8, quantizeYaw(entry.transform.yaw));
    view.setUint8(at + 9, entry.flags & 0xff);
  }

  return buffer;
}

export function decodeTransformBatch(data: ArrayBuffer | ArrayBufferView): BatchEntry[] | null {
  const view = toDataView(data);
  if (view.byteLength < BATCH_HEADER_BYTES) return null;
  if (view.getUint8(0) !== Op.TRANSFORM_BATCH) return null;

  const count = view.getUint16(1, true);
  const expected = BATCH_HEADER_BYTES + count * BATCH_ENTRY_BYTES;

  // Reject a truncated batch outright rather than returning a partial set: a
  // partial set would look like people leaving area of interest.
  if (view.byteLength !== expected) return null;

  const entries: BatchEntry[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const at = BATCH_HEADER_BYTES + i * BATCH_ENTRY_BYTES;
    entries[i] = {
      id: view.getUint16(at, true),
      transform: {
        x: dequantizePosition(view.getInt16(at + 2, true)),
        y: dequantizePosition(view.getInt16(at + 4, true)),
        z: dequantizePosition(view.getInt16(at + 6, true)),
        yaw: dequantizeYaw(view.getUint8(at + 8)),
      },
      flags: view.getUint8(at + 9),
    };
  }

  return entries;
}
