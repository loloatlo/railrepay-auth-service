/**
 * OtpService — auth-service
 *
 * Orchestrates: TwilioVerifyService + IdentityService + SessionRepository + JwtService.
 *
 * Story   : RAILREPAY-AUTH-003 / extended for RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25 (extended 2026-04-26 for AUTH-004 AC-D1.1)
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 *
 * Error shape (HUMAN-LOCKED):
 *   { error: '<machine_code>', message?: '<human>', details?: <object> }
 */

import { createLogger } from '@railrepay/winston-logger';
import { v4 as uuidv4 } from 'uuid';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Valid channels (locked) ──────────────────────────────────────────────────

const VALID_CHANNELS = new Set(['web', 'whatsapp', 'rn', 'swift']);

/** E.164 regex */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/** Redact phone: last 4 digits visible */
function redactPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  const visible = phone.slice(-4);
  const plusMatch = phone.match(/^(\+\d{1,3})/);
  if (plusMatch) {
    return `${plusMatch[1]}****${visible}`;
  }
  return `****${visible}`;
}

// ─── Error objects ────────────────────────────────────────────────────────────

function makeError(code: string, message?: string, details?: unknown): object {
  return Object.assign(
    { error: code },
    message ? { message } : {},
    details !== undefined ? { details } : {}
  );
}

// ─── Dependency interfaces ────────────────────────────────────────────────────

export interface ITwilioVerifyService {
  startVerification(phone_e164: string, correlationId?: string): Promise<{ sid: string; status: string }>;
  checkVerification(phone_e164: string, code: string): Promise<{ valid: boolean; status: string }>;
}

export interface IIdentityService {
  ensureUser(params: { channel: string; phone_e164: string }): Promise<{ user_id: string }>;
}

export interface ISessionRepository {
  create(params: { user_id: string; channel: string }): Promise<{ session_id: string; user_id: string; channel: string; issued_at: Date; expires_at: Date; revoked_at: Date | null }>;
}

// AUTH-004: JwtService interface for dependency injection
export interface IJwtService {
  sign(input: { userId: string; sessionId: string }): Promise<string>;
}

export interface OtpServiceDeps {
  twilioVerifyService: ITwilioVerifyService;
  identityService: IIdentityService;
  sessionRepository: ISessionRepository;
  /** AUTH-004: Optional JwtService — required in production, optional for unit test seam */
  jwtService?: IJwtService;
}

// ─── Request / response shapes ────────────────────────────────────────────────

export interface StartOtpParams {
  channel: string;
  phone_e164: string;
  correlationId?: string;
}

export interface StartOtpResult {
  status: 'sent';
}

export interface VerifyOtpParams {
  channel: string;
  phone_e164: string;
  code: string;
  correlationId?: string;
}

