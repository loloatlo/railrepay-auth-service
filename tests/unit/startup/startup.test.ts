/**
 * Unit Tests: auth-service startup behaviour
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/index.ts and src/config/index.ts.
 * Failure reason: "Cannot find module '../../../src/config/index.js'"
 *
 * AC coverage map:
 *   AC-A1  src/index.ts exists — tested via import of config/index.ts which it consumes
 *   AC-A1  Service starts on PORT env var.
 *   AC-A1  Service logs "auth-service started" via @railrepay/winston-logger on successful
 *          startup (logger spy assertion).
 *   AC-A1  Service refuses to start (exits non-zero) when critical env vars missing:
 *          DATABASE_URL, PORT.
 *          CHOICE RECORDED FOR BLAKE: Per whatsapp-handler/src/index.ts convention,
 *          the service calls process.exit(1) from within a top-level catch block when
 *          getConfig() throws on missing required env vars. Blake must implement
 *          getConfig() to throw an Error when PORT or DATABASE_URL is absent.
 *
 * Graceful shutdown scope decision (flagged for Quinn):
 *   SIGTERM graceful-shutdown tests are INCLUDED in this file (tests/unit/startup/startup.test.ts)
 *   because whatsapp-handler tests the shutdown handler and auth-service is a direct mirror.
 *   If Docker or Railway routing make SIGTERM tests flaky in CI, Blake should flag to Jessie
 *   at Phase US-4 and the tests will be moved to a POST-BETA TD item.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs (winston-logger)
 *   ADR-014 — TDD: tests written before implementation
 *   CLAUDE.md §8 — Mandatory @railrepay/* shared package usage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

// ─── Shared logger mock (Guideline #11 — SAME instance across all tests) ────
//
// Blake must implement src/lib/logger.ts that re-exports createLogger() from
// @railrepay/winston-logger (per whatsapp-handler pattern).
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { getConfig } from '../../../src/config/index.js';

describe('RAILREPAY-AUTH-001: startup behaviour (unit)', () => {
  const SERVICE_ROOT = resolve(process.cwd());

  // ─── AC-A1: src/index.ts exists ──────────────────────────────────────────

  describe('AC-A1: src/index.ts file existence', () => {
    it('AC-A1: src/index.ts must exist after Blake implements Phase US-3', () => {
      // AC-A1: "services/auth-service/src/index.ts exists"
      // This test FAILS in TDD RED phase — src/index.ts does not exist yet.
      const indexPath = resolve(SERVICE_ROOT, 'src', 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
    });
  });

  // ─── AC-A1: PORT env var ─────────────────────────────────────────────────

  describe('AC-A1: getConfig() — PORT env var handling', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      // Restore env vars
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      });
      Object.assign(process.env, originalEnv);
      vi.clearAllMocks();
    });

    it('AC-A1: getConfig() should return port from PORT env var', () => {
      // AC-A1: service starts on PORT env var — getConfig() must read it
      process.env.PORT = '3001';
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

      const config = getConfig();

      expect(config.port).toBe(3001);
    });

    it('AC-A1: getConfig() should throw when PORT is missing', () => {
      // AC-A1 + CHOICE FOR BLAKE: exit non-zero on missing critical env var.
      // getConfig() throws an Error when PORT is absent, and src/index.ts
      // catches that error and calls process.exit(1) — mirrors whatsapp-handler.
      delete process.env.PORT;
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

      expect(() => getConfig()).toThrow();
    });

    it('AC-A1: getConfig() should throw when DATABASE_URL is missing', () => {
      // AC-A1: DATABASE_URL is a critical env var — service must not start without it.
      process.env.PORT = '3001';
      delete process.env.DATABASE_URL;

      expect(() => getConfig()).toThrow();
    });

    it('AC-A1: getConfig() should return databaseUrl from DATABASE_URL env var', () => {
      // AC-A1: configuration must surface DATABASE_URL to the pg connection
      process.env.PORT = '3001';
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/authdb';

      const config = getConfig();

      expect(config.databaseUrl).toBe('postgresql://user:pass@localhost:5432/authdb');
    });
  });

  // ─── AC-A1: "auth-service started" log via @railrepay/winston-logger ─────

  describe('AC-A1: startup log message via @railrepay/winston-logger', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('AC-A1: should log "auth-service started" using winston-logger on successful boot', async () => {
      // AC-A1: "logs 'auth-service started' via @railrepay/winston-logger"
      //
      // This test verifies the behaviour by importing the startup function
      // exported from src/index.ts. Blake should export a `startServer()` function
      // (or equivalent) that is callable in tests without actually binding a port.
      //
      // Fallback: Blake may export a `createApp()` factory instead.
      // If so, the test will be updated by Jessie per Test Lock Rule.
      //
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { startServer } = await import('../../../src/index.js');

      process.env.PORT = '0'; // ephemeral port — does not bind in unit tests
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

      // Mock pool to avoid real DB connection
      await startServer({ skipDbConnect: true });

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('auth-service started'),
        expect.any(Object)
      );
    });
  });

  // ─── AC-A1: Graceful shutdown (SIGTERM) ──────────────────────────────────

  describe('AC-A1: Graceful shutdown on SIGTERM', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should export a shutdown function that closes HTTP server and DB pool', async () => {
      // Graceful shutdown is IN SCOPE per whatsapp-handler convention.
      // Blake must export a `shutdown()` function (or equivalent) from src/index.ts
      // that: (1) closes the HTTP server, (2) ends the DB pool.
      //
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const indexModule = await import('../../../src/index.js');

      // The shutdown function must be exported for testability
      expect(typeof indexModule.shutdown).toBe('function');
    });

    it('should log shutdown signal received on SIGTERM via winston-logger', async () => {
      // AC-A1: logger is used during shutdown — not console.log
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { shutdown } = await import('../../../src/index.js');

      const mockServer = { close: vi.fn((cb?: () => void) => cb && cb()) };
      const mockPool = { end: vi.fn().mockResolvedValue(undefined) };

      await shutdown('SIGTERM', mockServer as any, mockPool as any);

      expect(sharedLogger.info).toHaveBeenCalledWith(
        expect.stringMatching(/shutdown|SIGTERM/i),
        expect.any(Object)
      );
    });

    it('should call server.close() during graceful shutdown', async () => {
      // Graceful shutdown must stop accepting new HTTP connections
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { shutdown } = await import('../../../src/index.js');

      const closeFn = vi.fn((cb?: () => void) => cb && cb());
      const mockServer = { close: closeFn };
      const mockPool = { end: vi.fn().mockResolvedValue(undefined) };

      await shutdown('SIGTERM', mockServer as any, mockPool as any);

      expect(closeFn).toHaveBeenCalled();
    });

    it('should call pool.end() during graceful shutdown', async () => {
      // Graceful shutdown must release DB connections
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { shutdown } = await import('../../../src/index.js');

      const endFn = vi.fn().mockResolvedValue(undefined);
      const mockServer = { close: vi.fn((cb?: () => void) => cb && cb()) };
      const mockPool = { end: endFn };

      await shutdown('SIGTERM', mockServer as any, mockPool as any);

      expect(endFn).toHaveBeenCalled();
    });
  });
});
