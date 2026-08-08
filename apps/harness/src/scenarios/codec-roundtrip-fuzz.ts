/**
 * codec-roundtrip-fuzz — protects the binary wire format.
 *
 * Two halves, because they catch different things:
 *
 *   1. Local fuzz. Tens of thousands of random and extreme values through the
 *      encoders and decoders directly. Exhaustive, instant, and catches any
 *      change to a byte offset or a quantization formula.
 *   2. Wire round-trip. A handful of transforms actually sent bot → server →
 *      bot. Far fewer samples, but it exercises the real path: Buffer byteOffset
 *      handling, the batch header, and the server's storage of what it received.
 *
 * Without (1) the coverage is thin; without (2) a codec that is internally
 * consistent but wrong on the wire would pass.
 */

import {
  POSITION_MAX_M,
  POSITION_MIN_M,
  decodeTransform,
  decodeTransformBatch,
  encodeTransform,
  encodeTransformBatch,
  type BatchEntry,
  type Transform,
} from '@hubitat/protocol';
import { Bot, sleep, waitUntil } from '../bot.js';
import { assert, assertClose, type Scenario } from '../runner.js';

/** Position quantizes to 1 cm, so rounding error is at most half a step. */
const POSITION_TOLERANCE_M = 0.005 + 1e-9;
/** Yaw quantizes to 2π/256, so rounding error is at most half a step. */
const YAW_TOLERANCE_RAD = Math.PI / 256 + 1e-9;

const LOCAL_SAMPLES = 20_000;
const WIRE_SAMPLES = 25;

/**
 * Where the wire round-trip is performed — deliberately nowhere near the map.
 *
 * This scenario is about bytes, not world rules, and the two collide: sampling
 * random positions across the office eventually drops a bot onto a portal, the
 * server teleports it (correctly), and the transform that comes back is not the
 * one that went out. That reads as a codec regression and is not one.
 *
 * Bots are authoritative over their own position (ADR 0004) and are not confined
 * to the map, so moving out here costs nothing and keeps the test immune to
 * whatever a later phase authors into the world. Well inside POSITION_MAX_M.
 */
const FAR_FIELD = { x: 200, z: 200 };
const SAMPLE_SPREAD_M = 10;

export const codecRoundtripFuzz: Scenario = {
  name: 'codec-roundtrip-fuzz',
  covers: 'wire format integrity (specs/protocol/wire-protocol.md)',

  async run(ctx) {
    localFuzz(ctx.log);
    extremes(ctx.log);
    batchFuzz(ctx.log);
    await wireRoundTrip(ctx.url, ctx.log);
  },
};

// ─────────────────────────────────────────────────────────────────────────────

function localFuzz(log: (m: string) => void): void {
  let worstPosition = 0;
  let worstYaw = 0;

  for (let i = 0; i < LOCAL_SAMPLES; i++) {
    const original: Transform = {
      x: randomIn(-300, 300),
      y: randomIn(-50, 50),
      z: randomIn(-300, 300),
      yaw: randomIn(0, Math.PI * 2),
    };
    const flags = Math.floor(Math.random() * 8);

    const decoded = decodeTransform(encodeTransform(original, flags));
    assert(decoded !== null, `sample ${i}: decodeTransform returned null`);

    worstPosition = Math.max(
      worstPosition,
      Math.abs(decoded.transform.x - original.x),
      Math.abs(decoded.transform.y - original.y),
      Math.abs(decoded.transform.z - original.z),
    );
    worstYaw = Math.max(worstYaw, angleDelta(decoded.transform.yaw, original.yaw));

    assert(decoded.flags === flags, `sample ${i}: flags ${decoded.flags} !== ${flags}`);
  }

  assert(
    worstPosition <= POSITION_TOLERANCE_M,
    `worst position error ${worstPosition} m exceeds ${POSITION_TOLERANCE_M} m`,
  );
  assert(
    worstYaw <= YAW_TOLERANCE_RAD,
    `worst yaw error ${worstYaw} rad exceeds ${YAW_TOLERANCE_RAD} rad`,
  );

  log(
    `local: ${LOCAL_SAMPLES} samples · worst position ${(worstPosition * 1000).toFixed(2)} mm · ` +
      `worst yaw ${((worstYaw * 180) / Math.PI).toFixed(3)}°`,
  );
}