export interface VerifyOtpResult {
  user_id: string;
  session_id: string;
  /** AUTH-004 AC-D1.1: JWT access token issued on successful verification */
  access_token: string;
  /** AUTH-004 AC-D1.1: TTL in seconds (expires_in: 900) */
  expires_in: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class OtpService {
  private readonly twilioVerifyService: ITwilioVerifyService;
  private readonly identityService: IIdentityService;
  private readonly sessionRepository: ISessionRepository;
  private readonly jwtService?: IJwtService;

  constructor(deps: OtpServiceDeps) {
    this.twilioVerifyService = deps.twilioVerifyService;
    this.identityService = deps.identityService;
    this.sessionRepository = deps.sessionRepository;
    this.jwtService = deps.jwtService;
  }

  /**
   * Start OTP verification for a phone number.
   *
   * AC-1.1: Calls TwilioVerifyService.startVerification once; returns { status: 'sent' }
   * AC-1.2: Validates phone_e164 and channel before calling Twilio
   * AC-1.3: Twilio 4xx → twilio_rejected; 5xx → upstream_unavailable
   */
  async startOtp(params: StartOtpParams): Promise<StartOtpResult> {
    const { channel, phone_e164, correlationId } = params;

    // AC-1.2: Validate inputs
    if (!phone_e164 || !E164_REGEX.test(phone_e164)) {
      throw makeError('invalid_request', 'phone_e164 must be a valid E.164 number', 'phone_e164');
    }
    if (!channel || !VALID_CHANNELS.has(channel)) {
      throw makeError('invalid_request', `channel must be one of: ${[...VALID_CHANNELS].join(', ')}`, 'channel');
    }

    // Generate correlation ID if not provided (ADR-002: all Twilio calls must have tracing)
    const effectiveCorrelationId = correlationId ?? uuidv4();

    // ────────────────────────────────────────────────────────────────────────
    // TODO REMOVE BEFORE BETA LAUNCH (BL-305) — added 2026-05-27
    // OTP_TEST_BYPASS: env-var-gated bypass for international-roaming testing.
    // If OTP_TEST_BYPASS_CODE is set AND phone is in OTP_TEST_BYPASS_PHONES,
    // skip the Twilio start call (no SMS sent) and return success. The matching
    // bypass block in verifyOtp() accepts the magic code on the next request.
    // Unsetting either env var disables the bypass instantly with no code change.
    // ────────────────────────────────────────────────────────────────────────
    const startBypassCode = process.env.OTP_TEST_BYPASS_CODE;
    const startBypassPhones = (process.env.OTP_TEST_BYPASS_PHONES ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (startBypassCode && startBypassPhones.includes(phone_e164)) {
      getLogger().warn('OTP_TEST_BYPASS active — skipping Twilio start (no SMS sent)', {
        component: 'auth-service/otp',
        correlation_id: effectiveCorrelationId,
        phone_e164_redacted: redactPhone(phone_e164),
        channel,
      });
      return { status: 'sent' };
    }
    // END OTP_TEST_BYPASS (BL-305)

    try {
      await this.twilioVerifyService.startVerification(phone_e164, effectiveCorrelationId);
      return { status: 'sent' };
    } catch (err) {
      return this._mapTwilioStartError(err);
    }
  }

  /**
   * Verify OTP code and create session on success.
   *
   * AC-2.1: Calls TwilioVerifyService.checkVerification once
   * AC-2.2: valid=true → ensureUser + SessionRepository.create → { user_id, session_id }
   * AC-2.3: valid=false → throw { error: 'invalid_code' }; NO DB writes
   * AC-5.1: Twilio failure → throw { error: 'upstream_unavailable' }; ZERO DB writes
   */
  async verifyOtp(params: VerifyOtpParams): Promise<VerifyOtpResult> {
    const { channel, phone_e164, code, correlationId } = params;

    // ────────────────────────────────────────────────────────────────────────
    // TODO REMOVE BEFORE BETA LAUNCH (BL-305) — added 2026-05-27
    // OTP_TEST_BYPASS: env-var-gated bypass. All three conditions must match:
    //   - OTP_TEST_BYPASS_CODE env var is set (the magic code)
    //   - phone is in OTP_TEST_BYPASS_PHONES allowlist
    //   - submitted code equals OTP_TEST_BYPASS_CODE
    // If matched, skip Twilio entirely and follow the normal AC-2.2 success
    // path (ensureUser + createSession + JWT). Unsetting either env var
    // disables the bypass instantly with no code change.
    // ────────────────────────────────────────────────────────────────────────
    const verifyBypassCode = process.env.OTP_TEST_BYPASS_CODE;
    const verifyBypassPhones = (process.env.OTP_TEST_BYPASS_PHONES ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (verifyBypassCode && verifyBypassPhones.includes(phone_e164) && code === verifyBypassCode) {
      getLogger().warn('OTP_TEST_BYPASS used — skipping Twilio verification', {
        component: 'auth-service/otp',
        correlation_id: correlationId,
        phone_e164_redacted: redactPhone(phone_e164),
        channel,
      });
      const { user_id } = await this.identityService.ensureUser({ channel, phone_e164 });
      const session = await this.sessionRepository.create({ user_id, channel });
      let access_token = '';
      if (this.jwtService) {
        access_token = await this.jwtService.sign({
          userId: user_id,
          sessionId: session.session_id,
        });
      }
      return {
        user_id,
        session_id: session.session_id,
        access_token,
        expires_in: 900,
      };
    }
    // END OTP_TEST_BYPASS (BL-305)

    let checkResult: { valid: boolean; status: string };
    try {
      checkResult = await this.twilioVerifyService.checkVerification(phone_e164, code);
    } catch (err) {
      // AC-5.1: Twilio failure during verify → 503, no DB writes
      getLogger().error('Twilio checkVerification failed', {
        component: 'auth-service/otp',
        correlation_id: correlationId,
        phone_e164_redacted: redactPhone(phone_e164),
        error: err instanceof Error ? err.message : String(err),
      });
      throw makeError('upstream_unavailable', 'OTP verification service is temporarily unavailable');
    }

    if (!checkResult.valid) {
      // AC-2.3: wrong/expired code → 401
      throw makeError('invalid_code', 'The verification code is invalid or has expired');
    }

    // AC-2.2: approved → upsert identity + create session
    const { user_id } = await this.identityService.ensureUser({ channel, phone_e164 });
    const session = await this.sessionRepository.create({ user_id, channel });

    // AUTH-004 AC-D1.1: mint JWT on successful OTP verify
    // jwtService is optional for backward-compatible unit-test seam (no-op path returns empty token)
    let access_token = '';
    if (this.jwtService) {
      access_token = await this.jwtService.sign({
        userId: user_id,
        sessionId: session.session_id,
      });
    }

    return {
      user_id,
      session_id: session.session_id,
      access_token,
      expires_in: 900,
    };
  }

  /** Map Twilio errors from startVerification to OTP error shapes */
  private _mapTwilioStartError(err: unknown): never {
    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        throw makeError('twilio_rejected', 'Phone number was rejected by Twilio');
      }
      if (typeof status === 'number' && status >= 500) {
        throw makeError('upstream_unavailable', 'Twilio Verify service is temporarily unavailable');
      }
    }
    // Network/unknown — treat as upstream failure
    throw makeError('upstream_unavailable', 'Twilio Verify service is temporarily unavailable');
  }
}
