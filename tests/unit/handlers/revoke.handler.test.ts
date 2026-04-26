/**
 * Unit Tests: POST /auth/sessions/revoke handler
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/revoke.handler.ts  — exports handleRevoke
 *
 * Strategy:
 *   - Mock SessionRepository.revoke at interface level
 *   - Stub middleware injects req.jwtPayload (jwt-auth middleware contract)
 *   - Tests verify: revoke() called with correct sid, 204 returned
 *
 * AC coverage map:
 *   AC-D4.1  POST /auth/sessions/revoke with valid JWT calls SessionRepository.revoke(sid);
 *            returns 204.
 *
 * Note: AC-D4.2 (idempotent) and the revoke→me→401 sequence are tested in the
 *       integration test (sessions-flow.integration.test.ts).
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §6.1 Guideline #11 — Infrastructure package mocking patterns
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// ─── Shared logger mock (Guideline #11) ──────────────────────────────────────
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module under test ────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { handleRevoke } from '../../../src/handlers/revoke.handler.js';

// ─── Test constants ───────────────────────────────────────────────────────────
const TEST_USER_ID    = 'f0000001-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'f0000001-0000-4000-8000-000000000002';

const VALID_JWT_PAYLOAD = {
  sub: TEST_USER_ID,
  sid: TEST_SESSION_ID,
  exp: Math.floor(Date.now() / 1000) + 900,
  iat: Math.floor(Date.now() / 1000),
  iss: 'auth-service',
  aud: 'web-app-bff',
};

// ─── Mock factory ─────────────────────────────────────────────────────────────

function makeMockSessionRepo(revokeImpl: (sessionId: string) => Promise<void>) {
  return { revoke: vi.fn().mockImplementation(revokeImpl) };
}

// ─── Test app factory ─────────────────────────────────────────────────────────

function makeApp(
  sessionRepo: object,
  jwtPayload: typeof VALID_JWT_PAYLOAD = VALID_JWT_PAYLOAD
) {
  const app = express();
  app.use(express.json());

  // Stub: simulate createJwtAuthMiddleware success
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).jwtPayload = jwtPayload;
    next();
  });

  app.post('/auth/sessions/revoke', (req: Request, res: Response) => {
    handleRevoke(req, res, sessionRepo);
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: POST /auth/sessions/revoke handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-D4.1: revoke() called + 204 ─────────────────────────────────────────

  describe('AC-D4.1: valid JWT → revoke() called, returns 204', () => {
    it('AC-D4.1: should return 204 on successful revoke', async () => {
      // AC-D4.1: "calls SessionRepository.revoke(sid); returns 204"
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.status).toBe(204);
    });

    it('AC-D4.1: response body is empty for 204', async () => {
      // AC-D4.1: 204 No Content — no body
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.text).toBe('');
    });

    it('AC-D4.1: SessionRepository.revoke() is called exactly once with the session_id', async () => {
      // AC-D4.1: "calls SessionRepository.revoke(sid)"
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(sessionRepo);

      await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(sessionRepo.revoke).toHaveBeenCalledTimes(1);
      expect(sessionRepo.revoke).toHaveBeenCalledWith(TEST_SESSION_ID);
    });

    it('AC-D4.1: different session produces different revoke() call argument', async () => {
      // Guideline #6: differentiating test data
      const differentSessionId = 'f0000001-0000-4000-8000-000000000099';
      const differentPayload = { ...VALID_JWT_PAYLOAD, sid: differentSessionId };
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(sessionRepo, differentPayload);

      await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer different.session.token');

      expect(sessionRepo.revoke).toHaveBeenCalledWith(differentSessionId);
    });

    it('AC-D4.1: handler still returns 204 even if revoke() is a no-op (idempotency at repo level)', async () => {
      // AC-D4.2: idempotent — second revoke call still returns 204
      // (Repo-level idempotency tested in session.repository tests; here we verify handler 204)
      const sessionRepo = makeMockSessionRepo(async () => undefined); // always succeeds
      const app = makeApp(sessionRepo);

      const res1 = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer valid.jwt.token');
      const res2 = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res1.status).toBe(204);
      expect(res2.status).toBe(204);
    });
  });
});
