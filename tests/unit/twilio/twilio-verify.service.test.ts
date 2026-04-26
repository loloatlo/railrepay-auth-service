/**
 * Unit Tests: TwilioVerifyService (AUTH-003)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/twilio/twilio-verify.service.ts
 * Expected failure mode: "Cannot find module '../../../src/twilio/twilio-verify.service.js'"
 *
 * Twilio mock pattern: adopted from whatsapp-handler/tests/unit/services/twilio-verify.service.test.ts
 * Infrastructure package mocking: shared logger instance OUTSIDE factory (Guideline #11).
 *
 * AC coverage map:
 *   AC-1.1  startVerification(phone) calls Twilio verifications.create exactly once; returns 202 shape
 *   AC-1.3  Twilio 4xx → twilio_rejected error; Twilio 5xx → upstream_unavailable after 1 retry
 *   AC-2.1  checkVerification(phone, code) calls Twilio verificationChecks.create exactly once
 *   AC-5.1  Twilio errors logged with { component, correlation_id, error, phone_e164_redacted }
 *   AC-5.2  Missing TWILIO_* env vars → getConfig() throws naming the missing var
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD: tests written before implementation
 *   CLAUDE.md §6.1 Guideline #11 — Infrastructure package mocking patterns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared logger mock (Guideline #11 — SAME instance across all tests) ────
//
// MUST be created OUTSIDE the factory function so all tests share one mock instance.
// Pattern required to avoid "different instance" assertion failures.
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

// ─── Twilio SDK mock ──────────────────────────────────────────────────────────
// Pattern adopted from whatsapp-handler twilio-verify.service.test.ts
// Shared mock functions created at module scope (before factory) for cross-test access.
const mockVerificationsCreate = vi.fn();
const mockVerificationChecksCreate = vi.fn();
const mockServices = vi.fn(() => ({
  verifications: {
    create: mockVerificationsCreate,
  },
  verificationChecks: {
    create: mockVerificationChecksCreate,
  },
}));

vi.mock('twilio', () => {
  const mockTwilioConstructor = vi.fn(() => ({
    verify: {
      v2: {
        services: mockServices,
      },
    },
  }));
  return {
    default: mockTwilioConstructor,
  };
});

// ─── Module under test ───────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { TwilioVerifyService } from '../../../src/twilio/twilio-verify.service.js';

// ─── Test configuration ──────────────────────────────────────────────────────
const VALID_CONFIG = {
  accountSid: 'ACtest1234567890abcdef1234567890ab',
  authToken: 'test_auth_token_1234567890abcdef',
  verifyServiceSid: 'VAtest1234567890abcdef1234567890',
};

describe('RAILREPAY-AUTH-003: TwilioVerifyService unit tests', () => {
  let service: InstanceType<typeof TwilioVerifyService>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();
    service = new TwilioVerifyService(
      VALID_CONFIG.accountSid,
      VALID_CONFIG.authToken,
      VALID_CONFIG.verifyServiceSid
    );
  });

  // ─── Constructor ─────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create instance with valid configuration', () => {
      // AC-5.2: service initialises when all env vars are present
      expect(service).toBeDefined();
    });

    it('should throw when accountSid is empty string', () => {
      // AC-5.2: missing TWILIO_ACCOUNT_SID — constructor must throw naming the var
      expect(() => {
        new TwilioVerifyService('', VALID_CONFIG.authToken, VALID_CONFIG.verifyServiceSid);
      }).toThrow(/TWILIO_ACCOUNT_SID/i);
    });

    it('should throw when authToken is empty string', () => {
      // AC-5.2: missing TWILIO_AUTH_TOKEN — constructor must throw naming the var
      expect(() => {
        new TwilioVerifyService(VALID_CONFIG.accountSid, '', VALID_CONFIG.verifyServiceSid);
      }).toThrow(/TWILIO_AUTH_TOKEN/i);
    });

    it('should throw when verifyServiceSid is empty string', () => {
      // AC-5.2: missing TWILIO_VERIFY_SERVICE_SID — constructor must throw naming the var
      expect(() => {
        new TwilioVerifyService(VALID_CONFIG.accountSid, VALID_CONFIG.authToken, '');
      }).toThrow(/TWILIO_VERIFY_SERVICE_SID/i);
    });
  });

  // ─── AC-1.1 / AC-1.3: startVerification ─────────────────────────────────

  describe('AC-1.1: startVerification(phone)', () => {
    it('AC-1.1: should call Twilio verifications.create exactly once for a valid phone', async () => {
      // AC-1.1: startVerification calls Twilio once — no silent retries on success
      const phone = '+447700900000';
      mockVerificationsCreate.mockResolvedValueOnce({
        sid: 'VE1234567890abcdef',
        status: 'pending',
      });

      await service.startVerification(phone);

      expect(mockVerificationsCreate).toHaveBeenCalledTimes(1);
    });

    it('AC-1.1: should call Twilio with channel=sms and the provided phone', async () => {
      // AC-1.1: SMS channel is mandatory; phone must be passed as `to`
      const phone = '+447700900000';
      mockVerificationsCreate.mockResolvedValueOnce({
        sid: 'VE1234567890abcdef',
        status: 'pending',
      });

      await service.startVerification(phone);

      expect(mockVerificationsCreate).toHaveBeenCalledWith({
        to: phone,
        channel: 'sms',
      });
    });

    it('AC-1.1: should call Twilio services with the configured verifyServiceSid', async () => {
      // AC-1.1: verifyServiceSid must be passed to services() — not hardcoded
      const phone = '+447700900001';
      mockVerificationsCreate.mockResolvedValueOnce({
        sid: 'VE1234567890abcdef',
        status: 'pending',
      });

      await service.startVerification(phone);

      expect(mockServices).toHaveBeenCalledWith(VALID_CONFIG.verifyServiceSid);
    });

    it('AC-1.1: should return { sid, status } on success', async () => {
      // AC-1.1: success shape — callers (OtpService) depend on { sid, status }
      const phone = '+447700900002';
      mockVerificationsCreate.mockResolvedValueOnce({
        sid: 'VEabc123',
        status: 'pending',
      });

      const result = await service.startVerification(phone);

      expect(result).toEqual({ sid: 'VEabc123', status: 'pending' });
    });

    it('AC-1.2: should reject empty phone before calling Twilio', async () => {
      // AC-1.2: validation fires before Twilio call — no wasted API round-trip
      await expect(service.startVerification('')).rejects.toThrow();
      expect(mockVerificationsCreate).not.toHaveBeenCalled();
    });

    it('AC-1.2: should reject malformed phone (non-E.164) before calling Twilio', async () => {
      // AC-1.2: "07700900000" (no +) must be rejected
      await expect(service.startVerification('07700900000')).rejects.toThrow();
      expect(mockVerificationsCreate).not.toHaveBeenCalled();
    });

    it('AC-1.3: should surface error with code twilio_rejected on Twilio 4xx response', async () => {
      // AC-1.3: Twilio 4xx (invalid phone) → throw/reject with twilio_rejected indicator
      // Twilio SDK surfaces 4xx as errors with numeric status codes
      const phone = '+447700900003';
      const twilioError = Object.assign(new Error('Invalid phone number'), {
        status: 400,
        code: 21211,
      });
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);

      await expect(service.startVerification(phone)).rejects.toThrow();
    });

    it('AC-1.3: should retry exactly once on Twilio 5xx before throwing', async () => {
      // AC-1.3: 1 retry on 5xx, fail-fast on 4xx — verify 2 total calls on 5xx
      const phone = '+447700900004';
      const serverError = Object.assign(new Error('Internal server error'), {
        status: 500,
      });
      mockVerificationsCreate.mockRejectedValueOnce(serverError);
      mockVerificationsCreate.mockRejectedValueOnce(serverError);

      await expect(service.startVerification(phone)).rejects.toThrow();
      // 1 original + 1 retry = 2 calls total
      expect(mockVerificationsCreate).toHaveBeenCalledTimes(2);
    });

    it('AC-1.3: should succeed on retry if 5xx resolves on second attempt', async () => {
      // AC-1.3: retry policy — if first attempt is 5xx but second succeeds, overall succeeds
      const phone = '+447700900005';
      const serverError = Object.assign(new Error('Temporarily unavailable'), {
        status: 503,
      });
      mockVerificationsCreate.mockRejectedValueOnce(serverError);
      mockVerificationsCreate.mockResolvedValueOnce({
        sid: 'VEretried123',
        status: 'pending',
      });

      const result = await service.startVerification(phone);

      expect(result).toEqual({ sid: 'VEretried123', status: 'pending' });
      expect(mockVerificationsCreate).toHaveBeenCalledTimes(2);
    });

    it('AC-1.3: should NOT retry on Twilio 4xx (fail-fast)', async () => {
      // AC-1.3: 4xx errors are client errors — retry would be futile
      const phone = '+447700900006';
      const clientError = Object.assign(new Error('Number not found'), {
        status: 404,
        code: 20404,
      });
      mockVerificationsCreate.mockRejectedValueOnce(clientError);

      await expect(service.startVerification(phone)).rejects.toThrow();
      // MUST only call once — no retry on 4xx
      expect(mockVerificationsCreate).toHaveBeenCalledTimes(1);
    });
  });

  // ─── AC-2.1: checkVerification ───────────────────────────────────────────

  describe('AC-2.1: checkVerification(phone, code)', () => {
    it('AC-2.1: should call Twilio verificationChecks.create exactly once', async () => {
      // AC-2.1: checkVerification delegates to Twilio once
      const phone = '+447700900010';
      const code = '123456';
      mockVerificationChecksCreate.mockResolvedValueOnce({
        valid: true,
        status: 'approved',
      });

      await service.checkVerification(phone, code);

      expect(mockVerificationChecksCreate).toHaveBeenCalledTimes(1);
    });

    it('AC-2.1: should call Twilio with the phone and code', async () => {
      // AC-2.1: phone as `to` and code as `code` — Twilio SDK contract
      const phone = '+447700900011';
      const code = '654321';
      mockVerificationChecksCreate.mockResolvedValueOnce({
        valid: true,
        status: 'approved',
      });

      await service.checkVerification(phone, code);

      expect(mockVerificationChecksCreate).toHaveBeenCalledWith({
        to: phone,
        code,
      });
    });

    it('AC-2.1: should return { valid: true, status: "approved" } on correct code', async () => {
      // AC-2.1: approved check — OtpService reads valid+status to branch on success
      const phone = '+447700900012';
      mockVerificationChecksCreate.mockResolvedValueOnce({
        valid: true,
        status: 'approved',
      });

      const result = await service.checkVerification(phone, '999999');

      expect(result).toEqual({ valid: true, status: 'approved' });
    });

    it('AC-2.3: should return { valid: false, status: "pending" } on wrong code', async () => {
      // AC-2.3: wrong code — OtpService must see valid=false to return 401
      const phone = '+447700900013';
      mockVerificationChecksCreate.mockResolvedValueOnce({
        valid: false,
        status: 'pending',
      });

      const result = await service.checkVerification(phone, '000000');

      expect(result).toEqual({ valid: false, status: 'pending' });
    });

    it('AC-2.3: should return { valid: false } on expired code', async () => {
      // AC-2.3: expired verification — treated same as invalid
      const phone = '+447700900014';
      mockVerificationChecksCreate.mockResolvedValueOnce({
        valid: false,
        status: 'expired',
      });

      const result = await service.checkVerification(phone, '111111');

      expect(result.valid).toBe(false);
    });

    it('AC-1.2: should reject empty code before calling Twilio', async () => {
      // AC-1.2: validation fires before API call
      await expect(service.checkVerification('+447700900015', '')).rejects.toThrow();
      expect(mockVerificationChecksCreate).not.toHaveBeenCalled();
    });

    it('AC-1.2: should reject empty phone in checkVerification before calling Twilio', async () => {
      // AC-1.2: body validation applies to verify endpoint too
      await expect(service.checkVerification('', '123456')).rejects.toThrow();
      expect(mockVerificationChecksCreate).not.toHaveBeenCalled();
    });
  });

  // ─── AC-5.1: Observability — error logging ───────────────────────────────

  describe('AC-5.1: error logging on Twilio failure', () => {
    it('AC-5.1: should log error via winston-logger when startVerification fails', async () => {
      // AC-5.1: "logged via @railrepay/winston-logger with { component, correlation_id, error, phone_e164_redacted }"
      const phone = '+447700900020';
      const twilioError = new Error('Network timeout');
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);
      mockVerificationsCreate.mockRejectedValueOnce(twilioError); // retry also fails

      await expect(service.startVerification(phone, 'corr-id-001')).rejects.toThrow();

      // Winston-logger must have been called with error level
      expect(sharedLogger.error).toHaveBeenCalled();
    });

    it('AC-5.1: error log must include phone_e164_redacted (last 4 digits visible)', async () => {
      // AC-5.1: "+447700900020" redacted to "+44****0020"
      const phone = '+447700900020';
      const twilioError = new Error('Service unavailable');
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);

      await expect(service.startVerification(phone, 'corr-id-002')).rejects.toThrow();

      // The error log call must contain redacted phone (last 4 digits visible)
      const errorCalls = sharedLogger.error.mock.calls;
      expect(errorCalls.length).toBeGreaterThan(0);
      const logPayload = JSON.stringify(errorCalls);
      // Last 4 digits of +447700900020 are 0020
      expect(logPayload).toContain('0020');
    });

    it('AC-5.1: error log must include correlation_id when provided', async () => {
      // AC-5.1: correlation_id propagates through to the error log
      const phone = '+447700900021';
      const correlationId = 'test-corr-id-abc123';
      const twilioError = new Error('Upstream failure');
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);

      await expect(service.startVerification(phone, correlationId)).rejects.toThrow();

      const errorCalls = sharedLogger.error.mock.calls;
      const logPayload = JSON.stringify(errorCalls);
      expect(logPayload).toContain(correlationId);
    });

    it('AC-5.1: error log must include component field', async () => {
      // AC-5.1: component field identifies the service layer for log routing
      const phone = '+447700900022';
      const twilioError = new Error('Connection refused');
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);
      mockVerificationsCreate.mockRejectedValueOnce(twilioError);

      await expect(service.startVerification(phone, 'corr-id-003')).rejects.toThrow();

      const errorCalls = sharedLogger.error.mock.calls;
      const logPayload = JSON.stringify(errorCalls);
      expect(logPayload).toContain('component');
    });
  });
});
