/**
 * Unit Tests: getConfig() — AUTH-003 env vars (extends AUTH-001 config tests)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake extends:
 *   src/config/index.ts — add TWILIO_*, OTP_START_RATE_PER_PHONE, OTP_START_RATE_WINDOW_MS
 * Expected failure mode: assertions fail because getConfig() returns an object
 *   missing the new fields (or throws for a different reason than expected).
 *
 * Note: Basic PORT and DATABASE_URL tests live in tests/unit/startup/startup.test.ts (AUTH-001).
 * This file covers AUTH-003-specific env var additions only.
 *
 * AC coverage map:
 *   AC-5.2  Missing TWILIO_ACCOUNT_SID → getConfig() throws naming the missing var
 *   AC-5.2  Missing TWILIO_AUTH_TOKEN → getConfig() throws naming the missing var
 *   AC-5.2  Missing TWILIO_VERIFY_SERVICE_SID → getConfig() throws naming the missing var
 *   AC-6.1  OTP_START_RATE_PER_PHONE defaults to 5
 *   AC-6.1  OTP_START_RATE_WINDOW_MS defaults to 3600000
 *   AC-6.1  Both env vars can be overridden
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
};

describe('RAILREPAY-AUTH-003: getConfig() — Twilio + rate-limit env vars (AC-5.2, AC-6.1)', () => {
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
});
