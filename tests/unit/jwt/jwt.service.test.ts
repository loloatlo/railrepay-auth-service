/**
 * Unit Tests: JwtService — JWT sign/verify
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-26
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/jwt/jwt.service.ts  — exports JwtService (or equivalent)
 *
 * Strategy:
 *   - vi.useFakeTimers() for all exp/iat assertions (TD-AUTH-003-3 lesson)
 *   - vi.mock('jose', ...) for sign/verify error paths
 *   - Real jose used for happy-path sign+verify to verify the algorithm contract
 *
 * AC coverage map:
 *   AC-D1.2  JWT decoded payload contains EXACTLY { sub, sid, exp, iat, iss, aud }
 *   AC-D1.3  sub === user_id; sid === session_id; iss/aud from config
 *   AC-D1.4  exp - iat === JWT_ACCESS_TTL_MS / 1000; iat within 1s of server clock
 *   AC-D2.3  Malformed/wrong-signature JWT → throws (verify fails)
 *   AC-D2.4  Expired JWT (exp past) → throws (verify fails)
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §6.1 Guideline #11 — Infrastructure package mocking patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { JwtService } from '../../../src/jwt/jwt.service.js';

// ─── Test constants ───────────────────────────────────────────────────────────
// Deterministic 32-byte secret: 64 hex chars. NOT a production secret.
const TEST_JWT_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_USER_ID    = 'b0000000-0000-4000-8000-000000000001';
const TEST_SESSION_ID = 'b0000000-0000-4000-8000-000000000002';
const TEST_ISSUER     = 'auth-service';
const TEST_AUDIENCE   = 'web-app-bff';
const TEST_TTL_MS     = 900_000; // 15 min

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-004: JwtService', () => {
  let svc: InstanceType<typeof JwtService>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    svc = new JwtService({
      secret:   TEST_JWT_SECRET,
      issuer:   TEST_ISSUER,
      audience: TEST_AUDIENCE,
      ttlMs:    TEST_TTL_MS,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── AC-D1.2: Claim shape — EXACTLY { sub, sid, exp, iat, iss, aud } ────────

  describe('AC-D1.2: JWT payload claims are exactly { sub, sid, exp, iat, iss, aud }', () => {
    it('AC-D1.2: signed token decodes to a payload with exactly 6 keys', async () => {
      // AC-D1.2: "Object.keys(payload).sort() equality"
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);

      expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    });

    it('AC-D1.2: payload must not contain phone, email, name, or roles', async () => {
      // AC-D1.2: NO PII — hard assertion
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);

      expect(payload).not.toHaveProperty('phone');
      expect(payload).not.toHaveProperty('email');
      expect(payload).not.toHaveProperty('name');
      expect(payload).not.toHaveProperty('roles');
    });

    it('AC-D1.2: payload has no extra unknown keys beyond the 6 locked claims', async () => {
      // AC-D1.2: "no other key" — verify exhaustively
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);

      const allowedKeys = new Set(['sub', 'sid', 'exp', 'iat', 'iss', 'aud']);
      const actualKeys = Object.keys(payload);
      for (const key of actualKeys) {
        expect(allowedKeys.has(key), `unexpected claim: ${key}`).toBe(true);
      }
    });
  });

  // ─── AC-D1.3: Claim values ───────────────────────────────────────────────────

  describe('AC-D1.3: sub === user_id; sid === session_id; iss and aud from config', () => {
    it('AC-D1.3: sub claim equals the user_id passed to sign()', async () => {
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(payload.sub).toBe(TEST_USER_ID);
    });

    it('AC-D1.3: sid claim equals the session_id passed to sign()', async () => {
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(payload.sid).toBe(TEST_SESSION_ID);
    });

    it('AC-D1.3: iss claim equals the issuer from config', async () => {
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(payload.iss).toBe(TEST_ISSUER);
    });

    it('AC-D1.3: aud claim equals the audience from config', async () => {
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      // jose returns aud as string when single audience
      const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      expect(aud).toBe(TEST_AUDIENCE);
    });

    it('AC-D1.3: different user_id produces different sub claim', async () => {
      // Guideline #6: differentiating test data
      const token1 = await svc.sign({ userId: 'b0000000-0000-4000-8000-000000000010', sessionId: TEST_SESSION_ID });
      const token2 = await svc.sign({ userId: 'b0000000-0000-4000-8000-000000000011', sessionId: TEST_SESSION_ID });
      const p1 = await svc.verify(token1);
      const p2 = await svc.verify(token2);
      expect(p1.sub).not.toBe(p2.sub);
    });
  });

  // ─── AC-D1.4: exp − iat === TTL_MS / 1000 ───────────────────────────────────

  describe('AC-D1.4: exp - iat === JWT_ACCESS_TTL_MS / 1000 (900s); iat within 1s of server clock', () => {
    it('AC-D1.4: exp minus iat equals exactly 900 seconds', async () => {
      // AC-D1.4: "exp - iat === JWT_ACCESS_TTL_MS / 1000 (15 min default = 900s)"
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(payload.exp - payload.iat).toBe(900);
    });

    it('AC-D1.4: iat equals the current server time (fake timer, within 1s)', async () => {
      // AC-D1.4: "iat within 1 s of server clock at issue" — fake timer pins this exactly
      const nowSeconds = Math.floor(new Date('2026-04-26T12:00:00.000Z').getTime() / 1000);
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(Math.abs(payload.iat - nowSeconds)).toBeLessThanOrEqual(1);
    });

    it('AC-D1.4: exp equals iat + 900 (absolute value)', async () => {
      const nowSeconds = Math.floor(new Date('2026-04-26T12:00:00.000Z').getTime() / 1000);
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const payload = await svc.verify(token);
      expect(payload.exp).toBe(nowSeconds + 900);
    });

    it('AC-D1.4: token is signed as 3-segment JWS (header.payload.signature)', async () => {
      // AC-D1.1: "Token is 3-segment JWS (header.payload.sig)"
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });
  });

  // ─── AC-D2.3: Malformed / wrong-signature JWT ────────────────────────────────

  describe('AC-D2.3: malformed or wrong-signature JWT → verify() throws', () => {
    it('AC-D2.3: verify() throws on a completely malformed token string', async () => {
      // AC-D2.3: "malformed/wrong-signature JWT → 401"
      await expect(svc.verify('not.a.jwt')).rejects.toThrow();
    });

    it('AC-D2.3: verify() throws on a token with tampered payload', async () => {
      // AC-D2.3: signature mismatch after payload mutation
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      const [header, , sig] = token.split('.');
      // Produce a different (invalid) payload segment by base64url-encoding a different JSON
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'hacker', sid: 'fake', exp: 9999999999, iat: 0, iss: TEST_ISSUER, aud: TEST_AUDIENCE })).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;
      await expect(svc.verify(tamperedToken)).rejects.toThrow();
    });

    it('AC-D2.3: verify() throws on a token signed with a different secret', async () => {
      // AC-D2.3: wrong-signature token
      const differentSecret = '0000000000000000000000000000000000000000000000000000000000000000';
      const svcDifferentSecret = new JwtService({
        secret:   differentSecret,
        issuer:   TEST_ISSUER,
        audience: TEST_AUDIENCE,
        ttlMs:    TEST_TTL_MS,
      });
      const tokenFromOtherSecret = await svcDifferentSecret.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      // Verifying with TEST_JWT_SECRET should fail
      await expect(svc.verify(tokenFromOtherSecret)).rejects.toThrow();
    });

    it('AC-D2.3: verify() throws on an empty string', async () => {
      await expect(svc.verify('')).rejects.toThrow();
    });
  });

  // ─── AC-D2.4: Expired JWT ────────────────────────────────────────────────────

  describe('AC-D2.4: expired JWT → verify() throws', () => {
    it('AC-D2.4: verify() throws when token exp is in the past', async () => {
      // AC-D2.4: "expired JWT (exp past) → 401"
      // Sign with fake timer at T=0, then advance time past TTL
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      // Advance fake timer by TTL + 60s so exp is definitely past
      vi.advanceTimersByTime(TEST_TTL_MS + 60_000);
      await expect(svc.verify(token)).rejects.toThrow();
    });

    it('AC-D2.4: verify() succeeds when token is not yet expired', async () => {
      // AC-D2.4: baseline — verify within TTL passes
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      // Advance only 1 minute — still within 15-min TTL
      vi.advanceTimersByTime(60_000);
      await expect(svc.verify(token)).resolves.toBeDefined();
    });

    it('AC-D2.4: verify() throws exactly at exp boundary (1s after exp)', async () => {
      // AC-D2.4: boundary — 1s after exp is past
      const token = await svc.sign({ userId: TEST_USER_ID, sessionId: TEST_SESSION_ID });
      vi.advanceTimersByTime(TEST_TTL_MS + 1_000);
      await expect(svc.verify(token)).rejects.toThrow();
    });
  });
});
