/**
 * Unit Tests: auth-service /health endpoint
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/routes/health.ts.
 * Failure reason: "Cannot find module '../../../src/routes/health.js'"
 *
 * AC coverage map:
 *   AC-A2  /health returns 200 with { status:'ok', schema:'user_identity', migrations:'up-to-date' }
 *          when DB is reachable and latest migration is applied.
 *   AC-A2  /health returns non-200 (503) when DB is unreachable.
 *   AC-A2  /health queries user_identity.pgmigrations to confirm migration status.
 *
 * ADR references:
 *   ADR-008 — Health check endpoint contract
 *   ADR-014 — TDD: tests written before implementation
 *   ADR-025 — Schema name is user_identity (not auth_service)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createHealthRouter } from '../../../src/routes/health.js';

// ─── Shared logger mock (ADR-002 / CLAUDE.md §8 infrastructure package mock pattern) ─────────
//
// The shared logger mock instance is created OUTSIDE the factory so all tests get
// the SAME mock object — required by Guideline #11 in jessie-qa-tdd-enforcer.md.
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

describe('RAILREPAY-AUTH-001: /health route (unit)', () => {
  // ─── AC-A2: Response shape when DB healthy ──────────────────────────────────

  describe('AC-A2: GET /health — DB reachable, migration applied', () => {
    let mockPool: { query: ReturnType<typeof vi.fn> };
    let mockReq: { method: string; path: string };
    let mockRes: {
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      // Mock pool: SELECT 1 succeeds AND pgmigrations query returns one row
      // (one applied migration — the user_identity bootstrap migration from IDP-001)
      mockPool = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT 1')) {
            return Promise.resolve({ rows: [{ result: 1 }] });
          }
          if (sql.includes('pgmigrations')) {
            // Simulate one applied migration row from user_identity.pgmigrations
            return Promise.resolve({
              rows: [
                {
                  id: 1,
                  name: '1745539200000_create-user-identity-schema',
                  run_on: new Date('2026-04-25T00:00:00.000Z'),
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };

      mockReq = { method: 'GET', path: '/health' };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('AC-A2: should return HTTP 200', async () => {
      // AC-A2: locked response contract — status 200 when healthy
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('AC-A2: should return body with status "ok"', async () => {
      // AC-A2: locked response shape — status field must be "ok"
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ok' })
      );
    });

    it('AC-A2: should return body with schema "user_identity"', async () => {
      // AC-A2: locked response shape — schema field must be "user_identity" (ADR-025)
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ schema: 'user_identity' })
      );
    });

    it('AC-A2: should return body with migrations "up-to-date"', async () => {
      // AC-A2: locked response shape — migrations field must be "up-to-date" when
      // at least one row is present in user_identity.pgmigrations
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ migrations: 'up-to-date' })
      );
    });

    it('AC-A2: should return the complete locked response body shape', async () => {
      // AC-A2: full response shape must match exactly what the spec locks
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.json).toHaveBeenCalledWith({
        status: 'ok',
        schema: 'user_identity',
        migrations: 'up-to-date',
      });
    });

    it('AC-A2: should query user_identity.pgmigrations to confirm migration status', async () => {
      // AC-A2: /health MUST query pgmigrations — not just ping the DB.
      // This distinguishes "DB reachable" from "migrations applied".
      const router = createHealthRouter(mockPool);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      // At least one call must reference pgmigrations (schema-qualified)
      const calls = (mockPool.query as ReturnType<typeof vi.fn>).mock.calls;
      const pgmigrationsQuery = calls.find(
        (args: [string, ...unknown[]]) =>
          typeof args[0] === 'string' && args[0].includes('pgmigrations')
      );
      expect(pgmigrationsQuery).toBeDefined();
    });
  });

  // ─── AC-A2: Response when DB unreachable ─────────────────────────────────

  describe('AC-A2: GET /health — DB unreachable', () => {
    let mockPoolDown: { query: ReturnType<typeof vi.fn> };
    let mockRes: {
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      // Mock pool that rejects all queries — simulates DB down
      mockPoolDown = {
        query: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };

      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('AC-A2: should return HTTP 503 when DB connection fails', async () => {
      // AC-A2: non-200 on unhealthy — test scenarios from AUTH-001 Notion page.
      // Choice: 503 (Service Unavailable) aligns with whatsapp-handler /health convention.
      const router = createHealthRouter(mockPoolDown);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!({ method: 'GET', path: '/health' }, mockRes, vi.fn());

      expect(mockRes.status).toHaveBeenCalledWith(503);
    });

    it('AC-A2: should return status "error" in body when DB unreachable', async () => {
      // AC-A2: body must signal failure — status is not "ok" when unhealthy
      const router = createHealthRouter(mockPoolDown);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!({ method: 'GET', path: '/health' }, mockRes, vi.fn());

      const jsonCall = (mockRes.json as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(jsonCall).toBeDefined();
      const body = jsonCall[0];
      expect(body.status).not.toBe('ok');
    });
  });

  // ─── AC-A2: Migration not applied (pgmigrations empty) ───────────────────

  describe('AC-A2: GET /health — migration table empty (migration NOT applied)', () => {
    let mockPoolNoMigrations: { query: ReturnType<typeof vi.fn> };
    let mockRes: {
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      // Pool: SELECT 1 succeeds but pgmigrations returns zero rows
      mockPoolNoMigrations = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT 1')) {
            return Promise.resolve({ rows: [{ result: 1 }] });
          }
          if (sql.includes('pgmigrations')) {
            // Empty pgmigrations — no migrations have been applied
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
      };

      mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('AC-A2: should return non-200 when pgmigrations table is empty', async () => {
      // AC-A2: "confirms the latest migration is applied" — empty pgmigrations means
      // migration NOT run, so health check must fail.
      const router = createHealthRouter(mockPoolNoMigrations);
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!({ method: 'GET', path: '/health' }, mockRes, vi.fn());

      const statusCall = (mockRes.status as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(statusCall).toBeDefined();
      const statusCode: number = statusCall[0];
      expect(statusCode).not.toBe(200);
    });
  });
});
