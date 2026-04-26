/**
 * Unit Tests: OTP route handlers (POST /auth/otp/start + POST /auth/otp/verify)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/routes/otp.ts  (or equivalent — exports createOtpRouter(otpService))
 *   src/app.ts updated to mount the OTP router
 *
 * Strategy: supertest + mocked OtpService. Tests verify HTTP contract only
 *   (status codes, response shapes, correlation-ID header propagation).
 *   OtpService unit tests (otp.service.test.ts) verify orchestration logic.
 *
 * AC coverage map:
 *   AC-1.1  POST /auth/otp/start 202 { status: 'sent' } on happy path
 *   AC-1.2  POST /auth/otp/start 400 { error: 'invalid_request', details: <field> } on bad body
 *   AC-1.3  POST /auth/otp/start 400 { error: 'twilio_rejected' } / 503 { error: 'upstream_unavailable' }
 *   AC-2.1  POST /auth/otp/verify calls checkVerification
 *   AC-2.2  POST /auth/otp/verify 200 { user_id, session_id } on approved
 *   AC-2.3  POST /auth/otp/verify 401 { error: 'invalid_code' } on wrong code
 *   AC-6.1  POST /auth/otp/start 429 { error: 'rate_limited', retry_after_seconds: <int> }
 *   AC-5.1  POST /auth/otp/verify 503 { error: 'upstream_unavailable' } on Twilio failure
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §6.1 Guideline #11 — Infrastructure package mocking patterns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

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

// ─── OtpService mock ─────────────────────────────────────────────────────────
const mockStartOtp = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('../../../src/services/otp.service.js', () => ({
  OtpService: vi.fn().mockImplementation(() => ({
    startOtp: mockStartOtp,
    verifyOtp: mockVerifyOtp,
  })),
}));

// ─── Router under test ────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { createOtpRouter } from '../../../src/routes/otp.js';

// ─── Test app factory ─────────────────────────────────────────────────────────
// Builds a minimal Express app wired with the OTP router and a mock OtpService.
function makeApp() {
  const app = express();
  app.use(express.json());

  const mockOtpService = {
    startOtp: mockStartOtp,
    verifyOtp: mockVerifyOtp,
  };

  app.use('/auth', createOtpRouter(mockOtpService));
  return app;
}

// ─── Test data constants ──────────────────────────────────────────────────────
// Unique per test path to satisfy Guideline #6
const USER_ID = 'f0000000-0000-4000-8000-000000000041';
const SESSION_ID = 'f0000000-0000-4000-8000-000000000042';

describe('RAILREPAY-AUTH-003: OTP route handlers (HTTP contract)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();
    app = makeApp();
  });

  // ─── POST /auth/otp/start ────────────────────────────────────────────────

  describe('POST /auth/otp/start', () => {
    describe('AC-1.1: happy path', () => {
      it('AC-1.1: should return 202 on successful OTP start', async () => {
        // AC-1.1: "/auth/otp/start returns 202 { status: 'sent' }"
        mockStartOtp.mockResolvedValueOnce({ status: 'sent' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900080' });

        expect(res.status).toBe(202);
      });

      it('AC-1.1: should return { status: "sent" } body on success', async () => {
        // AC-1.1: exact response shape locked
        mockStartOtp.mockResolvedValueOnce({ status: 'sent' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900081' });

        expect(res.body).toEqual({ status: 'sent' });
      });

      it('AC-1.1: should call OtpService.startOtp with channel and phone_e164', async () => {
        // AC-1.1: handler must pass request body to service
        mockStartOtp.mockResolvedValueOnce({ status: 'sent' });

        await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'whatsapp', phone_e164: '+447700900082' });

        expect(mockStartOtp).toHaveBeenCalledWith(
          expect.objectContaining({ channel: 'whatsapp', phone_e164: '+447700900082' })
        );
      });
    });

    describe('AC-1.2: body validation', () => {
      it('AC-1.2: should return 400 when phone_e164 is missing', async () => {
        // AC-1.2: "missing/empty phone_e164 → 400 { error: 'invalid_request', details: <field> }"
        // OtpService mock not needed — validation fires at handler level
        mockStartOtp.mockRejectedValueOnce({ error: 'invalid_request', details: 'phone_e164' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web' }); // no phone_e164

        expect(res.status).toBe(400);
      });

      it('AC-1.2: should return error "invalid_request" when phone_e164 is missing', async () => {
        // AC-1.2: error shape
        mockStartOtp.mockRejectedValueOnce({ error: 'invalid_request', details: 'phone_e164' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web' });

        expect(res.body.error).toBe('invalid_request');
      });

      it('AC-1.2: should return 400 when channel is missing', async () => {
        // AC-1.2: channel is required
        mockStartOtp.mockRejectedValueOnce({ error: 'invalid_request', details: 'channel' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ phone_e164: '+447700900083' }); // no channel

        expect(res.status).toBe(400);
      });

      it('AC-1.2: should include details field in 400 response', async () => {
        // AC-1.2: "details: <field>" — tells caller which field failed
        mockStartOtp.mockRejectedValueOnce({ error: 'invalid_request', details: 'phone_e164' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web' });

        expect(res.body).toHaveProperty('details');
      });
    });

    describe('AC-1.3: Twilio error responses', () => {
      it('AC-1.3: should return 400 { error: "twilio_rejected" } on Twilio 4xx', async () => {
        // AC-1.3: "Twilio 4xx (invalid phone) → 400 { error: 'twilio_rejected' }"
        mockStartOtp.mockRejectedValueOnce({ error: 'twilio_rejected' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900084' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('twilio_rejected');
      });

      it('AC-1.3: should return 503 { error: "upstream_unavailable" } on Twilio 5xx', async () => {
        // AC-1.3: "Twilio 5xx/network → 503 { error: 'upstream_unavailable' } after 1 retry"
        mockStartOtp.mockRejectedValueOnce({ error: 'upstream_unavailable' });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900085' });

        expect(res.status).toBe(503);
        expect(res.body.error).toBe('upstream_unavailable');
      });
    });

    describe('AC-6.1: rate limiting', () => {
      it('AC-6.1: should return 429 { error: "rate_limited" } when rate limit exceeded', async () => {
        // AC-6.1: "6th request returns 429 { error: 'rate_limited', retry_after_seconds: <int> }"
        mockStartOtp.mockRejectedValueOnce({
          error: 'rate_limited',
          retry_after_seconds: 3540,
        });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900086' });

        expect(res.status).toBe(429);
        expect(res.body.error).toBe('rate_limited');
      });

      it('AC-6.1: 429 response must include retry_after_seconds as integer', async () => {
        // AC-6.1: "retry_after_seconds: <int>"
        mockStartOtp.mockRejectedValueOnce({
          error: 'rate_limited',
          retry_after_seconds: 3540,
        });

        const res = await request(app)
          .post('/auth/otp/start')
          .send({ channel: 'web', phone_e164: '+447700900087' });

        expect(typeof res.body.retry_after_seconds).toBe('number');
        expect(Number.isInteger(res.body.retry_after_seconds)).toBe(true);
      });
    });
  });

  // ─── POST /auth/otp/verify ───────────────────────────────────────────────

  describe('POST /auth/otp/verify', () => {
    describe('AC-2.2: success path (valid code)', () => {
      it('AC-2.2: should return 200 on approved verification', async () => {
        // AC-2.2: "return 200 { user_id, session_id }"
        mockVerifyOtp.mockResolvedValueOnce({ user_id: USER_ID, session_id: SESSION_ID });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900090', code: '123456' });

        expect(res.status).toBe(200);
      });

      it('AC-2.2: should return { user_id, session_id } in body', async () => {
        // AC-2.2: exact response shape locked
        mockVerifyOtp.mockResolvedValueOnce({ user_id: USER_ID, session_id: SESSION_ID });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900091', code: '234567' });

        expect(res.body).toEqual({ user_id: USER_ID, session_id: SESSION_ID });
      });

      it('AC-2.2: should call OtpService.verifyOtp with channel, phone_e164, and code', async () => {
        // AC-2.1: handler passes all three fields to service
        mockVerifyOtp.mockResolvedValueOnce({ user_id: USER_ID, session_id: SESSION_ID });

        await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'rn', phone_e164: '+447700900092', code: '345678' });

        expect(mockVerifyOtp).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: 'rn',
            phone_e164: '+447700900092',
            code: '345678',
          })
        );
      });
    });

    describe('AC-2.3: invalid code path', () => {
      it('AC-2.3: should return 401 when code is invalid', async () => {
        // AC-2.3: "return 401 { error: 'invalid_code' }"
        mockVerifyOtp.mockRejectedValueOnce({ error: 'invalid_code' });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900093', code: '000000' });

        expect(res.status).toBe(401);
      });

      it('AC-2.3: should return { error: "invalid_code" } in body', async () => {
        // AC-2.3: exact error shape
        mockVerifyOtp.mockRejectedValueOnce({ error: 'invalid_code' });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900094', code: '999999' });

        expect(res.body.error).toBe('invalid_code');
      });
    });

    describe('AC-5.1: Twilio failure', () => {
      it('AC-5.1: should return 503 when Twilio fails during verify', async () => {
        // AC-5.1: "return 503; ZERO DB rows" — upstream failure handled gracefully
        mockVerifyOtp.mockRejectedValueOnce({ error: 'upstream_unavailable' });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900095', code: '777777' });

        expect(res.status).toBe(503);
      });

      it('AC-5.1: should return { error: "upstream_unavailable" } on Twilio failure', async () => {
        // AC-5.1: exact error code
        mockVerifyOtp.mockRejectedValueOnce({ error: 'upstream_unavailable' });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900096', code: '888888' });

        expect(res.body.error).toBe('upstream_unavailable');
      });
    });

    describe('AC-1.2: body validation for verify', () => {
      it('AC-1.2: should return 400 when code is missing from verify request', async () => {
        // AC-1.2: code is required for verify
        mockVerifyOtp.mockRejectedValueOnce({ error: 'invalid_request', details: 'code' });

        const res = await request(app)
          .post('/auth/otp/verify')
          .send({ channel: 'web', phone_e164: '+447700900097' }); // no code

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_request');
      });
    });
  });
});
