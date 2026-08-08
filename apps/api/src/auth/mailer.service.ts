/**
 * `FR-6.5` — password recovery over SMTP.
 *
 * **The only outbound network dependency in the whole product, and it is
 * optional** (ADR 0011). With `SMTP_HOST` empty nothing is sent, `enabled` is
 * false, and the client is told so through `GET /auth/config` — so a "Forgot
 * your password?" link is never shown next to a flow that silently does nothing.
 * An operator on an air-gapped network resets passwords administratively and
 * loses no other capability.
 *
 * Compose ships Mailpit for development, which accepts everything and delivers
 * to a web inbox on :8025.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly config: RuntimeConfig = loadConfig();
  private transport: Transporter | null = null;

  get enabled(): boolean {
    return this.config.smtpHost !== '';
  }

  /**
   * Send the reset link. Never throws.
   *
   * A relay that is down must not turn `POST /auth/password-reset/request` into
   * a 500, because that response is an account-existence oracle: the endpoint
   * answers 202 for every address precisely so that "we sent a mail" and "there
   * is no such account" are indistinguishable, and an error on one path and not
   * the other gives the game away. A failure is logged for the operator, who is
   * the person who can act on it.
   */
  async sendPasswordReset(to: string, resetUrl: string, ttlMinutes: number): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        `Password reset requested for ${to} but SMTP is not configured; no mail sent. ` +
          `Reset it administratively, or set SMTP_HOST (FR-6.5).`,
      );
      return;
    }

    try {
      await this.transporter().sendMail({
        from: this.config.smtpFrom,
        to,
        subject: `Reset your ${this.config.spaceName} password`,
        text: [
          'Someone asked to reset the password for this address.',
          '',
          resetUrl,
          '',
          `The link works once and expires in ${ttlMinutes} minutes.`,
          'If it was not you, nothing has changed and you can ignore this message.',
        ].join('\n'),
      });
      this.logger.log(`Password reset mail sent to ${to}.`);
    } catch (error) {
      this.logger.error(`Could not send password reset to ${to}: ${(error as Error).message}`);
    }
  }

  /** Built on first use rather than in the constructor: a transport is a socket
   *  pool, and a server whose operator disabled recovery should not open one. */
  private transporter(): Transporter {
    if (this.transport) return this.transport;

    this.transport = createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      // Mailpit and most internal relays take no credentials. Passing an empty
      // `auth` object makes nodemailer attempt AUTH and fail against them.
      ...(this.config.smtpUser
        ? { auth: { user: this.config.smtpUser, pass: this.config.smtpPassword } }
        : {}),
    });
    return this.transport;
  }
}
