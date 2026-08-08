/**
 * `FR-6.3` — credentials stored so that nothing recoverable is kept.
 *
 * argon2id at the OWASP-recommended floor, which is ADR 0011's choice and the
 * current Password Hashing Competition winner. The parameters come from
 * configuration and the boot validation refuses to start below the floor, so
 * this file never has to decide whether a weaker setting is acceptable.
 *
 * ── Why the parameters are read per call and not captured once ──────────────
 *
 * They are captured once, from the injected config — but the *hash* carries its
 * own copy. `$argon2id$v=19$m=19456,t=2,p=1$...` is self-describing, which is
 * what makes raising `ARGON2_MEMORY_KIB` a safe change: every existing hash
 * keeps verifying against the parameters it was made with, and `needsRehash`
 * below upgrades it on the owner's next successful sign-in. Without that, either
 * the parameters can never change or every account is locked out when they do.
 */

import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly config: RuntimeConfig = loadConfig();

  private get options(): argon2.Options {
    return {
      type: argon2.argon2id,
      memoryCost: this.config.argon2MemoryKib,
      timeCost: this.config.argon2Iterations,
      parallelism: this.config.argon2Parallelism,
    };
  }

  /** `PASSWORD_MIN_LENGTH`, enforced here rather than in the shared schema — it
   *  is tunable, and a shared schema would be a second copy of the value that
   *  goes on refusing what the server has started accepting. */
  get minLength(): number {
    return this.config.passwordMinLength;
  }

  /** Null when acceptable, otherwise the reason, phrased for the person typing
   *  it. A length floor and nothing else: NIST 800-63B has recommended against
   *  character-class rules since 2017 because they buy `Password1!`. */
  validate(password: string): string | null {
    if (password.length < this.minLength) {
      return `Use at least ${this.minLength} characters.`;
    }
    return null;
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  /**
   * Verify, treating a malformed stored hash as a failed attempt rather than an
   * error.
   *
   * A row whose hash cannot be parsed is a database somebody has edited, and the
   * safe reading of "I cannot check this password" is "this password is wrong".
   * Throwing would turn it into a 500 that says the account exists.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      this.logger.warn(`Password verification failed to run: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Whether a stored hash was made with weaker parameters than the current ones.
   *
   * Called after a *successful* verification, which is the only moment the plain
   * password is in hand and therefore the only moment a stronger hash can be
   * computed. Silent when it fails — an upgrade that did not happen is not worth
   * refusing a valid sign-in over.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return false;
    }
  }

  /**
   * Spend the same time on an account that does not exist as on one that does.
   *
   * Without this, `POST /auth/login` answers in 2 ms for an unknown address and
   * 60 ms for a known one, and the difference is a reliable oracle for
   * enumerating who has an account here — which for an internal company tool is
   * a staff list. Hashing a throwaway string is the standard mitigation and
   * costs exactly what a real verification costs, because it is one.
   */
  async burnTime(): Promise<void> {
    try {
      await argon2.hash('timing-equalisation', this.options);
    } catch {
      // A failure here means argon2 itself is broken, which the real path is
      // about to report properly. Nothing to add.
    }
  }
}
