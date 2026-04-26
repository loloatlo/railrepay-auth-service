/**
 * TwilioVerifyService — auth-service
 *
 * Wraps the Twilio Verify SDK for OTP flows.
 * Adds: E.164 validation, retry on 5xx (1x with 500ms backoff),
 * fail-fast on 4xx, structured error logging with phone redaction.
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 *
 * Location: src/twilio/twilio-verify.service.ts (HUMAN-LOCKED decision)
 */

import Twilio from 'twilio';
import { createLogger } from '@railrepay/winston-logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerificationResult {
  sid: string;
  status: string;
}

export interface VerificationCheckResult {
  valid: boolean;
  status: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** E.164 format regex: starts with +, followed by 1-15 digits */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/** Delay helper for retry backoff */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redact phone number for logging: show last 4 digits only.
 * Example: "+447700900020" → "+44****0020"
 */
function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  const visible = phone.slice(-4);
  const prefix = phone.slice(0, Math.max(0, phone.length - 4));
  const maskedPrefix = prefix.replace(/\d/g, '*');
  // Keep leading + and country-code digits visible for readability
  const plusMatch = phone.match(/^(\+\d{1,3})/);
  if (plusMatch) {
    const countryCode = plusMatch[1];
    return `${countryCode}****${visible}`;
  }
  return `${maskedPrefix}${visible}`;
}

/** Returns true if the error represents a 5xx HTTP status from Twilio */
function isTwilio5xx(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    return typeof status === 'number' && status >= 500 && status < 600;
  }
  return false;
}

// ─── Logger (lazy) ────────────────────────────────────────────────────────────
// createLogger() is called lazily to avoid module-initialization TDZ issues
// with Vitest's vi.mock() hoisting (Guideline #11).

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class TwilioVerifyService {
  private readonly client: ReturnType<typeof Twilio>;
  private readonly verifyServiceSid: string;

  constructor(accountSid: string, authToken: string, verifyServiceSid: string) {
    if (!accountSid) {
      throw new Error('TWILIO_ACCOUNT_SID is required');
    }
    if (!authToken) {
      throw new Error('TWILIO_AUTH_TOKEN is required');
    }
    if (!verifyServiceSid) {
      throw new Error('TWILIO_VERIFY_SERVICE_SID is required');
    }

    this.client = Twilio(accountSid, authToken);
    this.verifyServiceSid = verifyServiceSid;
  }

  /**
   * Start phone number verification via Twilio Verify (SMS channel).
   *
   * AC-1.1: Calls Twilio verifications.create once on success.
   * AC-1.2: Validates phone_e164 before calling Twilio.
   * AC-1.3: Retries exactly once on 5xx; fail-fast on 4xx.
   * AC-5.1: Logs errors with { component, correlation_id, phone_e164_redacted }.
   *
   * @param phone_e164 - E.164 formatted phone number
   * @param correlationId - Optional correlation ID for tracing
   */
  async startVerification(
    phone_e164: string,
    correlationId?: string
  ): Promise<VerificationResult> {
    if (!phone_e164) {
      throw new Error('phone_e164 is required');
    }
    if (!E164_REGEX.test(phone_e164)) {
      throw new Error('phone_e164 must be in E.164 format (e.g. +447700900000)');
    }

    return this._callWithRetry(
      () =>
        this.client.verify.v2
          .services(this.verifyServiceSid)
          .verifications.create({ to: phone_e164, channel: 'sms' }),
      phone_e164,
      correlationId,
      (result) => ({ sid: result.sid, status: result.status })
    );
  }

  /**
   * Check a verification code against a pending Twilio Verify verification.
   *
   * AC-2.1: Calls Twilio verificationChecks.create once.
   * AC-1.2: Validates phone and code before calling Twilio.
   *
   * @param phone_e164 - E.164 formatted phone number
   * @param code - Verification code provided by user
   */
  async checkVerification(
    phone_e164: string,
    code: string
  ): Promise<VerificationCheckResult> {
    if (!phone_e164) {
      throw new Error('phone_e164 is required');
    }
    if (!E164_REGEX.test(phone_e164)) {
      throw new Error('phone_e164 must be in E.164 format');
    }
    if (!code) {
      throw new Error('code is required');
    }

    const result = await this.client.verify.v2
      .services(this.verifyServiceSid)
      .verificationChecks.create({ to: phone_e164, code });

    return { valid: result.valid === true, status: result.status };
  }

  /**
   * Execute a Twilio API call with one retry on 5xx errors.
   * Logs error with phone redaction on final failure.
   */
  private async _callWithRetry<TRaw, TResult>(
    fn: () => Promise<TRaw>,
    phone_e164: string,
    correlationId: string | undefined,
    transform: (raw: TRaw) => TResult
  ): Promise<TResult> {
    try {
      const raw = await fn();
      return transform(raw);
    } catch (firstErr) {
      if (isTwilio5xx(firstErr)) {
        // One retry with 500ms backoff
        await delay(500);
        try {
          const raw = await fn();
          return transform(raw);
        } catch (retryErr) {
          this._logError(retryErr, phone_e164, correlationId);
          throw retryErr;
        }
      }
      // 4xx or other — fail fast, log and rethrow
      this._logError(firstErr, phone_e164, correlationId);
      throw firstErr;
    }
  }

  private _logError(err: unknown, phone_e164: string, correlationId?: string): void {
    getLogger().error('TwilioVerifyService error', {
      component: 'auth-service/twilio-verify',
      correlation_id: correlationId,
      phone_e164_redacted: redactPhone(phone_e164),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
