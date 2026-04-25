/**
 * Unit Tests: auth-service shared package usage (infrastructure wiring)
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 *
 * These tests MUST FAIL until Blake creates src/.
 * Failure mode: existsSync returns false / getSrcFiles returns [] / import fails.
 *
 * Purpose:
 *   CLAUDE.md §8 mandates that every service MUST USE (not just install) shared packages.
 *   Lesson learned from metrics-pusher@1.0.0 crash (evaluation-coordinator TD pattern):
 *   all tests mocked the dependency → missing peerDep not caught until Railway deploy.
 *
 * AC coverage map:
 *   AC-A1  @railrepay/winston-logger is imported in src/ (not console.log).
 *   AC-A2  @railrepay/postgres-client is imported in src/ (not raw pg.Pool).
 *   AC-A3  @railrepay/metrics-pusher is imported in src/ (not prom-client directly).
 *   All    Behavioral: logger instance has standard winston methods.
 *   All    Behavioral: @railrepay/* packages are installed (package.json check).
 *   All    No raw pg.Pool instantiation in src/ outside test files.
 *   All    No console.log/error/warn in src/ (must use winston-logger).
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

// Project root for path resolution
const SERVICE_ROOT = resolve(process.cwd());

// ─── Helper: collect all .ts source files from src/ ─────────────────────────
// Returns [] if src/ does not exist yet (TDD RED phase expected).
function getSrcFiles(): string[] {
  try {
    const srcDir = join(SERVICE_ROOT, 'src');
    const files: string[] = [];

    function traverse(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.d.ts')
        ) {
          files.push(fullPath);
        }
      }
    }

    traverse(srcDir);
    return files;
  } catch {
    // src/ does not exist yet — expected in TDD RED phase
    return [];
  }
}

describe('RAILREPAY-AUTH-001: infrastructure wiring — shared package usage', () => {
  // ─── Package installation (package.json) ─────────────────────────────────

  describe('Package installation check (package.json)', () => {
    const pkgPath = join(SERVICE_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    it('AC-A1: @railrepay/winston-logger is listed in dependencies', () => {
      // AC-A1: mandatory shared package must be a declared dependency
      expect(pkg.dependencies['@railrepay/winston-logger']).toBeDefined();
    });

    it('AC-A2: @railrepay/postgres-client is listed in dependencies', () => {
      // AC-A2: mandatory shared package must be a declared dependency
      expect(pkg.dependencies['@railrepay/postgres-client']).toBeDefined();
    });

    it('AC-A3: @railrepay/metrics-pusher is listed in dependencies', () => {
      // AC-A3: mandatory shared package must be a declared dependency
      expect(pkg.dependencies['@railrepay/metrics-pusher']).toBeDefined();
    });
  });

  // ─── AC-A1: @railrepay/winston-logger imported in src/ ───────────────────

  describe('AC-A1: @railrepay/winston-logger usage in src/', () => {
    it('AC-A1: at least one src/ file imports @railrepay/winston-logger', () => {
      // Verifies: CLAUDE.md §8 "not just install" requirement
      // FAILS in TDD RED phase — src/ does not exist yet
      const srcFiles = getSrcFiles();

      // getSrcFiles() returning [] means src/ doesn't exist — this assertion fails
      expect(srcFiles.length).toBeGreaterThan(0);

      const combinedSource = srcFiles
        .map((f) => readFileSync(f, 'utf-8'))
        .join('\n');
      expect(combinedSource).toContain('@railrepay/winston-logger');
    });

    it('AC-A1: no console.log calls in src/ (must use winston-logger)', () => {
      // AC-A1: logger-first rule — console.log is forbidden in application code
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      for (const file of srcFiles) {
        const content = readFileSync(file, 'utf-8');
        // Strip comment lines before checking
        const codeLines = content
          .split('\n')
          .filter(
            (line) =>
              !line.trim().startsWith('//') && !line.trim().startsWith('*')
          )
          .join('\n');

        expect(codeLines).not.toContain('console.log');
      }
    });

    it('AC-A1: no console.error calls in src/ (must use winston-logger)', () => {
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      for (const file of srcFiles) {
        const content = readFileSync(file, 'utf-8');
        const codeLines = content
          .split('\n')
          .filter(
            (line) =>
              !line.trim().startsWith('//') && !line.trim().startsWith('*')
          )
          .join('\n');

        expect(codeLines).not.toContain('console.error');
      }
    });

    it('AC-A1: @railrepay/winston-logger createLogger() returns instance with standard winston methods', async () => {
      // Behavioral test — verifies the shared package is wired correctly at runtime.
      // FAILS in TDD RED phase — src/lib/logger.ts does not exist yet.

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const loggerModule = await import('../../../src/lib/logger.js');
      const logger = loggerModule.getLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('AC-A1: logger supports child() method for correlation ID propagation (ADR-002)', async () => {
      // ADR-002: all logs must include correlation IDs — child() enables per-request context
      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const loggerModule = await import('../../../src/lib/logger.js');
      const logger = loggerModule.getLogger();

      expect(typeof logger.child).toBe('function');
    });
  });

  // ─── AC-A2: @railrepay/postgres-client imported in src/ ──────────────────

  describe('AC-A2: @railrepay/postgres-client usage in src/', () => {
    it('AC-A2: at least one src/ file imports @railrepay/postgres-client', () => {
      // Verifies: CLAUDE.md §8 "not just install" requirement
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      const hasPostgresClientImport = srcFiles.some((file) =>
        readFileSync(file, 'utf-8').includes('@railrepay/postgres-client')
      );
      expect(hasPostgresClientImport).toBe(true);
    });

    it('AC-A2: no raw "new Pool(" instantiation in src/ files (must use postgres-client)', () => {
      // Raw pg.Pool bypasses the shared client — forbidden per CLAUDE.md §8
      // Testcontainers usage in integration tests is OK (they live in tests/, not src/)
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      const hasRawPool = srcFiles.some((file) =>
        readFileSync(file, 'utf-8').includes('new Pool(')
      );
      expect(hasRawPool).toBe(false);
    });
  });

  // ─── AC-A3: @railrepay/metrics-pusher imported in src/ ───────────────────

  describe('AC-A3: @railrepay/metrics-pusher usage in src/', () => {
    it('AC-A3: at least one src/ file imports @railrepay/metrics-pusher', () => {
      // Verifies: CLAUDE.md §8 "not just install" requirement
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      const hasMetricsPusherImport = srcFiles.some((file) =>
        readFileSync(file, 'utf-8').includes('@railrepay/metrics-pusher')
      );
      expect(hasMetricsPusherImport).toBe(true);
    });

    it('AC-A3: no direct prom-client import in src/ (must use metrics-pusher wrapper)', () => {
      // Metrics-pusher wraps prom-client — importing prom-client directly bypasses the wrapper
      const srcFiles = getSrcFiles();
      expect(srcFiles.length).toBeGreaterThan(0);

      const hasDirectPromClient = srcFiles.some((file) => {
        const content = readFileSync(file, 'utf-8');
        return (
          content.includes("from 'prom-client'") ||
          content.includes('require(\'prom-client\')')
        );
      });
      expect(hasDirectPromClient).toBe(false);
    });
  });

  // ─── Smoke: src/ directory exists ────────────────────────────────────────

  describe('src/ directory existence (gates all other assertions)', () => {
    it('src/ directory must exist after Blake implements Phase US-3', () => {
      // This is the first domino — if src/ is missing, all import-based tests
      // also fail. This test provides a clear diagnostic message.
      const srcDir = join(SERVICE_ROOT, 'src');
      expect(existsSync(srcDir)).toBe(true);
    });

    it('src/index.ts must exist (AC-A1)', () => {
      const indexPath = join(SERVICE_ROOT, 'src', 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
    });
  });
});
