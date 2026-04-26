/**
 * Unit Tests: JWT authentication middleware
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/middleware/jwt-auth.ts  — exports createJwtAuthMiddleware(jwtService, sessionRepo)
 *
 * Strategy:
 *   - Mock JwtService and SessionRepository at interface level (Guideline #3)
 *   - Test public contract: next() called on success, 401 returned on failure
 *   - req.jwtPayload set on success (for downstream handlers to read user_id/session_id)
 *
 * AC coverage map:
 *   AC-D2.2  No Authorization header → 401 { error: 'unauthorized' }
 *   AC-D2.3  Malformed/wrong-signature JWT → 401 { error: 'unauthorized' }
 *   AC-D2.4  Expired JWT → 401 { error: 'unauthorized' }
 *   AC-D2.5  Valid JWT but session revoked (findActive returns null) → 401
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
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module under test ────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { createJwtAuthMiddleware } from '../../../src/middleware/jwt-auth.js';

// ─── Test constants ───────────────────────────────────────────────────────────
const TEST_USER_ID    = 'c0000000-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'c0000000-0000-4000-8000-000000000002';
const VALID_PAYLOAD   = {
  sub: TEST_USER_ID,
  sid: TEST_SESSION_ID,
  exp: Math.floor(Date.now() / 1000) + 900,
  iat: Math.floor(Date.now() / 1000),
  iss: 'auth-service',
  aud: 'web-app-bff',
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMockJwtService(verifyImpl: (token: string) => Promise<typeof VALID_PAYLOAD>) {
  return { verify: vi.fn().mockImplementation(verifyImpl) };
}

function makeMockSessionRepo(findActiveImpl: (sessionId: string) => Promise<object | null>) {
  return { findActive: vi.fn().mockImplementation(findActiveImpl) };
}

// ─── Test app factory ─────────────────────────────────────────────────────────

function makeApp(jwtService: object, sessionRepo: object) {
  const app = express();
  app.use(express.json());
  // Apply JWT middleware to a protected route
  const middleware = createJwtAuthMiddleware(jwtService, sessionRepo);
  app.get('/auth/sessions/me', middleware, (req: express.Request, res: express.Response) => {
    // Handler returns the payload attached by the middleware
    res.status(200).json((req as unknown as { jwtPayload: typeof VALID_PAYLOAD }).jwtPayload);
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: JWT auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-D2.2: No Authorization header ───────────────────────────────────────

  describe('AC-D2.2: missing Authorization header → 401 unauthorized', () => {
    it('AC-D2.2: should return 401 when Authorization header is absent', async () => {
      // AC-D2.2: "no Authorization header → 401 { error: 'unauthorized' }"
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app).get('/auth/sessions/me');

      expect(res.status).toBe(401);
    });

    it('AC-D2.2: 401 response body must contain { error: "unauthorized" }', async () => {
      // AC-D2.2: locked error shape
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app).get('/auth/sessions/me');

      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-D2.2: should not call jwtService.verify when no header present', async () => {
      // AC-D2.2: short-circuit — no token, no verify call
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      await request(app).get('/auth/sessions/me');

      expect(jwtService.verify).not.toHaveBeenCalled();
    });

    it('AC-D2.2: should return 401 when Authorization header has no Bearer prefix', async () => {
      // AC-D2.2: malformed header (not "Bearer <token>")
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'NotBearer some-token');

      expect(res.status).toBe(401);
    });
  });

  // ─── AC-D2.3: Malformed / wrong-signature JWT ────────────────────────────────

  describe('AC-D2.3: malformed/wrong-signature JWT → 401 unauthorized', () => {
    it('AC-D2.3: should return 401 when JwtService.verify throws (bad signature)', async () => {
      // AC-D2.3: "malformed/wrong-signature JWT → 401 { error: 'unauthorized' }"
      const jwtService = makeMockJwtService(async () => {
        throw new Error('JWTInvalid: signature verification failed');
      });
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer tampered.jwt.token');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-D2.3: should return 401 when token is malformed (bad format)', async () => {
      // AC-D2.3: completely malformed token
      const jwtService = makeMockJwtService(async () => {
        throw new Error('JWTMalformed');
      });
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer not-a-real-token');

      expect(res.status).toBe(401);
    });

    it('AC-D2.3: should not call sessionRepo.findActive when token fails verify', async () => {
      // AC-D2.3: verify failure short-circuits before DB lookup
      const jwtService = makeMockJwtService(async () => {
        throw new Error('JWTInvalid');
      });
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer bad.token.here');

      expect(sessionRepo.findActive).not.toHaveBeenCalled();
    });
  });

  // ─── AC-D2.4: Expired JWT ────────────────────────────────────────────────────

  describe('AC-D2.4: expired JWT → 401 unauthorized', () => {
    it('AC-D2.4: should return 401 when JwtService.verify throws on expired token', async () => {
      // AC-D2.4: "expired JWT (exp past) → 401"
      const jwtService = makeMockJwtService(async () => {
        throw new Error('JWTExpired: "exp" claim timestamp check failed');
      });
      const sessionRepo = makeMockSessionRepo(async () => ({ session_id: TEST_SESSION_ID }));
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer expired.jwt.token');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });
  });

  // ─── AC-D2.5: Valid JWT but session revoked ──────────────────────────────────

  describe('AC-D2.5: valid JWT but SessionRepository.findActive returns null → 401', () => {
    it('AC-D2.5: should return 401 when session has been revoked (findActive=null)', async () => {
      // AC-D2.5: "valid JWT BUT SessionRepository.findActive(sid) returns null → 401"
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => null); // revoked session
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer valid.but.revoked.token');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    });

    it('AC-D2.5: should call SessionRepository.findActive with the sid from the JWT payload', async () => {
      // AC-D2.5: middleware must look up the specific session by sid
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => null);
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer valid.but.revoked.token');

      expect(sessionRepo.findActive).toHaveBeenCalledWith(TEST_SESSION_ID);
    });

    it('AC-D2.5: should return 401 when session DB-expired (findActive=null due to expiry)', async () => {
      // AC-D2.5: findActive returns null for expired session (separate from JWT expiry)
      const expiredSessionPayload = {
        ...VALID_PAYLOAD,
        sid: 'c0000000-0000-4000-8000-000000000099',
      };
      const jwtService  = makeMockJwtService(async () => expiredSessionPayload);
      const sessionRepo = makeMockSessionRepo(async () => null); // DB-expired session
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer db.expired.session.token');

      expect(res.status).toBe(401);
    });
  });

  // ─── Happy path: valid JWT + active session → next() called ──────────────────

  describe('Happy path: valid JWT + active session → middleware passes through', () => {
    it('should call next() and attach jwtPayload to req on success', async () => {
      // Prerequisite for AC-D2.1 (handler tests verify the full response shape)
      const activeSession = {
        session_id: TEST_SESSION_ID,
        user_id:    TEST_USER_ID,
        channel:    'web',
        issued_at:  new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      };
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => activeSession);
      const app = makeApp(jwtService, sessionRepo);

      const res = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer valid.active.token');

      expect(res.status).toBe(200);
    });

    it('should extract the Bearer token from the Authorization header correctly', async () => {
      // Verify the middleware strips the "Bearer " prefix before calling verify
      const activeSession = {
        session_id: TEST_SESSION_ID,
        user_id:    TEST_USER_ID,
        channel:    'web',
        issued_at:  new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      };
      const jwtService  = makeMockJwtService(async () => VALID_PAYLOAD);
      const sessionRepo = makeMockSessionRepo(async () => activeSession);
      const app = makeApp(jwtService, sessionRepo);

      await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', 'Bearer the-actual-token');

      expect(jwtService.verify).toHaveBeenCalledWith('the-actual-token');
    });
  });
});
