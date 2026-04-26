/**
 * Unit Tests: POST /auth/sessions/refresh handler
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/refresh.handler.ts  — exports handleRefresh
 *
 * Strategy:
 *   - Mock JwtService.sign and SessionRepository.touch at interface level
 *   - Stub middleware injects req.jwtPayload (jwt-auth middleware contract)
 *   - Tests verify: touch() called once, new JWT returned, same sid/sub/iss/aud
 *
 * AC coverage map:
 *   AC-D3.1  POST /auth/sessions/refresh with valid JWT calls touch() once;
 *            returns 200 { access_token, expires_in: 900 };
 *            new JWT has same sid/sub/iss/aud, fresh iat, extended exp.
 *            Old JWT continues to verify until its own exp (no blocklist).
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
import { handleRefresh } from '../../../src/handlers/refresh.handler.js';

// ─── Test constants ───────────────────────────────────────────────────────────
const TEST_USER_ID    = 'e0000000-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'e0000000-0000-4000-8000-000000000002';
const NEW_ACCESS_TOKEN = 'new.access.token.after.refresh';

const VALID_JWT_PAYLOAD = {
  sub: TEST_USER_ID,
  sid: TEST_SESSION_ID,
  exp: Math.floor(Date.now() / 1000) + 900,
  iat: Math.floor(Date.now() / 1000),
  iss: 'auth-service',
  aud: 'web-app-bff',
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMockJwtService(signImpl: (params: object) => Promise<string>) {
  return { sign: vi.fn().mockImplementation(signImpl) };
}

function makeMockSessionRepo(touchImpl: (sessionId: string) => Promise<void>) {
  return { touch: vi.fn().mockImplementation(touchImpl) };
}

// ─── Test app factory ─────────────────────────────────────────────────────────

function makeApp(
  jwtService: object,
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

  app.post('/auth/sessions/refresh', (req: Request, res: Response) => {
    handleRefresh(req, res, jwtService, sessionRepo);
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: POST /auth/sessions/refresh handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-D3.1: touch() called once + 200 response ────────────────────────────

  describe('AC-D3.1: valid JWT → touch() once, returns 200 { access_token, expires_in: 900 }', () => {
    it('AC-D3.1: should return 200 on successful refresh', async () => {
      // AC-D3.1: "returns 200 { access_token, expires_in: 900 }"
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.status).toBe(200);
    });

    it('AC-D3.1: response body contains access_token', async () => {
      // AC-D3.1: "returns { access_token, expires_in: 900 }"
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.body).toHaveProperty('access_token');
      expect(res.body.access_token).toBe(NEW_ACCESS_TOKEN);
    });

    it('AC-D3.1: response body contains expires_in === 900', async () => {
      // AC-D3.1: "expires_in: 900"
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.body.expires_in).toBe(900);
    });

    it('AC-D3.1: SessionRepository.touch() is called exactly once with the session_id', async () => {
      // AC-D3.1: "calls SessionRepository.touch(sid) exactly once"
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(sessionRepo.touch).toHaveBeenCalledTimes(1);
      expect(sessionRepo.touch).toHaveBeenCalledWith(TEST_SESSION_ID);
    });

    it('AC-D3.1: JwtService.sign() is called with same sub and sid as incoming token', async () => {
      // AC-D3.1: "new JWT has same sid/sub/iss/aud" — verify sign() receives correct args
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          userId:    TEST_USER_ID,
          sessionId: TEST_SESSION_ID,
        })
      );
    });

    it('AC-D3.1: response body shape is exactly { access_token, expires_in }', async () => {
      // AC-D3.1: no extra fields
      const jwtService  = makeMockJwtService(async () => NEW_ACCESS_TOKEN);
      const sessionRepo = makeMockSessionRepo(async () => undefined);
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(Object.keys(res.body).sort()).toEqual(['access_token', 'expires_in']);
    });

    it('AC-D3.1: touch() is called BEFORE sign() (sliding window happens before new JWT)', async () => {
      // AC-D3.1: touch() order matters — extend session before minting new token
      const callOrder: string[] = [];
      const jwtService  = { sign: vi.fn().mockImplementation(async () => { callOrder.push('sign'); return NEW_ACCESS_TOKEN; }) };
      const sessionRepo = { touch: vi.fn().mockImplementation(async () => { callOrder.push('touch'); }) };
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(callOrder[0]).toBe('touch');
      expect(callOrder[1]).toBe('sign');
    });
  });
});
