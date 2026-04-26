/**
 * Unit Tests: GET /auth/sessions/me handler
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/handlers/me.handler.ts  — exports handleGetMe
 *
 * Strategy:
 *   - Test HTTP contract: handler reads req.jwtPayload (set by jwt-auth middleware)
 *     and returns 200 { user_id, session_id }
 *   - jwt-auth middleware is NOT re-tested here (see jwt-auth.test.ts for that)
 *   - Use a stub middleware that pre-populates req.jwtPayload
 *
 * AC coverage map:
 *   AC-D2.1  GET /auth/sessions/me with valid JWT returns 200 { user_id, session_id }
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
import { handleGetMe } from '../../../src/handlers/me.handler.js';

// ─── Test constants ───────────────────────────────────────────────────────────
const TEST_USER_ID    = 'd0000000-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'd0000000-0000-4000-8000-000000000002';

// ─── Test app factory ─────────────────────────────────────────────────────────
// Injects a pre-set jwtPayload onto req, bypassing the real middleware.

function makeApp(jwtPayload: { sub: string; sid: string }) {
  const app = express();
  app.use(express.json());

  // Stub middleware: simulate what createJwtAuthMiddleware does on success
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).jwtPayload = jwtPayload;
    next();
  });

  app.get('/auth/sessions/me', (req: Request, res: Response) => {
    handleGetMe(req, res);
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: GET /auth/sessions/me handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-D2.1: Happy path ─────────────────────────────────────────────────────

  describe('AC-D2.1: valid JWT → 200 { user_id, session_id }', () => {
    it('AC-D2.1: should return 200 when jwtPayload is present', async () => {
      // AC-D2.1: "returns 200 { user_id, session_id } when underlying session is active"
      const app = makeApp({ sub: TEST_USER_ID, sid: TEST_SESSION_ID });

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer mock-token-already-validated');

      expect(res.status).toBe(200);
    });

    it('AC-D2.1: response body has user_id equal to sub from jwtPayload', async () => {
      // AC-D2.1: handler maps sub → user_id in response
      const app = makeApp({ sub: TEST_USER_ID, sid: TEST_SESSION_ID });

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer mock-token');

      expect(res.body.user_id).toBe(TEST_USER_ID);
    });

    it('AC-D2.1: response body has session_id equal to sid from jwtPayload', async () => {
      // AC-D2.1: handler maps sid → session_id in response
      const app = makeApp({ sub: TEST_USER_ID, sid: TEST_SESSION_ID });

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer mock-token');

      expect(res.body.session_id).toBe(TEST_SESSION_ID);
    });

    it('AC-D2.1: response body shape is exactly { user_id, session_id }', async () => {
      // AC-D2.1: no extra fields leaked into response
      const app = makeApp({ sub: TEST_USER_ID, sid: TEST_SESSION_ID });

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer mock-token');

      expect(Object.keys(res.body).sort()).toEqual(['session_id', 'user_id']);
    });

    it('AC-D2.1: different user produces correct user_id in response', async () => {
      // Guideline #6: differentiating test data
      const differentUserId    = 'd0000000-0000-4000-8000-000000000010';
      const differentSessionId = 'd0000000-0000-4000-8000-000000000020';
      const app = makeApp({ sub: differentUserId, sid: differentSessionId });

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer different-user-token');

      expect(res.body.user_id).toBe(differentUserId);
      expect(res.body.session_id).toBe(differentSessionId);
    });
  });
});
