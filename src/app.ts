/**
 * Express application factory for auth-service
 *
 * createApp(pool) creates the Express app, mounts routes, and returns it
 * WITHOUT calling .listen() — enabling testability (tests call .listen() directly).
 *
 * ADR references:
 *   ADR-008 — Health check endpoint
 *   ADR-014 — TDD / testable app factory pattern
 *   CLAUDE.md §8 — Mandatory shared package usage
 *
 * AC-WIRE.1 (AUTH-002): SessionRepository is constructed here with the injected pool
 *   and exposed via app.locals.sessionRepository for route handlers to consume.
 *
 * AUTH-003: OTP routes added. TwilioVerifyService + IdentityService + OtpService are
 *   constructed here when TWILIO_* env vars are available. If env vars are absent
 *   (e.g. unit-test wiring assertions), OTP routes are not mounted. In production and
 *   integration tests all vars are required (enforced by getConfig() at startServer time).
 *
 * AUTH-004: Sessions routes added (me, refresh, revoke). JwtService constructed when
 *   JWT_SECRET is set. Sessions router mounted when JWT_SECRET is present (mirrors
 *   TWILIO_* conditional pattern from AUTH-003).
 */

import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { getLogger } from './lib/logger.js';
import { SessionRepository } from './repositories/session.repository.js';
import { TwilioVerifyService } from './twilio/twilio-verify.service.js';
import { IdentityService } from './services/identity.service.js';
import { OtpService } from './services/otp.service.js';
import { createOtpRouter } from './routes/otp.js';
import { JwtService } from './jwt/jwt.service.js';
import { createSessionsRouter } from './routes/sessions.js';

/**
 * Create and configure the auth-service Express application.
 *
 * Reads TWILIO_* directly from process.env (no getConfig() call) so that
 * the wiring tests (which only set PORT/DATABASE_URL) can call createApp()
 * without triggering a TWILIO validation failure. The OTP router is only
 * mounted when all three TWILIO vars are present. In startServer() (index.ts),
 * getConfig() is called first which enforces the throw-on-missing contract.
 *
 * @param pool - PostgreSQL connection pool (injected for testability)
 * @returns Configured Express application (not yet listening)
 */
export function createApp(pool: Pool): Express {
  const app = express();
  const logger = getLogger();

  // AC-WIRE.1 (AUTH-002): wire SessionRepository on app.locals for route handlers
  const sessionRepository = new SessionRepository(pool as unknown as import('@railrepay/postgres-client').Pool);
  app.locals.sessionRepository = sessionRepository;

  // Trust proxy headers — required for Railway/proxy environments (ADR note)
  app.set('trust proxy', true);

  // Standard middleware
  app.use(express.json());

  // Request logging middleware (ADR-002: structured logging)
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`, {
      component: 'auth-service/http',
      method: req.method,
      path: req.path,
    });
    next();
  });

  // Health check route (ADR-008)
  app.use('/health', createHealthRouter(pool));

  // Metrics route (ADR-006)
  app.use('/metrics', createMetricsRouter());

  // AUTH-004: Construct JwtService when JWT_SECRET is present.
  // createApp() reads JWT_SECRET directly so wiring tests without JWT vars can
  // still call createApp(). getConfig() (in startServer) enforces the throw-on-missing.
  const jwtSecretRaw = process.env.JWT_SECRET ?? '';
  let jwtService: JwtService | undefined;

  if (jwtSecretRaw && jwtSecretRaw.length >= 32) {
    jwtService = new JwtService({
      secret:   jwtSecretRaw,
      issuer:   process.env.JWT_ISSUER   ?? 'auth-service',
      audience: process.env.JWT_AUDIENCE ?? 'web-app-bff',
      ttlMs:    process.env.JWT_ACCESS_TTL_MS
        ? parseInt(process.env.JWT_ACCESS_TTL_MS, 10)
        : 900_000,
    });
  }

  // AUTH-003: OTP routes — only mounted when TWILIO_* env vars are present.
  // getConfig() (called in startServer) enforces the throw-on-missing contract
  // for the full service startup path. createApp() reads them directly here so
  // wiring/unit tests that don't set TWILIO vars can still call createApp().
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? '';
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? '';
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID ?? '';

  if (accountSid && authToken && verifyServiceSid) {
    const twilioVerifyService = new TwilioVerifyService(accountSid, authToken, verifyServiceSid);
    const identityService = new IdentityService(pool);
    const otpService = new OtpService({
      twilioVerifyService,
      identityService,
      sessionRepository,
      jwtService,
    });
    app.use('/auth', createOtpRouter(otpService));
  }

  // AUTH-004: Sessions routes — only mounted when JwtService is available.
  // Mirrors the TWILIO_* conditional pattern from AUTH-003.
  if (jwtService) {
    app.use('/auth/sessions', createSessionsRouter(jwtService, sessionRepository));
  }

  return app;
}
