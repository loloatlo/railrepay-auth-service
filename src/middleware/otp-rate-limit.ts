/**
 * OTP Rate Limiter — auth-service
 *
 * In-memory sliding-window rate limiter keyed on phone_e164.
 * Tracks timestamps per phone; prunes entries older than window on each check.
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * Specification (HUMAN-LOCKED):
 *   - 5 starts per phone per 60 min (default)
 *   - Env-tunable: OTP_START_RATE_PER_PHONE (default 5), OTP_START_RATE_WINDOW_MS (default 3600000)
 *
 * ADR references:
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 */

import { createLogger } from '@railrepay/winston-logger';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitCheckResult {
  allowed: boolean;
  /** Seconds until the oldest entry expires and the phone may retry. Present when allowed=false. */
  retry_after_seconds?: number;
}

export interface OtpRateLimiter {
  /**
   * Check whether a phone number is within rate limit.
   * Records the current timestamp if allowed.
   */
  check(phone_e164: string): RateLimitCheckResult;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an OTP rate limiter instance.
 *
 * Reads OTP_START_RATE_PER_PHONE and OTP_START_RATE_WINDOW_MS from env at creation time.
 * Each instance has its own in-memory map — create one per service lifetime.
 */
export function createOtpRateLimiter(): OtpRateLimiter {
  const maxRequests = process.env.OTP_START_RATE_PER_PHONE
    ? parseInt(process.env.OTP_START_RATE_PER_PHONE, 10)
    : 5;

  const windowMs = process.env.OTP_START_RATE_WINDOW_MS
    ? parseInt(process.env.OTP_START_RATE_WINDOW_MS, 10)
    : 3600000;

  // Map from phone_e164 → array of timestamps (ms since epoch)
  const phoneTimestamps = new Map<string, number[]>();

  getLogger().info('OtpRateLimiter created', {
    component: 'auth-service/otp-rate-limit',
    maxRequests,
    windowMs,
  });

  return {
    check(phone_e164: string): RateLimitCheckResult {
      const now = Date.now();
      const windowStart = now - windowMs;

      // Get existing timestamps for this phone, pruned to current window
      const existing = (phoneTimestamps.get(phone_e164) ?? []).filter(
        (ts) => ts > windowStart
      );

      if (existing.length >= maxRequests) {
        // Rate limited — oldest entry determines when window resets
        const oldestInWindow = Math.min(...existing);
        const resetsAt = oldestInWindow + windowMs;
        const retry_after_seconds = Math.ceil((resetsAt - now) / 1000);

        getLogger().warn('OTP rate limit exceeded', {
          component: 'auth-service/otp-rate-limit',
          retry_after_seconds,
        });

        return { allowed: false, retry_after_seconds: Math.max(1, retry_after_seconds) };
      }

      // Allowed — record this request timestamp
      existing.push(now);
      phoneTimestamps.set(phone_e164, existing);

      return { allowed: true };
    },
  };
}
