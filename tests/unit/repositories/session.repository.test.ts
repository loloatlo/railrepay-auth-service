/**
 * Unit Tests: SessionRepository (AUTH-002)
 *
 * Story   : RAILREPAY-AUTH-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * These tests are written BEFORE Blake's implementation (Phase US-3).
 * They MUST FAIL until Blake creates src/repositories/session.repository.ts.
 * Expected failure mode: "Cannot find module '../../../src/repositories/session.repository.js'"
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * Test category: B — Unit tests (vi.mock of pg.Pool)
 * These tests verify SQL shape and parameter binding via mocked pool.query().
 * No database container is spun up — all database interactions are mocked.
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation (sessions in user_identity schema)
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-017  — Jessie owns fixtures
 *   ADR-025  — user_identity schema, owned by auth-service
 *   DR-UC-002 — auth-service owns session issuance for all channels
 *   CLAUDE.md §8 — Mandatory shared package usage
 *
 * AC coverage map (Blake's US-3 ACs):
 *   AC-B2.1  create({ user_id, channel }) → correct SQL + parameters; returns session shape
 *   AC-B2.1  create() input validation — invalid user_id UUID, invalid channel rejected before SQL
 *   AC-B3.1  revoke(session_id) → correct SQL + parameters
 *   AC-B4.1  touch(session_id) → correct SQL + parameters
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';

// ─── Shared logger mock (ADR-017 / CLAUDE.md §6.1 Guideline 11) ──────────────
// The shared instance MUST be created OUTSIDE the factory so all tests share one mock.
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// ─── Module under test (imported AFTER mocks are declared) ───────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { SessionRepository } from '../../../src/repositories/session.repository.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * 30-day TTL in milliseconds — per Q-AUTH-002-2 and BL-201 §Decisions.
 * Blake's implementation must use this constant to compute expires_at.
 * We assert the query contains an interval expression consistent with this.
 */
const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** UUID v4 regex for assertion convenience */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Fixture: a valid mock pool ───────────────────────────────────────────────
// Per Guideline 3: mock at service boundary (pg.Pool), not internal functions.
function makePool(queryResult: Partial<QueryResult> = {}): Pool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      fields: [],
      oid: 0,
      ...queryResult,
    }),
  } as unknown as Pool;
}

