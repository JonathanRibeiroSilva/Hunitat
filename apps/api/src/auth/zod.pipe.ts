/**
 * Validate every HTTP body against the schema `@hubitat/protocol` publishes.
 *
 * `NFR-31` — "nothing unvalidated reaches application logic" — has held on the
 * WebSocket since phase 1, where every JSON frame is parsed against a Zod schema
 * before dispatch. Phase 6 is the first phase with an HTTP surface worth
 * attacking, and it gets the same rule through the same schemas rather than
 * through `class-validator` decorators that would be a second description of
 * shapes the client already shares.
 *
 * The schemas also *normalise*: `emailSchema` lowercases and trims,
 * `inviteCodeSchema` uppercases. So this pipe is where an address becomes
 * canonical, and every handler downstream can assume it already is.
 */

import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    // One field, named, rather than a dump of the whole issue tree. The first
    // problem is the one somebody can act on, and Zod's raw output leaks the
    // shape of the schema to anyone who sends a malformed body.
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.');
    throw new BadRequestException(
      field
        ? `${field}: ${issue?.message ?? 'is not valid'}`
        : (issue?.message ?? 'Invalid request.'),
    );
  }
}
