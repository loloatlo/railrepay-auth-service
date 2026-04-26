/**
 * OTP HTTP Handlers — auth-service
 *
 * handleStartOtp  — POST /auth/otp/start
 * handleVerifyOtp — POST /auth/otp/verify
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * Error mapping (HUMAN-LOCKED shape: { error, message?, details? }):
 *   invalid_request   → 400
 *   twilio_rejected   → 400
 *   rate_limited      → 429
 *   invalid_code      → 401
 *   upstream_unavailable → 503
 *   (any other)       → 500
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 */

import type { Request, Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';
import type { OtpService } from '../services/otp.service.js';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Error code → HTTP status mapping ────────────────────────────────────────

const ERROR_STATUS_MAP: Record<string, number> = {
  invalid_request: 400,
  twilio_rejected: 400,
  rate_limited: 429,
  invalid_code: 401,
  upstream_unavailable: 503,
};

function statusForError(code: string): number {
  return ERROR_STATUS_MAP[code] ?? 500;
}

/** Narrow an unknown thrown value to an error object with a known shape */
function toErrorObject(err: unknown): Record<string, unknown> {
  if (err && typeof err === 'object' && 'error' in err) {
    return err as Record<string, unknown>;
  }
  return { error: 'internal_error' };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /auth/otp/start
 * AC-1.1: 202 { status: 'sent' }
 * AC-1.2: 400 { error: 'invalid_request', details: <field> }
 * AC-1.3: 400 { error: 'twilio_rejected' } / 503 { error: 'upstream_unavailable' }
 * AC-6.1: 429 { error: 'rate_limited', retry_after_seconds: <int> }
 */
export async function handleStartOtp(
  req: Request,
  res: Response,
  otpService: OtpService
): Promise<void> {
  const correlationId = req.headers['x-correlation-id'] as string | undefined;

  try {
    const { channel, phone_e164 } = req.body as { channel?: string; phone_e164?: string };

    const result = await otpService.startOtp({
      channel: channel ?? '',
      phone_e164: phone_e164 ?? '',
      correlationId,
    });

    res.status(202).json(result);
  } catch (err) {
    const errObj = toErrorObject(err);
    const code = typeof errObj.error === 'string' ? errObj.error : 'internal_error';
    const status = statusForError(code);

    getLogger().error('handleStartOtp error', {
      component: 'auth-service/otp-handler',
      correlation_id: correlationId,
      error: code,
    });

    res.status(status).json(errObj);
  }
}

/**
 * POST /auth/otp/verify
 * AC-2.2: 200 { user_id, session_id }
 * AC-2.3: 401 { error: 'invalid_code' }
 * AC-5.1: 503 { error: 'upstream_unavailable' }
 * AC-1.2: 400 { error: 'invalid_request', details: <field> }
 */
export async function handleVerifyOtp(
  req: Request,
  res: Response,
  otpService: OtpService
): Promise<void> {
  const correlationId = req.headers['x-correlation-id'] as string | undefined;

  try {
    const { channel, phone_e164, code } = req.body as {
      channel?: string;
      phone_e164?: string;
      code?: string;
    };

    const result = await otpService.verifyOtp({
      channel: channel ?? '',
      phone_e164: phone_e164 ?? '',
      code: code ?? '',
      correlationId,
    });

    res.status(200).json(result);
  } catch (err) {
    const errObj = toErrorObject(err);
    const code = typeof errObj.error === 'string' ? errObj.error : 'internal_error';
    const status = statusForError(code);

    getLogger().error('handleVerifyOtp error', {
      component: 'auth-service/otp-handler',
      correlation_id: correlationId,
      error: code,
    });

    res.status(status).json(errObj);
  }
}
