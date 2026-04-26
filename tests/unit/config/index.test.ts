/**
 * Unit Tests: getConfig() — AUTH-003 env vars (extends AUTH-001 config tests)
 *                         + AUTH-004 JWT env var additions
 *
 * Story   : RAILREPAY-AUTH-003 / extended for RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25 (extended 2026-04-26 for AUTH-004 AC-D5.1)
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake extends:
 *   src/config/index.ts — add TWILIO_*, OTP_START_RATE_PER_PHONE, OTP_START_RATE_WINDOW_MS
 *                       — add JWT_SECRET (required, ≥32 chars), JWT_ISSUER, JWT_AUDIENCE, JWT_ACCESS_TTL_MS
 * Expected failure mode: assertions fail because getConfig() returns an object
 *   missing the new fields (or throws for a different reason than expected).
 *
 * Note: Basic PORT and DATABASE_URL tests live in tests/unit/startup/startup.test.ts (AUTH-001).
 * This file covers AUTH-003 and AUTH-004-specific env var additions only.
 *
 * AC coverage map:
 *   AC-5.2   Missing TWILIO_ACCOUNT_SID → getConfig() throws naming the missing var
 *   AC-5.2   Missing TWILIO_AUTH_TOKEN → getConfig() throws naming the missing var
 *   AC-5.2   Missing TWILIO_VERIFY_SERVICE_SID → getConfig() throws naming the missing var
 *   AC-6.1   OTP_START_RATE_PER_PHONE defaults to 5
 *   AC-6.1   OTP_START_RATE_WINDOW_MS defaults to 3600000
 *   AC-6.1   Both env vars can be overridden
 *   AC-D5.1  Missing JWT_SECRET → getConfig() throws 'JWT_SECRET is not set'
 *   AC-D5.1  JWT_SECRET < 32 chars → getConfig() throws 'JWT_SECRET must be at least 32 characters'
 *   AC-D5.1  JWT_ISSUER defaults to 'auth-service' when absent
 *   AC-D5.1  JWT_AUDIENCE defaults to 'web-app-bff' when absent
 *   AC-D5.1  JWT_ACCESS_TTL_MS defaults to 900000 when absent
 *
 * ADR references:
 *   ADR-014  — TDD
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─── Module under test ───────────────────────────────────────────────────────
// @ts-expect-error — Config interface extended in AUTH-003; may not exist yet
import { getConfig } from '../../../src/config/index.js';

const VALID_BASE_ENV: NodeJS.ProcessEnv = {
  PORT: '3001',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  TWILIO_ACCOUNT_SID: 'ACtest1234567890abcdef1234567890ab',
  TWILIO_AUTH_TOKEN: 'test_auth_token_1234567890abcdef01',
  TWILIO_VERIFY_SERVICE_SID: 'VAtest1234567890abcdef1234567890',
  // AUTH-004: JWT_SECRET required (≥32 chars). Deterministic 64-hex-char test secret.
  JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('RAILREPAY-AUTH-003 / AUTH-004: getConfig() — Twilio + rate-limit + JWT env vars', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Set valid base environment before each test
    Object.keys(VALID_BASE_ENV).forEach((key) => {
      process.env[key] = VALID_BASE_ENV[key];
    });
    // Clear rate-limit overrides (they are optional)
    delete process.env.OTP_START_RATE_PER_PHONE;
    delete process.env.OTP_START_RATE_WINDOW_MS;
    // Clear optional JWT overrides (to test defaults)
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_ACCESS_TTL_MS;
  });

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  // ─── AC-5.2: Twilio env vars required ────────────────────────────────────

  describe('AC-5.2: TWILIO_* env vars — fail-fast if missing', () => {
    it('AC-5.2: getConfig() should succeed when all TWILIO_* vars are present', () => {
      // AC-5.2: baseline — all vars set → no throw
      expect(() => getConfig()).not.toThrow();
    });

    it('AC-5.2: getConfig() should throw when TWILIO_ACCOUNT_SID is missing', () => {
      // AC-5.2: "getConfig() throws naming the missing var"
      delete process.env.TWILIO_ACCOUNT_SID;
      expect(() => getConfig()).toThrow(/TWILIO_ACCOUNT_SID/i);
    });

    it('AC-5.2: getConfig() should throw when TWILIO_AUTH_TOKEN is missing', () => {
      // AC-5.2: naming the missing var — "TWILIO_AUTH_TOKEN is not set"
      delete process.env.TWILIO_AUTH_TOKEN;
      expect(() => getConfig()).toThrow(/TWILIO_AUTH_TOKEN/i);
    });

    it('AC-5.2: getConfig() should throw when TWILIO_VERIFY_SERVICE_SID is missing', () => {
      // AC-5.2: naming the missing var
      delete process.env.TWILIO_VERIFY_SERVICE_SID;
      expect(() => getConfig()).toThrow(/TWILIO_VERIFY_SERVICE_SID/i);
    });

    it('AC-5.2: getConfig() should return twilio config values when all are present', () => {
      // AC-5.2: returned config exposes Twilio values for TwilioVerifyService constructor
      const config = getConfig();
      expect(config.twilioAccountSid).toBe(VALID_BASE_ENV.TWILIO_ACCOUNT_SID);
      expect(config.twilioAuthToken).toBe(VALID_BASE_ENV.TWILIO_AUTH_TOKEN);
      expect(config.twilioVerifyServiceSid).toBe(VALID_BASE_ENV.TWILIO_VERIFY_SERVICE_SID);
    });
  });

  // ─── AC-6.1: Rate-limit env vars — optional with defaults ─────────────────

  describe('AC-6.1: OTP rate-limit env vars — defaults and overrides', () => {
    it('AC-6.1: OTP_START_RATE_PER_PHONE defaults to 5 when not set', () => {
      // AC-6.1: "default 5 starts per phone per 60 min" (HUMAN OVERRIDE over Quinn's 3/15min)
      const config = getConfig();
      expect(config.otpStartRatePerPhone).toBe(5);
    });

    it('AC-6.1: OTP_START_RATE_WINDOW_MS defaults to 3600000 (60 min) when not set', () => {
      // AC-6.1: "default 60 min" window
      const config = getConfig();
      expect(config.otpStartRateWindowMs).toBe(3600000);
    });

    it('AC-6.1: OTP_START_RATE_PER_PHONE can be overridden via env var', () => {
      // AC-6.1: "Env-var override works"
      process.env.OTP_START_RATE_PER_PHONE = '2';
      const config = getConfig();
      expect(config.otpStartRatePerPhone).toBe(2);
    });

    it('AC-6.1: OTP_START_RATE_WINDOW_MS can be overridden via env var', () => {
      // AC-6.1: window is tunable
      process.env.OTP_START_RATE_WINDOW_MS = '900000'; // 15 min
      const config = getConfig();
      expect(config.otpStartRateWindowMs).toBe(900000);
    });

    it('AC-6.1: OTP_START_RATE_PER_PHONE must be parsed as an integer (not string)', () => {
      // AC-6.1: boundary — env var is a string, config must expose it as number
      process.env.OTP_START_RATE_PER_PHONE = '10';
      const config = getConfig();
      expect(typeof config.otpStartRatePerPhone).toBe('number');
    });

    it('AC-6.1: OTP_START_RATE_WINDOW_MS must be parsed as an integer (not string)', () => {
      // AC-6.1: boundary — parsed as integer, not string
      process.env.OTP_START_RATE_WINDOW_MS = '7200000';
      const config = getConfig();
      expect(typeof config.otpStartRateWindowMs).toBe('number');
    });
  });

  // ─── AC-D5.1 (AUTH-004): JWT_SECRET required + length validation ──────────

  describe('AC-D5.1 (AUTH-004): JWT_SECRET env var — required + minimum length', () => {
    it('AC-D5.1: getConfig() should succeed when JWT_SECRET is ≥32 characters', () => {
      // AC-D5.1: baseline — 64-char hex string passes
      expect(() => getConfig()).not.toThrow();
    });

    it('AC-D5.1: getConfig() should throw when JWT_SECRET is absent', () => {
      // AC-D5.1: "service refuses to start without it" — exact message fragment
      delete process.env.JWT_SECRET;
      expect(() => getConfig()).toThrow(/JWT_SECRET/i);
    });

    it('AC-D5.1: getConfig() throw message must mention JWT_SECRET is not set', () => {
      // AC-D5.1: "auth-service: required environment variable JWT_SECRET is not set"
      delete process.env.JWT_SECRET;
      expect(() => getConfig()).toThrow(/JWT_SECRET.*not set|not set.*JWT_SECRET/i);
    });

    it('AC-D5.1: getConfig() should throw when JWT_SECRET is fewer than 32 characters', () => {
      // AC-D5.1: "JWT_SECRET must be at least 32 characters / 256 bits" when too short (e.g. 16 chars)
      process.env.JWT_SECRET = 'tooshort1234567'; // 15 chars
      expect(() => getConfig()).toThrow(/JWT_SECRET.*32|32.*JWT_SECRET/i);
    });

    it('AC-D5.1: getConfig() throw message mentions 32 characters when secret too short', () => {
      // AC-D5.1: "JWT_SECRET must be at least 32 characters / 256 bits"
      process.env.JWT_SECRET = 'shortsecret'; // 11 chars
      expect(() => getConfig()).toThrow(/32/);
    });

    it('AC-D5.1: getConfig() should succeed with exactly 32-character secret', () => {
      // AC-D5.1: boundary — exactly 32 chars is acceptable
      process.env.JWT_SECRET = '12345678901234567890123456789012'; // exactly 32 chars
      expect(() => getConfig()).not.toThrow();
    });

    it('AC-D5.1: getConfig() should expose jwtSecret field in returned config', () => {
      // AC-D5.1: config object exposes jwtSecret for JwtService constructor
      const config = getConfig();
      expect(config).toHaveProperty('jwtSecret');
      expect(config.jwtSecret).toBe(VALID_BASE_ENV.JWT_SECRET);
    });
  });

  // ─── AC-D5.1 (AUTH-004): JWT optional vars with defaults ─────────────────

  describe('AC-D5.1 (AUTH-004): JWT optional env vars — defaults', () => {
    it('AC-D5.1: jwtIssuer defaults to "auth-service" when JWT_ISSUER is absent', () => {
      // AC-D5.1: "JWT_ISSUER default: auth-service"
      const config = getConfig();
      expect(config.jwtIssuer).toBe('auth-service');
    });

    it('AC-D5.1: jwtAudience defaults to "web-app-bff" when JWT_AUDIENCE is absent', () => {
      // AC-D5.1: "JWT_AUDIENCE default: web-app-bff"
      const config = getConfig();
      expect(config.jwtAudience).toBe('web-app-bff');
    });

    it('AC-D5.1: jwtAccessTtlMs defaults to 900000 (15 min) when JWT_ACCESS_TTL_MS is absent', () => {
      // AC-D5.1: "JWT_ACCESS_TTL_MS default: 900000"
      const config = getConfig();
      expect(config.jwtAccessTtlMs).toBe(900_000);
    });

    it('AC-D5.1: jwtIssuer can be overridden via JWT_ISSUER env var', () => {
      // AC-D5.1: env-var override
      process.env.JWT_ISSUER = 'custom-issuer';
      const config = getConfig();
      expect(config.jwtIssuer).toBe('custom-issuer');
    });

    it('AC-D5.1: jwtAudience can be overridden via JWT_AUDIENCE env var', () => {
      // AC-D5.1: env-var override
      process.env.JWT_AUDIENCE = 'custom-audience';
      const config = getConfig();
      expect(config.jwtAudience).toBe('custom-audience');
    });

    it('AC-D5.1: jwtAccessTtlMs is parsed as integer from JWT_ACCESS_TTL_MS', () => {
      // AC-D5.1: boundary — parsed as number, not string
      process.env.JWT_ACCESS_TTL_MS = '1800000'; // 30 min override
      const config = getConfig();
      expect(config.jwtAccessTtlMs).toBe(1_800_000);
      expect(typeof config.jwtAccessTtlMs).toBe('number');
    });
  });
});