/** The values that break naive implementations. */
function extremes(log: (m: string) => void): void {
  const cases: { label: string; input: Transform; expectClamp?: boolean }[] = [
    { label: 'origin', input: { x: 0, y: 0, z: 0, yaw: 0 } },
    {
      label: 'min bound',
      input: {
        x: POSITION_MIN_M,
        y: POSITION_MIN_M,
        z: POSITION_MIN_M,
        yaw: 0,
      },
    },
    {
      label: 'max bound',
      input: {
        x: POSITION_MAX_M,
        y: POSITION_MAX_M,
        z: POSITION_MAX_M,
        yaw: 0,
      },
    },
    {
      label: 'yaw 2π wraps to 0',
      input: { x: 0, y: 0, z: 0, yaw: Math.PI * 2 },
    },
    {
      label: 'yaw just under 2π',
      input: { x: 0, y: 0, z: 0, yaw: Math.PI * 2 - 1e-6 },
    },
    {
      label: 'negative yaw normalises',
      input: { x: 0, y: 0, z: 0, yaw: -Math.PI / 2 },
    },
    {
      label: 'out of range clamps',
      input: { x: 9999, y: -9999, z: 9999, yaw: 0 },
      expectClamp: true,
    },
    {
      label: 'non-finite becomes 0',
      input: { x: NaN, y: Infinity, z: -Infinity, yaw: NaN },
      expectClamp: true,
    },
  ];

  for (const testCase of cases) {
    const decoded = decodeTransform(encodeTransform(testCase.input));
    assert(decoded !== null, `${testCase.label}: decode returned null`);

    // Whatever comes back must at least be representable — a decoder that emits
    // NaN would poison every downstream distance calculation.
    for (const axis of ['x', 'y', 'z', 'yaw'] as const) {
      const value = decoded.transform[axis];
      assert(Number.isFinite(value), `${testCase.label}: ${axis} decoded as ${value}`);
    }

    if (!testCase.expectClamp) {
      assertClose(
        decoded.transform.x,
        testCase.input.x,
        POSITION_TOLERANCE_M,
        `${testCase.label}: x`,
      );
      assertClose(
        decoded.transform.z,
        testCase.input.z,
        POSITION_TOLERANCE_M,
        `${testCase.label}: z`,
      );
      assert(
        angleDelta(decoded.transform.yaw, testCase.input.yaw) <= YAW_TOLERANCE_RAD,
        `${testCase.label}: yaw ${decoded.transform.yaw} vs ${testCase.input.yaw}`,
      );
    }
  }

  // Truncated and malformed frames must be rejected, never read past their end.
  assert(decodeTransform(new Uint8Array(4)) === null, 'truncated transform was accepted');
  assert(decodeTransformBatch(new Uint8Array(2)) === null, 'truncated batch header was accepted');

  const shortBatch = new Uint8Array(encodeTransformBatch([{ id: 1, transform: zero(), flags: 0 }]));
  assert(
    decodeTransformBatch(shortBatch.subarray(0, shortBatch.length - 3)) === null,
    'batch with a truncated entry was accepted',
  );

  log(`extremes: ${cases.length} edge cases + 3 malformed frames rejected`);
}

