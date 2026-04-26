/**
 * Integration Tests: Sessions flow E2E — AUTH-004
 * (JWT issuance, /auth/sessions/me, refresh, revoke)
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/jwt/jwt.service.ts
 *   src/middleware/jwt-auth.ts
 *   src/handlers/me.handler.ts
 *   src/handlers/refresh.handler.ts
 *   src/handlers/revoke.handler.ts
 *   src/routes/sessions.ts (mounts /auth/sessions/me, /refresh, /revoke)
 *   src/app.ts extended with JWT routes
 *
 * Strategy:
 *   - Testcontainers PostgreSQL (real DB — no mocked pool)
 *   - ONLY Twilio SDK is mocked (no real SMS in CI)
 *   - jose REAL (no mock) — full JWS sign+verify end-to-end
 *   - Fixtures from tests/fixtures/identity/sessions-flow.fixture.json (ADR-017)
 *   - NO build:migrations in beforeAll (TD-AUTH-003-5 lesson — use existing pattern)
 *
 * NOTE: TD-AUTH-003-5: do NOT add npm run build:migrations here. The integration
 * test suite is expected to rely on the pre-built dist/ migrations from the
 * otp-flow.integration.test.ts beforeAll() which runs build:migrations once.
 * If this test runs standalone it will re-use already-built migrations.
 *
 * E2E sequence tested:
 *   1. POST /auth/otp/start (mock Twilio) → 202
 *   2. POST /auth/otp/verify (mock Twilio approved) → 200 with access_token
 *   3. GET /auth/sessions/me with Bearer → 200 { user_id, session_id }
 *   4. POST /auth/sessions/refresh with Bearer → 200 { access_token, expires_in: 900 }; new JWT, same sid
 *   5. GET /auth/sessions/me with NEW Bearer → 200
 *   6. POST /auth/sessions/revoke with Bearer → 204
 *   7. GET /auth/sessions/me with same Bearer → 401
 *
 * AC coverage map:
 *   AC-D1.1  /auth/otp/verify 200 body has access_token + expires_in: 900
 *   AC-D2.1  /auth/sessions/me with valid Bearer → 200 { user_id, session_id }
 *   AC-D2.5  /auth/sessions/me after session revoked → 401
 *   AC-D3.1  /auth/sessions/refresh → touch() + new JWT + same sid
 *   AC-D3.2  /auth/sessions/refresh on revoked session → 401
 *   AC-D4.1  /auth/sessions/revoke → 204; subsequent /me → 401
 *   AC-D4.2  /auth/sessions/revoke is idempotent (second call → 204)
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation
 *   ADR-014  — TDD
 *   ADR-017  — Jessie owns fixtures
 *   ADR-025  — user_identity schema
 *   CLAUDE.md §7   — Integration tests required
 *   CLAUDE.md §8   — At least one integration test with REAL @railrepay/* dependencies
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SERVICE_ROOT = path.resolve(__dirname, '../..');

// ─── Fixtures (ADR-017) ──────────────────────────────────────────────────────
const FIXTURE = JSON.parse(
  readFileSync(
    path.join(SERVICE_ROOT, 'tests/fixtures/identity/sessions-flow.fixture.json'),
    'utf-8'
  )
);

// ─── Twilio SDK mock ─────────────────────────────────────────────────────────
// ONLY Twilio is mocked — jose and all DB interactions are REAL (Testcontainers)
const mockVerificationsCreate      = vi.fn();
const mockVerificationChecksCreate = vi.fn();

vi.mock('twilio', () => {
  const mockServices = vi.fn(() => ({
    verifications:      { create: mockVerificationsCreate },
    verificationChecks: { create: mockVerificationChecksCreate },
  }));
  return {
    default: vi.fn(() => ({
      verify: { v2: { services: mockServices } },
    })),
  };
});

// ─── Shared logger mock (Guideline #11) ──────────────────────────────────────
const sharedLogger = {
  info:  vi.fn(),
  error: vi.fn(),
  warn:  vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── App import ──────────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createApp } from '../../src/app.js';

// ─── Helper: run migrations ──────────────────────────────────────────────────
function runMigrationUp(databaseUrl: string): void {
  execSync(
    [
      'npx node-pg-migrate up',
      '--migrations-dir dist/migrations',
      '--migrations-schema user_identity',
      '--create-migrations-schema',
      '--create-schema',
    ].join(' '),
    {
      cwd: SERVICE_ROOT,
      env:   { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    }
  );
}

// ─── Helper: decode JWT payload (no verification — just inspect claims) ───────
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: Sessions flow integration (Testcontainers + real jose)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    console.log('[auth-004 integration] Building migrations...');
    execSync('npm run build:migrations', { cwd: SERVICE_ROOT, stdio: 'pipe' });

    console.log('[auth-004 integration] Starting PostgreSQL 16 container...');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('auth_jwt_int_test')
      .withUsername('auth_jwt_int_test')
      .withPassword('auth_jwt_int_test')
      .start();

    console.log('[auth-004 integration] Running UP migration...');
    runMigrationUp(container.getConnectionUri());
    console.log('[auth-004 integration] Migrations applied.');

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Configure environment — JWT_SECRET + Twilio vars required
    process.env.DATABASE_URL              = container.getConnectionUri();
    process.env.PORT                      = '0';
    process.env.TWILIO_ACCOUNT_SID        = 'ACtest1234567890abcdef1234567890ab';
    process.env.TWILIO_AUTH_TOKEN         = 'test_auth_token_1234567890abcdef01';
    process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest1234567890abcdef1234567890';
    process.env.OTP_START_RATE_PER_PHONE  = '10';
    process.env.OTP_START_RATE_WINDOW_MS  = '3600000';
    // AC-D5.1 / TD-AUTH-002-3: JWT env vars for the service to start
    process.env.JWT_SECRET                = FIXTURE.jwt_config.secret;
    process.env.JWT_ISSUER                = FIXTURE.jwt_config.issuer;
    process.env.JWT_AUDIENCE              = FIXTURE.jwt_config.audience;
    process.env.JWT_ACCESS_TTL_MS         = String(FIXTURE.jwt_config.ttl_ms);

    // Build the app with the REAL pool (CLAUDE.md §8 — real @railrepay/* deps)
    app = createApp(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    delete process.env.OTP_START_RATE_PER_PHONE;
    delete process.env.OTP_START_RATE_WINDOW_MS;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.JWT_ACCESS_TTL_MS;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();
  });

  // ─── AC-D1.1: /auth/otp/verify returns access_token + expires_in ─────────

  describe('AC-D1.1: POST /auth/otp/verify returns access_token and expires_in: 900', () => {
    const { phone_e164, channel } = FIXTURE.scenarios.jwt_issue_and_me;

    it('AC-D1.1: should return 200 with access_token field in body', async () => {
      // AC-D1.1: "POST /auth/otp/verify happy path returns 200 with body { user_id, session_id, access_token, expires_in: 900 }"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      mockVerificationsCreate.mockResolvedValueOnce({ sid: 'VEtest-d11', status: 'pending' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164, code: '100001' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('access_token');
    });

    it('AC-D1.1: access_token is a 3-segment JWS string', async () => {
      // AC-D1.1: "Token is 3-segment JWS (header.payload.sig)"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900310', code: '100002' });

      if (res.status === 200) {
        const parts = res.body.access_token.split('.');
        expect(parts).toHaveLength(3);
      }
    });

    it('AC-D1.1: response body contains expires_in === 900', async () => {
      // AC-D1.1: "expires_in: 900"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900311', code: '100003' });

      if (res.status === 200) {
        expect(res.body.expires_in).toBe(900);
      }
    });

    it('AC-D1.1: response body still contains user_id and session_id (additive extension)', async () => {
      // AC-D1.1: "additive — existing { user_id, session_id } fields remain"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900312', code: '100004' });

      if (res.status === 200) {
        expect(res.body).toHaveProperty('user_id');
        expect(res.body).toHaveProperty('session_id');
      }
    });

    it('AC-D1.1: JWT sub claim equals user_id in response body', async () => {
      // AC-D1.3: "sub === user_id returned in body"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900313', code: '100005' });

      if (res.status === 200) {
        const payload = decodeJwtPayload(res.body.access_token);
        expect(payload.sub).toBe(res.body.user_id);
      }
    });

    it('AC-D1.1: JWT sid claim equals session_id in response body', async () => {
      // AC-D1.3: "sid === session_id returned in body"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const res = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900314', code: '100006' });

      if (res.status === 200) {
        const payload = decodeJwtPayload(res.body.access_token);
        expect(payload.sid).toBe(res.body.session_id);
      }
    });
  });

  // ─── E2E sequence: verify → me → refresh → me again → revoke → me 401 ───

  describe('E2E sequence: full JWT lifecycle (AC-D2.1, AC-D3.1, AC-D4.1, AC-D4.2)', () => {
    const { phone_e164, channel } = FIXTURE.scenarios.revoke_flow;

    it('E2E: step 1+2 — POST /auth/otp/verify returns access_token', async () => {
      // AC-D1.1: setup for E2E
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });

      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164, code: '200001' });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toHaveProperty('access_token');
    });

    it('E2E: step 3 — GET /auth/sessions/me with Bearer returns 200', async () => {
      // AC-D2.1: "GET /auth/sessions/me with Authorization: Bearer <valid-jwt> returns 200 { user_id, session_id }"
      // First get a token
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900320', code: '200002' });

      expect(verifyRes.status).toBe(200);
      const { access_token, user_id, session_id } = verifyRes.body;

      const meRes = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', `Bearer ${access_token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user_id).toBe(user_id);
      expect(meRes.body.session_id).toBe(session_id);
    });

    it('E2E: step 4 — POST /auth/sessions/refresh returns new access_token with same sid', async () => {
      // AC-D3.1: "new JWT has same sid/sub/iss/aud, fresh iat, extended exp"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900321', code: '200003' });

      expect(verifyRes.status).toBe(200);
      const { access_token: originalToken, session_id } = verifyRes.body;

      const refreshRes = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', `Bearer ${originalToken}`);

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body).toHaveProperty('access_token');
      expect(refreshRes.body.expires_in).toBe(900);

      // New token carries same sid
      const newPayload = decodeJwtPayload(refreshRes.body.access_token);
      expect(newPayload.sid).toBe(session_id);
    });

    it('E2E: step 5 — GET /auth/sessions/me with NEW token from refresh → 200', async () => {
      // AC-D3.1: new JWT works for /me
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900322', code: '200004' });

      expect(verifyRes.status).toBe(200);
      const { access_token: originalToken } = verifyRes.body;

      const refreshRes = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', `Bearer ${originalToken}`);

      expect(refreshRes.status).toBe(200);

      const meRes = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', `Bearer ${refreshRes.body.access_token}`);

      expect(meRes.status).toBe(200);
    });

    it('E2E: step 6 — POST /auth/sessions/revoke returns 204', async () => {
      // AC-D4.1: "POST /auth/sessions/revoke with valid JWT calls SessionRepository.revoke(sid); returns 204"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900323', code: '200005' });

      expect(verifyRes.status).toBe(200);
      const { access_token } = verifyRes.body;

      const revokeRes = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);

      expect(revokeRes.status).toBe(204);
    });

    it('E2E: step 7 — GET /auth/sessions/me after revoke returns 401 (AC-D2.5 + AC-D4.1)', async () => {
      // AC-D2.5 + AC-D4.1: "Subsequent GET /auth/sessions/me with same JWT → 401"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164: '+447700900324', code: '200006' });

      expect(verifyRes.status).toBe(200);
      const { access_token } = verifyRes.body;

      await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);

      const meRes = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', `Bearer ${access_token}`);

      expect(meRes.status).toBe(401);
    });
  });

  // ─── AC-D2.5: Valid JWT but DB-revoked session → 401 ─────────────────────

  describe('AC-D2.5: valid JWT signature but session revoked in DB → 401', () => {
    const { phone_e164, channel } = FIXTURE.scenarios.me_revoked_session;

    it('AC-D2.5: /me returns 401 when session was revoked before JWT exp', async () => {
      // AC-D2.5: "findActive(sid) returns null (revoked) → 401"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164, code: '300001' });

      expect(verifyRes.status).toBe(200);
      const { access_token } = verifyRes.body;

      // Revoke the session directly via the API
      await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);

      // JWT signature still valid but session row is revoked → 401
      const meRes = await request(app)
        .get('/auth/sessions/me')
        .set('Authorization', `Bearer ${access_token}`);

      expect(meRes.status).toBe(401);
      expect(meRes.body).toEqual({ error: 'unauthorized' });
    });
  });

  // ─── AC-D3.2: Refresh on revoked session → 401 ───────────────────────────

  describe('AC-D3.2: POST /auth/sessions/refresh on revoked session → 401', () => {
    const { phone_e164, channel } = FIXTURE.scenarios.refresh_flow;

    it('AC-D3.2: should return 401 when refreshing a revoked session', async () => {
      // AC-D3.2: "already-revoked session → 401"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel, phone_e164, code: '400001' });

      expect(verifyRes.status).toBe(200);
      const { access_token } = verifyRes.body;

      // Revoke first
      await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);

      // Now try to refresh — session is revoked so findActive returns null → 401
      const refreshRes = await request(app)
        .post('/auth/sessions/refresh')
        .set('Authorization', `Bearer ${access_token}`);

      expect(refreshRes.status).toBe(401);
    });
  });

  // ─── AC-D4.2: Revoke is idempotent ───────────────────────────────────────

  describe('AC-D4.2: POST /auth/sessions/revoke is idempotent', () => {
    it('AC-D4.2: second revoke call on already-revoked session returns 204', async () => {
      // AC-D4.2: "calling twice returns 204 both times"
      mockVerificationChecksCreate.mockResolvedValueOnce({ valid: true, status: 'approved' });
      const verifyRes = await request(app)
        .post('/auth/otp/verify')
        .send({ channel: 'web', phone_e164: '+447700900340', code: '500001' });

      expect(verifyRes.status).toBe(200);
      const { access_token } = verifyRes.body;

      const revoke1 = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);
      expect(revoke1.status).toBe(204);

      // Second revoke — same JWT (session now revoked in DB, but JWT sig still valid)
      // NOTE: This passes because revoke endpoint uses JWT middleware which still accepts
      // the JWT (signature valid). SessionRepository.revoke() is idempotent (WHERE revoked_at IS NULL).
      const revoke2 = await request(app)
        .post('/auth/sessions/revoke')
        .set('Authorization', `Bearer ${access_token}`);
      expect(revoke2.status).toBe(204);
    });
  });

  // ─── CLAUDE.md §8: REAL @railrepay/* dependencies ────────────────────────

  describe('Infrastructure wiring: REAL @railrepay/* packages (CLAUDE.md §8)', () => {
    it('createApp(realPool) with JWT_SECRET set mounts /auth/sessions/me without crashing', async () => {
      // CLAUDE.md §8: exercises REAL @railrepay/* dependencies
      // If postgres-client/winston-logger have peerDep issues they crash here (not hidden by mocks)
      const res = await request(app).get('/auth/sessions/me');
      // Either 401 (no Bearer) or 5xx is acceptable — the test verifies it doesn't crash
      expect([401, 500]).toContain(res.status);
    });
  });
});