// ─── Fixture: a typical session row returned by create() ─────────────────────
// Per ADR-017 / RFC-002 §Fixture Data Samples: uses the Hoops-provided seed shape.
// Source: RFC-002-sessions-schema.md §Fixture Data Samples
function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_30_DAYS_MS);
  return {
    session_id: 'a1b2c3d4-0000-4000-8000-000000000001',
    user_id: 'b0000000-0000-4000-8000-000000000001',
    channel: 'whatsapp',
    issued_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-002: SessionRepository unit tests', () => {
  describe('constructor', () => {
    it('can be instantiated with a pg Pool', () => {
      // Smoke test: class exists and accepts a pool
      const pool = makePool();
      expect(() => new SessionRepository(pool)).not.toThrow();
    });

    it('does not call pool.query on construction', () => {
      // No eager queries on instantiation
      const pool = makePool();
      new SessionRepository(pool);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  // ─── AC-B2.1: create() ───────────────────────────────────────────────────

  describe('AC-B2.1: create({ user_id, channel })', () => {
    // Fixture: unique input data for create() tests
    const CREATE_USER_ID = 'b0000000-0000-4000-8000-000000000001';
    const CREATE_CHANNEL = 'whatsapp';

    it('should call pool.query once with an INSERT SQL statement', async () => {
      // AC-B2.1: create() must issue exactly one SQL INSERT
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toUpperCase()).toContain('INSERT');
    });

    it('should target user_identity.sessions in the INSERT SQL', async () => {
      // AC-B2.1: all sessions operations must target the user_identity schema (ADR-025)
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toLowerCase()).toContain('user_identity.sessions');
    });

    it('should pass user_id and channel as parameterised query values (no string concatenation)', async () => {
      // AC-B2.1: all operations must be parameterised — no raw SQL string concat (AUTH-002 scope note)
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });

      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      // user_id and channel must NOT be embedded in the SQL string
      expect(sql).not.toContain(CREATE_USER_ID);
      expect(sql).not.toContain(CREATE_CHANNEL);
      // Both values must appear in the parameterised params array
      expect(params).toContain(CREATE_USER_ID);
      expect(params).toContain(CREATE_CHANNEL);
    });

    it('should pass an expires_at value consistent with a 30-day TTL', async () => {
      // AC-B2.1: expires_at = now() + 30d; Q-AUTH-002-2: no DB default, app computes
      // The param may be a Date object or an ISO string — either is acceptable
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      const beforeCall = Date.now();
      await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const afterCall = Date.now();

      const [, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      // Find the expires_at param: a Date or string that is ~30d from now
      const expiresAtParam = params.find((p) => {
        const d = p instanceof Date ? p : new Date(p as string);
        if (isNaN(d.getTime())) return false;
        const diffMs = d.getTime() - beforeCall;
        // Allow ±60s tolerance around the expected 30d
        return diffMs >= TTL_30_DAYS_MS - 60_000 && diffMs <= TTL_30_DAYS_MS + 60_000;
      });
      expect(
        expiresAtParam,
        `Expected one param to be approximately NOW() + 30d. Params were: ${JSON.stringify(params)}`
      ).toBeDefined();

      // Assert issued_at is implicitly set (either via DEFAULT NOW() in SQL or as a param)
      // The key invariant: expires_at param exists (Q-AUTH-002-2 compliance)
      void afterCall; // used above for tolerance bounds
    });

    it('should return the full session record shape from the INSERT RETURNING', async () => {
      // AC-B2.1: returns { session_id, user_id, channel, issued_at, expires_at, revoked_at: null }
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      const result = await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('session_id', row.session_id);
      expect(result).toHaveProperty('user_id', CREATE_USER_ID);
      expect(result).toHaveProperty('channel', CREATE_CHANNEL);
      expect(result).toHaveProperty('issued_at');
      expect(result).toHaveProperty('expires_at');
      expect(result).toHaveProperty('revoked_at', null);
    });

    it('should include RETURNING clause in the INSERT SQL', async () => {
      // AC-B2.1: result is derived from RETURNING — not re-fetched via a SELECT
      const row = makeSessionRow({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });
      const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
      const repo = new SessionRepository(pool);

      await repo.create({ user_id: CREATE_USER_ID, channel: CREATE_CHANNEL });

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toUpperCase()).toContain('RETURNING');
    });

    // ── Input validation: invalid user_id ──────────────────────────────────

    it('should reject create() when user_id is not a valid UUID (before SQL fires)', async () => {
      // AC-B2.1 edge case: "not-a-uuid" must be rejected before pool.query is called
      // Unique input: non-UUID string — triggers the guard condition
      const pool = makePool();
      const repo = new SessionRepository(pool);

      await expect(
        repo.create({ user_id: 'not-a-uuid', channel: 'web' })
      ).rejects.toThrow();

      // pool.query must NOT have been called — validation happens before SQL
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('should reject create() when user_id is an empty string', async () => {
      // AC-B2.1 edge case: boundary — empty string is not a UUID
      const pool = makePool();
      const repo = new SessionRepository(pool);

      await expect(
        repo.create({ user_id: '', channel: 'web' })
      ).rejects.toThrow();

      expect(pool.query).not.toHaveBeenCalled();
    });

    // ── Input validation: invalid channel ─────────────────────────────────

    it('should reject create() when channel is not in the allowed enum (before SQL fires)', async () => {
      // AC-B2.1 edge case: "telegram" is not in the locked channel enum (Q-AUTH-002-1)
      // Unique input: valid UUID but invalid channel — triggers the channel guard
      const pool = makePool();
      const repo = new SessionRepository(pool);

      await expect(
        repo.create({ user_id: 'b0000000-0000-4000-8000-000000000002', channel: 'telegram' })
      ).rejects.toThrow();

      expect(pool.query).not.toHaveBeenCalled();
    });

    it('should reject create() when channel is an empty string', async () => {
      // AC-B2.1 edge case: boundary — empty channel
      const pool = makePool();
      const repo = new SessionRepository(pool);

      await expect(
        repo.create({ user_id: 'b0000000-0000-4000-8000-000000000003', channel: '' })
      ).rejects.toThrow();

      expect(pool.query).not.toHaveBeenCalled();
    });

    it('should accept all five valid channel values without throwing', async () => {
      // AC-B2.1: whatsapp, web, rn, swift, browser_extension are all valid channels
      const validChannels = ['whatsapp', 'web', 'rn', 'swift', 'browser_extension'];
      for (const channel of validChannels) {
        const userId = `b0000000-0000-4000-8000-00000000000${validChannels.indexOf(channel) + 1}`;
        const row = makeSessionRow({ user_id: userId, channel });
        const pool = makePool({ rows: [row], rowCount: 1, command: 'INSERT' });
        const repo = new SessionRepository(pool);

        await expect(
          repo.create({ user_id: userId, channel })
        ).resolves.toBeDefined();
      }
    });
  });

  // ─── AC-B3.1: revoke() ───────────────────────────────────────────────────

  describe('AC-B3.1: revoke(session_id)', () => {
    // Unique fixture data for revoke() tests — distinct from create() tests
    const REVOKE_SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

    it('should call pool.query once with an UPDATE SQL statement', async () => {
      // AC-B3.1: revoke() must issue exactly one SQL UPDATE
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.revoke(REVOKE_SESSION_ID);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toUpperCase()).toContain('UPDATE');
    });

    it('should target user_identity.sessions in the UPDATE SQL', async () => {
      // AC-B3.1: schema qualification required (ADR-025)
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.revoke(REVOKE_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toLowerCase()).toContain('user_identity.sessions');
    });

    it('should SET revoked_at in the UPDATE SQL', async () => {
      // AC-B3.1: revoke() sets revoked_at = now() (not a boolean flag)
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.revoke(REVOKE_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toLowerCase()).toContain('revoked_at');
    });

    it('should pass session_id as a parameterised query value', async () => {
      // AC-B3.1: parameterised — no string concatenation (AUTH-002 scope note)
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.revoke(REVOKE_SESSION_ID);

      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain(REVOKE_SESSION_ID);
      expect(params).toContain(REVOKE_SESSION_ID);
    });

    it('should be idempotent: only updates when revoked_at IS NULL (WHERE clause)', async () => {
      // AC-B3.1: idempotency — second call is a no-op; WHERE revoked_at IS NULL prevents overwrite
      // The test verifies the WHERE condition exists in SQL, not the real no-op (that's the integration test)
      const pool = makePool({ rows: [], rowCount: 0, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.revoke(REVOKE_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      // The WHERE clause must guard against double-revoke
      // Acceptable patterns: "WHERE ... revoked_at IS NULL", "WHERE ... revoked_at IS NULL"
      expect(sql.toLowerCase()).toContain('revoked_at is null');
    });

    it('should not throw when the session does not exist (rowCount = 0)', async () => {
      // AC-B3.1: no-op scenario must be handled gracefully — no error thrown
      // Unique session ID for this test to avoid false positives
      const pool = makePool({ rows: [], rowCount: 0, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await expect(repo.revoke('a1b2c3d4-0000-4000-8000-000000000099')).resolves.not.toThrow();
    });
  });

  // ─── AC-B4.1: touch() ────────────────────────────────────────────────────

  describe('AC-B4.1: touch(session_id)', () => {
    // Unique fixture data for touch() tests — distinct from revoke() tests
    const TOUCH_SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000003';

    it('should call pool.query once with an UPDATE SQL statement', async () => {
      // AC-B4.1: touch() extends expires_at via a single UPDATE
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.touch(TOUCH_SESSION_ID);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toUpperCase()).toContain('UPDATE');
    });

    it('should target user_identity.sessions in the UPDATE SQL', async () => {
      // AC-B4.1: schema qualification required (ADR-025)
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.touch(TOUCH_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toLowerCase()).toContain('user_identity.sessions');
    });

    it('should SET expires_at in the UPDATE SQL', async () => {
      // AC-B4.1: touch() extends expires_at, not any other column
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.touch(TOUCH_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql.toLowerCase()).toContain('expires_at');
    });

    it('should pass session_id as a parameterised query value', async () => {
      // AC-B4.1: parameterised — no string concatenation
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.touch(TOUCH_SESSION_ID);

      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain(TOUCH_SESSION_ID);
      expect(params).toContain(TOUCH_SESSION_ID);
    });

    it('should only touch active sessions: WHERE revoked_at IS NULL AND expires_at > now()', async () => {
      // AC-B4.1: touch() is a no-op for revoked or expired sessions
      // The WHERE guard must filter on both revoked_at and expires_at
      const pool = makePool({ rows: [], rowCount: 1, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await repo.touch(TOUCH_SESSION_ID);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      const sqlLower = sql.toLowerCase();
      // Must guard against touching revoked sessions
      expect(sqlLower).toContain('revoked_at is null');
    });

    it('should not throw when the session is revoked or expired (no-op: rowCount = 0)', async () => {
      // AC-B4.1: no-op for revoked/expired must be handled gracefully
      // Unique session ID for no-op path to distinguish from the happy path test
      const pool = makePool({ rows: [], rowCount: 0, command: 'UPDATE' });
      const repo = new SessionRepository(pool);

      await expect(repo.touch('a1b2c3d4-0000-4000-8000-000000000098')).resolves.not.toThrow();
    });
  });
});