function batchFuzz(log: (m: string) => void): void {
  let maxCount = 0;

  for (let round = 0; round < 200; round++) {
    const count = Math.floor(Math.random() * 60);
    maxCount = Math.max(maxCount, count);

    const entries: BatchEntry[] = Array.from({ length: count }, (_, i) => ({
      id: (i * 977 + round) & 0xffff,
      transform: {
        x: randomIn(-200, 200),
        y: randomIn(-20, 20),
        z: randomIn(-200, 200),
        yaw: randomIn(0, Math.PI * 2),
      },
      flags: Math.floor(Math.random() * 8),
    }));

    const decoded = decodeTransformBatch(encodeTransformBatch(entries));
    assert(decoded !== null, `round ${round}: batch decode returned null`);
    assert(
      decoded.length === count,
      `round ${round}: got ${decoded.length} entries, sent ${count}`,
    );

    for (let i = 0; i < count; i++) {
      const sent = entries[i]!;
      const got = decoded[i]!;
      assert(got.id === sent.id, `round ${round} entry ${i}: id ${got.id} !== ${sent.id}`);
      assertClose(
        got.transform.x,
        sent.transform.x,
        POSITION_TOLERANCE_M,
        `round ${round} entry ${i}: x`,
      );
      assertClose(
        got.transform.z,
        sent.transform.z,
        POSITION_TOLERANCE_M,
        `round ${round} entry ${i}: z`,
      );
      assert(got.flags === sent.flags, `round ${round} entry ${i}: flags`);
    }
  }

  log(`batch: 200 rounds, up to ${maxCount} entries, order and ids preserved`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function wireRoundTrip(url: string, log: (m: string) => void): Promise<void> {
  const sender = new Bot(url, 'codec-sender');
  const observer = new Bot(url, 'codec-observer');

  try {
    await sender.connect();
    await observer.connect();
    await sender.join();
    await observer.join();

    observer.moveTo(FAR_FIELD.x, FAR_FIELD.z);
    sender.moveTo(FAR_FIELD.x + 1, FAR_FIELD.z + 1);

    await waitUntil(() => observer.remotes.has(sender.localId), 3000, 'observer to see the sender');

    let worst = 0;

    for (let i = 0; i < WIRE_SAMPLES; i++) {
      const target: Transform = {
        x: FAR_FIELD.x + randomIn(-SAMPLE_SPREAD_M, SAMPLE_SPREAD_M),
        y: 0,
        z: FAR_FIELD.z + randomIn(-SAMPLE_SPREAD_M, SAMPLE_SPREAD_M),
        yaw: randomIn(0, Math.PI * 2),
      };
      sender.transform = target;
      sender.sendTransform();

      // Three ticks: one for the server to store it, one to fan it out, one of
      // slack for scheduling.
      await sleep(150);

      const seen = observer.remotes.get(sender.localId);
      assert(seen !== undefined, `sample ${i}: sender vanished from observer`);

      worst = Math.max(
        worst,
        Math.abs(seen.transform.x - target.x),
        Math.abs(seen.transform.z - target.z),
      );

      assertClose(seen.transform.x, target.x, POSITION_TOLERANCE_M, `wire sample ${i}: x`);
      assertClose(seen.transform.z, target.z, POSITION_TOLERANCE_M, `wire sample ${i}: z`);
      assert(
        angleDelta(seen.transform.yaw, target.yaw) <= YAW_TOLERANCE_RAD,
        `wire sample ${i}: yaw off by ${angleDelta(seen.transform.yaw, target.yaw)} rad`,
      );
    }

    log(
      `wire: ${WIRE_SAMPLES} transforms round-tripped through the server · ` +
        `worst error ${(worst * 1000).toFixed(2)} mm`,
    );
  } finally {
    sender.close();
    observer.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function randomIn(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function zero(): Transform {
  return { x: 0, y: 0, z: 0, yaw: 0 };
}

/** Shortest angular distance, so 0 and 2π-ε compare as adjacent rather than
 *  a full turn apart. */
function angleDelta(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  const diff = Math.abs(((a - b) % twoPi) + twoPi) % twoPi;
  return Math.min(diff, twoPi - diff);
}
