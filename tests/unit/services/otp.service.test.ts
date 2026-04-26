/**
 * Unit Tests: OtpService (AUTH-003)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/services/otp.service.ts
 * Expected failure mode: "Cannot find module '../../../src/services/otp.service.js'"
 *
 * OtpService orchestrates: TwilioVerifyService + IdentityService + SessionRepository.
 * All three are mocked here — OtpService unit tests isolate orchestration logic only.
 *
 * AC coverage map:
 *   AC-1.1  startOtp: calls TwilioVerifyService.startVerification once; returns { status: 'sent' }
 *   AC-1.2  startOtp: validates phone_e164 and channel before calling Twilio
 *   AC-1.3  startOtp: Twilio 4xx → twilio_rejected; 5xx → upstream_unavailable after 1 retry
 *   AC-2.1  verifyOtp: calls TwilioVerifyService.checkVerification once
 *   AC-2.2  verifyOtp: on valid=true → calls IdentityService.ensureUser + SessionRepository.create; returns { user_id, session_id }
 *   AC-2.3  verifyOtp: on valid=false → returns { error: 'invalid_code' }; NO DB writes
 *   AC-5.1  verifyOtp: Twilio failure → log with correlation_id; return 503 shape; ZERO DB writes
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §6.1 Guideline #11 — Infrastructure package mocking patterns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ─── Dependency mocks ─────────────────────────────────────────────────────────
// Mock at service boundaries (Guideline #3) — not internal helpers.

const mockStartVerification = vi.fn();
const mockCheckVerification = vi.fn();
vi.mock('../../../src/twilio/twilio-verify.service.js', () => ({
  TwilioVerifyService: vi.fn().mockImplementation(() => ({
    startVerification: mockStartVerification,
    checkVerification: mockCheckVerification,
  })),
}));

const mockEnsureUser = vi.fn();
vi.mock('../../../src/services/identity.service.js', () => ({
  IdentityService: vi.fn().mockImplementation(() => ({
    ensureUser: mockEnsureUser,
  })),
}));

const mockSessionCreate = vi.fn();
vi.mock('../../../src/repositories/session.repository.js', () => ({
  SessionRepository: vi.fn().mockImplementation(() => ({
    create: mockSessionCreate,
  })),
}));

// ─── Module under test ───────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { OtpService } from '../../../src/services/otp.service.js';

// ─── Fixture constants ───────────────────────────────────────────────────────
// Unique per test scenario to satisfy Guideline #6 (differentiating test data)
const USER_ID_VERIFIED = 'd0000000-0000-4000-8000-000000000021';
const SESSION_ID_VERIFIED = 'e0000000-0000-4000-8000-000000000031';

// Phone series for OtpService tests
const PHONE_START = '+447700900050';     // AC-1.1
const PHONE_VERIFY_OK = '+447700900051'; // AC-2.2 success
const PHONE_VERIFY_BAD = '+447700900052'; // AC-2.3 wrong code
const PHONE_TWILIO_FAIL = '+447700900053'; // AC-5.1 Twilio failure

describe('RAILREPAY-AUTH-003: OtpService unit tests', () => {
  let service: InstanceType<typeof OtpService>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();

    // OtpService receives its dependencies at construction time
    // (constructor injection — testability per ADR-014)
    service = new OtpService({
      twilioVerifyService: {
        startVerification: mockStartVerification,
        checkVerification: mockCheckVerification,
      },
      identityService: {
        ensureUser: mockEnsureUser,
      },
      sessionRepository: {
        create: mockSessionCreate,
      },
    });
  });

  // ─── AC-1.1: startOtp ────────────────────────────────────────────────────

  describe('AC-1.1: startOtp({ channel, phone_e164 })', () => {
    it('AC-1.1: should call TwilioVerifyService.startVerification exactly once', async () => {
      // AC-1.1: one Twilio call per request — no silent double-send
      mockStartVerification.mockResolvedValueOnce({ sid: 'VEtest', status: 'pending' });

      await service.startOtp({ channel: 'web', phone_e164: PHONE_START });

      expect(mockStartVerification).toHaveBeenCalledTimes(1);
    });

    it('AC-1.1: should call startVerification with the provided phone_e164', async () => {
      // AC-1.1: phone is passed through to Twilio — no transformation
      mockStartVerification.mockResolvedValueOnce({ sid: 'VEtest', status: 'pending' });

      await service.startOtp({ channel: 'web', phone_e164: PHONE_START });

      expect(mockStartVerification).toHaveBeenCalledWith(PHONE_START, expect.anything());
    });

    it('AC-1.1: should return { status: "sent" } on success', async () => {
      // AC-1.1: "/auth/otp/start returns 202 { status: 'sent' }"
      mockStartVerification.mockResolvedValueOnce({ sid: 'VEtest', status: 'pending' });

      const result = await service.startOtp({ channel: 'web', phone_e164: PHONE_START });

      expect(result).toEqual({ status: 'sent' });
    });

    it('AC-1.1: should not call IdentityService or SessionRepository during startOtp', async () => {
      // AC-1.1: startOtp only starts verification — no DB writes happen at this stage
      mockStartVerification.mockResolvedValueOnce({ sid: 'VEtest', status: 'pending' });

      await service.startOtp({ channel: 'web', phone_e164: PHONE_START });

      expect(mockEnsureUser).not.toHaveBeenCalled();
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });
  });

  // ─── AC-1.2: startOtp validation ─────────────────────────────────────────

  describe('AC-1.2: startOtp — body validation', () => {
    it('AC-1.2: should reject missing phone_e164 without calling Twilio', async () => {
      // AC-1.2: 400 invalid_request — missing phone
      await expect(
        service.startOtp({ channel: 'web', phone_e164: '' })
      ).rejects.toMatchObject({ error: 'invalid_request' });

      expect(mockStartVerification).not.toHaveBeenCalled();
    });

    it('AC-1.2: should reject malformed phone (non-E.164) without calling Twilio', async () => {
      // AC-1.2: "07700900000" is not E.164 — should fail validation
      await expect(
        service.startOtp({ channel: 'web', phone_e164: '07700900000' })
      ).rejects.toMatchObject({ error: 'invalid_request' });

      expect(mockStartVerification).not.toHaveBeenCalled();
    });

    it('AC-1.2: should reject invalid channel value without calling Twilio', async () => {
      // AC-1.2: channel must be one of web|whatsapp|rn|swift
      await expect(
        service.startOtp({ channel: 'telegram', phone_e164: PHONE_START })
      ).rejects.toMatchObject({ error: 'invalid_request' });

      expect(mockStartVerification).not.toHaveBeenCalled();
    });

    it('AC-1.2: should accept all valid channel values', async () => {
      // AC-1.2: boundary check — all four channels must pass validation
      const validChannels = ['web', 'whatsapp', 'rn', 'swift'];
      // Use unique phones per channel to satisfy Guideline #6
      const phones = ['+447700900060', '+447700900061', '+447700900062', '+447700900063'];

      for (let i = 0; i < validChannels.length; i++) {
        mockStartVerification.mockResolvedValueOnce({ sid: 'VEtest', status: 'pending' });
        await expect(
          service.startOtp({ channel: validChannels[i], phone_e164: phones[i] })
        ).resolves.toEqual({ status: 'sent' });
      }
    });
  });

  // ─── AC-1.3: startOtp — Twilio error handling ────────────────────────────

  describe('AC-1.3: startOtp — Twilio error handling', () => {
    it('AC-1.3: should throw { error: "twilio_rejected" } on Twilio 4xx', async () => {
      // AC-1.3: "Twilio 4xx (invalid phone) → 400 { error: 'twilio_rejected' }"
      const twilioClientError = Object.assign(
        new Error('Invalid phone'),
        { status: 400, code: 21211 }
      );
      mockStartVerification.mockRejectedValueOnce(twilioClientError);

      await expect(
        service.startOtp({ channel: 'web', phone_e164: '+447700900070' })
      ).rejects.toMatchObject({ error: 'twilio_rejected' });
    });

    it('AC-1.3: should throw { error: "upstream_unavailable" } when Twilio 5xx fails after retry', async () => {
      // AC-1.3: "Twilio 5xx/network → 503 { error: 'upstream_unavailable' } after 1 retry"
      const serverError = Object.assign(
        new Error('Service unavailable'),
        { status: 503 }
      );
      mockStartVerification.mockRejectedValueOnce(serverError);

      await expect(
        service.startOtp({ channel: 'web', phone_e164: '+447700900071' })
      ).rejects.toMatchObject({ error: 'upstream_unavailable' });
    });
  });

  // ─── AC-2.1: verifyOtp ───────────────────────────────────────────────────

  describe('AC-2.1: verifyOtp({ channel, phone_e164, code })', () => {
    it('AC-2.1: should call TwilioVerifyService.checkVerification exactly once', async () => {
      // AC-2.1: one Twilio check per verify request
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '123456' });

      expect(mockCheckVerification).toHaveBeenCalledTimes(1);
    });

    it('AC-2.1: should call checkVerification with phone_e164 and code', async () => {
      // AC-2.1: phone and code passed through correctly
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '654321' });

      expect(mockCheckVerification).toHaveBeenCalledWith(PHONE_VERIFY_OK, '654321');
    });
  });

  // ─── AC-2.2: verifyOtp success ───────────────────────────────────────────

  describe('AC-2.2: verifyOtp — valid code (approved)', () => {
    it('AC-2.2: should call IdentityService.ensureUser on approved verification', async () => {
      // AC-2.2: "upsert identity" step — IdentityService must be called
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '111111' });

      expect(mockEnsureUser).toHaveBeenCalledTimes(1);
    });

    it('AC-2.2: should call IdentityService.ensureUser with channel and phone_e164', async () => {
      // AC-2.2: channel must be passed to IdentityService (DR-UC-002: trust request body)
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '222222' });

      expect(mockEnsureUser).toHaveBeenCalledWith({
        channel: 'web',
        phone_e164: PHONE_VERIFY_OK,
      });
    });

    it('AC-2.2: should call SessionRepository.create with user_id and channel on success', async () => {
      // AC-2.2: "create session via SessionRepository.create({ user_id, channel })"
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '333333' });

      expect(mockSessionCreate).toHaveBeenCalledWith({
        user_id: USER_ID_VERIFIED,
        channel: 'web',
      });
    });

    it('AC-2.2: should return { user_id, session_id } on approved verification', async () => {
      // AC-2.2: "return 200 { user_id, session_id }"
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      const result = await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '444444' });

      expect(result).toMatchObject({ user_id: USER_ID_VERIFIED, session_id: SESSION_ID_VERIFIED });
    });

    it('AC-2.2: returned user_id must be UUID v4 format', async () => {
      // AC-2.2: "UUID v4 shape"
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      const result = await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '555555' });

      expect(result.user_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('AC-2.2: returned session_id must be UUID v4 format', async () => {
      // AC-6.2: "returned session_id resolves to row in user_identity.sessions"
      mockCheckVerification.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockEnsureUser.mockResolvedValueOnce({ user_id: USER_ID_VERIFIED });
      mockSessionCreate.mockResolvedValueOnce({
        session_id: SESSION_ID_VERIFIED,
        user_id: USER_ID_VERIFIED,
        channel: 'web',
        issued_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      });

      const result = await service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_OK, code: '666666' });

      expect(result.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  // ─── AC-2.3: verifyOtp — invalid code ────────────────────────────────────

  describe('AC-2.3: verifyOtp — invalid code (valid=false)', () => {
    it('AC-2.3: should throw { error: "invalid_code" } when code is wrong', async () => {
      // AC-2.3: "return 401 { error: 'invalid_code' }" — wrong code
      // Unique phone so this test scenario is clearly differentiated
      mockCheckVerification.mockResolvedValueOnce({ valid: false, status: 'pending' });

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_BAD, code: '000000' })
      ).rejects.toMatchObject({ error: 'invalid_code' });
    });

    it('AC-2.3: should NOT call IdentityService.ensureUser when code is invalid', async () => {
      // AC-2.3: "NO DB writes" — IdentityService must not be called on invalid code
      mockCheckVerification.mockResolvedValueOnce({ valid: false, status: 'pending' });

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_BAD, code: '999999' })
      ).rejects.toMatchObject({ error: 'invalid_code' });

      expect(mockEnsureUser).not.toHaveBeenCalled();
    });

    it('AC-2.3: should NOT call SessionRepository.create when code is invalid', async () => {
      // AC-2.3: "NO DB writes" — SessionRepository must not be called on invalid code
      mockCheckVerification.mockResolvedValueOnce({ valid: false, status: 'expired' });

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_VERIFY_BAD, code: '888888' })
      ).rejects.toMatchObject({ error: 'invalid_code' });

      expect(mockSessionCreate).not.toHaveBeenCalled();
    });
  });

  // ─── AC-5.1: Twilio failure during verify ────────────────────────────────

  describe('AC-5.1: verifyOtp — Twilio failure', () => {
    it('AC-5.1: should throw { error: "upstream_unavailable" } when checkVerification fails', async () => {
      // AC-5.1: "return 503; ZERO DB rows in users/channel_identities/sessions"
      const twilioError = new Error('Network failure');
      mockCheckVerification.mockRejectedValueOnce(twilioError);

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_TWILIO_FAIL, code: '777777' })
      ).rejects.toMatchObject({ error: 'upstream_unavailable' });
    });

    it('AC-5.1: should NOT call IdentityService.ensureUser when Twilio fails', async () => {
      // AC-5.1: ZERO DB writes on Twilio failure
      const twilioError = new Error('Connection refused');
      mockCheckVerification.mockRejectedValueOnce(twilioError);

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_TWILIO_FAIL, code: '666666' })
      ).rejects.toMatchObject({ error: 'upstream_unavailable' });

      expect(mockEnsureUser).not.toHaveBeenCalled();
    });

    it('AC-5.1: should NOT call SessionRepository.create when Twilio fails', async () => {
      // AC-5.1: ZERO DB writes on Twilio failure
      const twilioError = new Error('Timeout');
      mockCheckVerification.mockRejectedValueOnce(twilioError);

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_TWILIO_FAIL, code: '555555' })
      ).rejects.toMatchObject({ error: 'upstream_unavailable' });

      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('AC-5.1: should log error via winston-logger when Twilio fails during verify', async () => {
      // AC-5.1: "log error via @railrepay/winston-logger with { component, correlation_id, error, phone_e164_redacted }"
      const twilioError = new Error('Service down');
      mockCheckVerification.mockRejectedValueOnce(twilioError);

      await expect(
        service.verifyOtp({ channel: 'web', phone_e164: PHONE_TWILIO_FAIL, code: '444444', correlationId: 'corr-verify-001' })
      ).rejects.toMatchObject({ error: 'upstream_unavailable' });

      expect(sharedLogger.error).toHaveBeenCalled();
    });
  });
});
