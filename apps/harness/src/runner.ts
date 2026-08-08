/**
 * Scenario runner.
 *
 * This is the project's test mechanism — there is no unit suite. The scenarios
 * assert against a running server, so AOI and codec regressions fail here rather
 * than turning up later as avatars in the wrong place. See
 * docs/testing-strategy.md.
 */

import { closeAllBots } from './bot.js';
import { SkipScenario } from './accounts.js';

export interface ScenarioContext {
  url: string;
  log(message: string): void;
}

export interface Scenario {
  name: string;
  /** Which requirement this exists to protect. Printed on pass and on fail, so
   *  a failure says what broke, not just where. */
  covers: string;
  run(ctx: ScenarioContext): Promise<void>;
}

export class AssertionError extends Error {}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${message}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

export function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
): void {
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    throw new AssertionError(
      `${message}\n      expected: ${expected} ±${tolerance}\n      actual:   ${actual} (off by ${delta})`,
    );
  }
}

/**
 * Structural equality, insensitive to key order.
 *
 * Phase 6 needs it and earlier phases did not, for a concrete reason: an
 * appearance that goes into `profiles.avatar_appearance jsonb` and comes back
 * has the same fields in a different order. Postgres stores `jsonb` decomposed
 * and reassembles it by its own rules, so `JSON.stringify` comparison fails on
 * two objects that are equal in every way that matters — and the failure looks
 * like the avatar was not carried over.
 */
export function assertEquivalent(actual: unknown, expected: unknown, message: string): void {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a !== b) {
    throw new AssertionError(`${message}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function assertSetsEqual(actual: Set<number>, expected: Set<number>, message: string): void {
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new AssertionError(
      `${message}\n      missing: [${missing.join(', ')}]\n      extra:   [${extra.join(', ')}]`,
    );
  }
}

const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const DIM = '[2m';
const RESET = '[0m';

export async function runAll(scenarios: Scenario[], url: string): Promise<number> {
  console.log(`\nhubitat harness — ${scenarios.length} scenarios against ${url}\n`);

  let failed = 0;
  /**
   * Phase 6 — a scenario that cannot run here, as distinct from one that passed.
   *
   * Accounts need a database and the harness is documented as needing none, so
   * the phase 6 scenarios have to be skippable. Counted and printed separately
   * on purpose: a skip that reported itself as a pass would make a run against a
   * database-less server look like it had covered `AC-6.1`–`AC-6.6`.
   */
  let skipped = 0;

  for (const scenario of scenarios) {
    // Guarantee a clean world before each scenario. A scenario that throws
    // never reaches its own cleanup, and one leftover bot standing in the world
    // makes every later interest-set assertion fail for the wrong reason.
    closeAllBots();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const lines: string[] = [];
    const ctx: ScenarioContext = {
      url,
      log: (message) => lines.push(message),
    };

    const startedAt = Date.now();
    try {
      await scenario.run(ctx);
      const elapsed = Date.now() - startedAt;
      console.log(
        `${GREEN}  PASS${RESET}  ${scenario.name} ${DIM}(${elapsed} ms) — ${scenario.covers}${RESET}`,
      );
      for (const line of lines) console.log(`${DIM}          ${line}${RESET}`);
    } catch (error) {
      if (error instanceof SkipScenario) {
        skipped++;
        console.log(`${YELLOW}  SKIP${RESET}  ${scenario.name} ${DIM}— ${scenario.covers}${RESET}`);
        console.log(`${DIM}          ${error.message}${RESET}`);
        continue;
      }

      failed++;
      const elapsed = Date.now() - startedAt;
      console.log(
        `${RED}  FAIL${RESET}  ${scenario.name} ${DIM}(${elapsed} ms) — ${scenario.covers}${RESET}`,
      );
      for (const line of lines) console.log(`${DIM}          ${line}${RESET}`);
      const message = error instanceof Error ? error.message : String(error);
      for (const line of message.split('\n')) console.log(`${RED}          ${line}${RESET}`);
    }
  }

  closeAllBots();

  const passed = scenarios.length - failed - skipped;
  const tail = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(
    `\n  ${failed === 0 ? GREEN : RED}${passed}/${scenarios.length - skipped} passed${tail}${RESET}\n`,
  );
  return failed;
}
