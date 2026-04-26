/**
 * Unit Tests: OTP rate-limiter middleware (AUTH-003)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/middleware/otp-rate-limit.ts (or equivalent)
 * Expected failure mode: "Cannot find module '../../../src/middleware/otp-rate-limit.js'"
 *
 * Rate limit specification (HUMAN OVERRIDE over Quinn's default):
 *   - 5 starts per phone per 60 min (NOT 3/15min)
 *   - Env vars: OTP_START_RATE_PER_PHONE (default 5), OTP_START_RATE_WINDOW_MS (default 3600000)
 *
 * Strategy: vi.useFakeTimers() for deterministic window testing.
 *   The rate limiter is tested as a callable function (not Express middleware),
 *   receiving { phone_e164, correlationId } and tracking state in-process.
 *   Tests use unique phone numbers per scenario to avoid shared-state interference (Guideline #6).
 *
 * AC coverage map:
 *   AC-6.1  5 successful starts within window
 *   AC-6.1  6th request returns 429 { error: 'rate_limited', retry_after_seconds: <int> }
 *   AC-6.1  Window resets after expiry
 *   AC-6.1  Different phones do NOT share quota
 *   AC-6.1  Env-var override: OTP_START_RATE_PER_PHONE=2 → 2 succeed, 3rd is 429
 *
 * ADR references:
 *   ADR-014  — TDD
 *   CLAUDE.md §6.1 Guideline #7 — Standard matchers only (no toBeOneOf)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Shared logger mock (Guideline #11) ──────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module under test ───────────────────────────────────────────────────────
// Blake may expose either:
//   (a) A class: OtpRateLimiter with check(phone_e164): { allowed: boolean, retry_after_seconds?: number }
//   (b) A factory: createOtpRateLimiter(options?) returning the same shape
//
// This test imports the factory form. If Blake uses a class, he should adapt
// per Test Lock Rule handback (not modify this file).
//
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { createOtpRateLimiter } from '../../../src/middleware/otp-rate-limit.js';

describe('RAILREPAY-AUTH-003: OTP rate limiter (AC-6.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();

    // Reset env vars to defaults before each test
    delete process.env.OTP_START_RATE_PER_PHONE;
    delete process.env.OTP_START_RATE_WINDOW_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OTP_START_RATE_PER_PHONE;
    delete process.env.OTP_START_RATE_WINDOW_MS;
  });

  // ─── AC-6.1: 5 requests within window ────────────────────────────────────

  describe('AC-6.1: 5 successful starts within window (default config)', () => {
    it('AC-6.1: first request should be allowed', () => {
      // AC-6.1: "5 successful starts within window" — first is always allowed
      const limiter = createOtpRateLimiter();
      const result = limiter.check('+447700900100');
      expect(result.allowed).toBe(true);
    });

    it('AC-6.1: 5th request should still be allowed', () => {
      // AC-6.1: exactly at the limit is allowed
      const limiter = createOtpRateLimiter();
      const phone = '+447700900101';

      let result;
      for (let i = 0; i < 5; i++) {
        result = limiter.check(phone);
      }

      expect(result!.allowed).toBe(true);
    });

    it('AC-6.1: 6th request should be rate limited', () => {
      // AC-6.1: "6th request returns 429 { error: 'rate_limited', retry_after_seconds: <int> }"
      const limiter = createOtpRateLimiter();
      const phone = '+447700900102';

      // Exhaust 5 allowed requests
      for (let i = 0; i < 5; i++) {
        limiter.check(phone);
      }

      const result = limiter.check(phone);
      expect(result.allowed).toBe(false);
    });

    it('AC-6.1: 6th request result must include retry_after_seconds as a positive integer', () => {
      // AC-6.1: "retry_after_seconds: <int>" — caller uses this to set Retry-After header
      const limiter = createOtpRateLimiter();
      const phone = '+447700900103';

      for (let i = 0; i < 5; i++) {
        limiter.check(phone);
      }

      const result = limiter.check(phone);
      expect(result.allowed).toBe(false);
      expect(typeof result.retry_after_seconds).toBe('number');
      expect(Number.isInteger(result.retry_after_seconds!)).toBe(true);
      expect(result.retry_after_seconds!).toBeGreaterThan(0);
    });
  });

  // ─── AC-6.1: Window reset ─────────────────────────────────────────────────

  describe('AC-6.1: window resets after expiry', () => {
    it('AC-6.1: should allow requests again after the 60-min window expires', () => {
      // AC-6.1: "Window resets after expiry"
      const limiter = createOtpRateLimiter();
      const phone = '+447700900110';

      // Exhaust limit
      for (let i = 0; i < 5; i++) {
        limiter.check(phone);
      }
      expect(limiter.check(phone).allowed).toBe(false);

      // Advance fake timer past 60 min window (3600000ms)
      vi.advanceTimersByTime(3600001);

      // Should now be allowed again
      const result = limiter.check(phone);
      expect(result.allowed).toBe(true);
    });

    it('AC-6.1: should not reset before the window expires', () => {
      // AC-6.1: boundary — 59 minutes should NOT reset
      const limiter = createOtpRateLimiter();
      const phone = '+447700900111';

      for (let i = 0; i < 5; i++) {
        limiter.check(phone);
      }
      // Advance only 59 min — window still open
      vi.advanceTimersByTime(59 * 60 * 1000);

      const result = limiter.check(phone);
      expect(result.allowed).toBe(false);
    });
  });

  // ─── AC-6.1: Per-phone quota isolation ───────────────────────────────────

  describe('AC-6.1: different phones do NOT share quota', () => {
    it('AC-6.1: exhausting one phone should not affect a different phone', () => {
      // AC-6.1: "Different phones do NOT share quota"
      const limiter = createOtpRateLimiter();
      const phoneA = '+447700900120';
      const phoneB = '+447700900121'; // different phone — unique test data

      // Exhaust phone A
      for (let i = 0; i < 5; i++) {
        limiter.check(phoneA);
      }
      expect(limiter.check(phoneA).allowed).toBe(false);

      // Phone B should still be allowed
      expect(limiter.check(phoneB).allowed).toBe(true);
    });

    it('AC-6.1: each phone has its own independent 5-request quota', () => {
      // AC-6.1: 3 unique phones each get 5 requests
      const limiter = createOtpRateLimiter();
      const phones = ['+447700900122', '+447700900123', '+447700900124'];

      for (const phone of phones) {
        for (let i = 0; i < 5; i++) {
          expect(limiter.check(phone).allowed).toBe(true);
        }
        expect(limiter.check(phone).allowed).toBe(false);
      }
    });
  });

  // ─── AC-6.1: Env-var override ─────────────────────────────────────────────

  describe('AC-6.1: OTP_START_RATE_PER_PHONE env-var override', () => {
    it('AC-6.1: OTP_START_RATE_PER_PHONE=2 → 2 succeed, 3rd is denied', () => {
      // AC-6.1: "Env-var override works (e.g., OTP_START_RATE_PER_PHONE=2 → 2 succeeds, 3rd is 429)"
      process.env.OTP_START_RATE_PER_PHONE = '2';
      const limiter = createOtpRateLimiter();
      const phone = '+447700900130';

      expect(limiter.check(phone).allowed).toBe(true);  // 1st
      expect(limiter.check(phone).allowed).toBe(true);  // 2nd
      expect(limiter.check(phone).allowed).toBe(false); // 3rd — rate limited
    });

    it('AC-6.1: OTP_START_RATE_PER_PHONE=1 → 1 succeeds, 2nd is denied', () => {
      // AC-6.1: boundary — minimum limit of 1
      process.env.OTP_START_RATE_PER_PHONE = '1';
      const limiter = createOtpRateLimiter();
      const phone = '+447700900131';

      expect(limiter.check(phone).allowed).toBe(true);  // 1st
      expect(limiter.check(phone).allowed).toBe(false); // 2nd — rate limited
    });

    it('AC-6.1: OTP_START_RATE_WINDOW_MS=5000 → window resets after 5 seconds', () => {
      // AC-6.1: window size is env-tunable
      process.env.OTP_START_RATE_PER_PHONE = '1';
      process.env.OTP_START_RATE_WINDOW_MS = '5000'; // 5-second window
      const limiter = createOtpRateLimiter();
      const phone = '+447700900132';

      limiter.check(phone);
      expect(limiter.check(phone).allowed).toBe(false); // 2nd — blocked

      vi.advanceTimersByTime(5001); // advance past 5s window

      expect(limiter.check(phone).allowed).toBe(true); // reset — allowed
    });

    it('AC-6.1: default window is 60 min (3600000ms) when OTP_START_RATE_WINDOW_MS unset', () => {
      // AC-6.1: "default 60 min"
      // Verify by exhausting at 1 limit, advancing 59 min (should still be blocked)
      process.env.OTP_START_RATE_PER_PHONE = '1';
      const limiter = createOtpRateLimiter();
      const phone = '+447700900133';

      limiter.check(phone);
      expect(limiter.check(phone).allowed).toBe(false);

      vi.advanceTimersByTime(59 * 60 * 1000); // 59 minutes — still in window
      expect(limiter.check(phone).allowed).toBe(false);

      vi.advanceTimersByTime(60 * 1000 + 1); // +1 more minute → past 60min
      expect(limiter.check(phone).allowed).toBe(true);
    });
  });
});
