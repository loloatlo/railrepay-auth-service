/**
 * Configuration module for auth-service
 *
 * Reads PORT, DATABASE_URL, TWILIO_*, and OTP rate-limit env vars.
 * Throws an Error if any required variable is absent (fail-fast).
 *
 * ADR references:
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 *
 * AUTH-003: Extended with Twilio and OTP rate-limit configuration.
 */

export interface Config {
  port: number;
  databaseUrl: string;
  /** Twilio Account SID (TWILIO_ACCOUNT_SID) */
  twilioAccountSid: string;
  /** Twilio Auth Token (TWILIO_AUTH_TOKEN) */
  twilioAuthToken: string;
  /** Twilio Verify Service SID (TWILIO_VERIFY_SERVICE_SID) */
  twilioVerifyServiceSid: string;
  /** Max OTP starts per phone per window (OTP_START_RATE_PER_PHONE, default 5) */
  otpStartRatePerPhone: number;
  /** Rate-limit window in milliseconds (OTP_START_RATE_WINDOW_MS, default 3600000) */
  otpStartRateWindowMs: number;
}

/**
 * Load and return the service configuration from environment variables.
 * Throws an Error with a clear message if any required variable is absent.
 *
 * @returns Validated Config object
 * @throws Error when a required environment variable is missing
 */
export function getConfig(): Config {
  const portStr = process.env.PORT;
  const databaseUrl = process.env.DATABASE_URL;
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioVerifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

  if (!portStr) {
    throw new Error(
      'auth-service: required environment variable PORT is not set'
    );
  }

  if (!databaseUrl) {
    throw new Error(
      'auth-service: required environment variable DATABASE_URL is not set'
    );
  }

  if (!twilioAccountSid) {
    throw new Error(
      'auth-service: required environment variable TWILIO_ACCOUNT_SID is not set'
    );
  }

  if (!twilioAuthToken) {
    throw new Error(
      'auth-service: required environment variable TWILIO_AUTH_TOKEN is not set'
    );
  }

  if (!twilioVerifyServiceSid) {
    throw new Error(
      'auth-service: required environment variable TWILIO_VERIFY_SERVICE_SID is not set'
    );
  }

  const port = parseInt(portStr, 10);
  const otpStartRatePerPhone = process.env.OTP_START_RATE_PER_PHONE
    ? parseInt(process.env.OTP_START_RATE_PER_PHONE, 10)
    : 5;
  const otpStartRateWindowMs = process.env.OTP_START_RATE_WINDOW_MS
    ? parseInt(process.env.OTP_START_RATE_WINDOW_MS, 10)
    : 3600000;

  return {
    port,
    databaseUrl,
    twilioAccountSid,
    twilioAuthToken,
    twilioVerifyServiceSid,
    otpStartRatePerPhone,
    otpStartRateWindowMs,
  };
}
