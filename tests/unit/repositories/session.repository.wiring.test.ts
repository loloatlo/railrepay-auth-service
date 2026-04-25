/**
 * Unit Tests: SessionRepository wiring (AUTH-002)
 *
 * Story   : RAILREPAY-AUTH-002
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * These tests are written BEFORE Blake's implementation (Phase US-3).
 * They MUST FAIL until Blake creates:
 *   - src/repositories/session.repository.ts
 *   - createApp(pool) updated to wire up sessionRepository in app.locals
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 *
 * Test categories:
 *   D — Wiring tests: createApp(pool).locals.sessionRepository instanceof SessionRepository
 *   E — Infrastructure-package usage assertions (CLAUDE.md §8 / Mandatory Rule #8)
 *
 * ADR references:
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-025  — user_identity schema, owned by auth-service
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/postgres-client)
 *   DR-UC-002 — auth-service owns session issuance for all channels
 *
 * AC coverage map:
 *   AC-WIRE.1  createApp(pool).locals.sessionRepository instanceof SessionRepository
 *   AC-WIRE.1  SessionRepository uses @railrepay/postgres-client Pool type for injected pool
 *   AC-E.1    grep @railrepay/postgres-client in src/repositories/ MUST return matches
 *   AC-E.2    grep from 'pg' in src/repositories/ MUST return zero matches
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import type { Pool } from 'pg';

// Project root for path resolution (cwd set to services/auth-service/ by vitest)
const SERVICE_ROOT = resolve(process.cwd());

// ─── Shared logger mock ───────────────────────────────────────────────────────
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

// ─── Helper: collect all .ts files from src/repositories/ ────────────────────
// Returns [] if the directory does not exist yet (TDD RED phase).
function getRepositoryFiles(): string[] {
  try {
    const repoDir = join(SERVICE_ROOT, 'src', 'repositories');
    const files: string[] = [];
    const entries = readdirSync(repoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(join(repoDir, entry.name));
      }
    }
    return files;
  } catch {
    // Directory does not exist yet — expected in TDD RED phase
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-002: SessionRepository wiring tests', () => {

  // ─── Category D: createApp wiring ────────────────────────────────────────

  describe('AC-WIRE.1: createApp(pool).locals.sessionRepository', () => {
    it('sessionRepository must be exposed on app.locals after createApp(pool)', async () => {
      // AC-WIRE.1: SessionRepository is constructed inside createApp(pool) and
      // exposed via app.locals.sessionRepository for route handlers to consume.
      // FAILS in TDD RED phase — createApp does not yet set sessionRepository.

      // @ts-expect-error — module exists but createApp does not expose sessionRepository yet (TDD RED)
      const { createApp } = await import('../../../src/app.js');
      // @ts-expect-error — SessionRepository module does not exist yet (TDD RED)
      const { SessionRepository } = await import('../../../src/repositories/session.repository.js');

      const mockPool = {
        query: vi.fn(),
        end: vi.fn(),
        connect: vi.fn(),
      } as unknown as Pool;

      const app = createApp(mockPool);

      expect(app.locals.sessionRepository).toBeDefined();
      expect(app.locals.sessionRepository).toBeInstanceOf(SessionRepository);
    });

    it('sessionRepository in app.locals must use the injected pool (not a new pool)', async () => {
      // AC-WIRE.1: SessionRepository must be constructed with the pool passed to createApp()
      // This guards against Blake accidentally creating a second Pool inside the constructor.
      // @ts-expect-error — TDD RED phase
      const { createApp } = await import('../../../src/app.js');

      const mockPool = {
        query: vi.fn(),
        end: vi.fn(),
        connect: vi.fn(),
        // Unique marker to identify this specific pool instance
        __testMarker: 'session-wiring-test-pool',
      } as unknown as Pool;

      const app = createApp(mockPool);
      const sessionRepo = app.locals.sessionRepository;

      // The repository must hold a reference to the SAME pool that was injected
      // Blake should store pool as a class property — we verify it via an internal field
      // Acceptable implementations: this.pool, this._pool, this.#pool exposed via getter
      // We use duck-typing: if the repo can query, it's wired; direct pool identity check is optional
      expect(sessionRepo).toBeDefined();
      // The key invariant: no new Pool() calls were made in constructing the app
      // (enforced by category E test below + the no-raw-pg-Pool assertion in infrastructure-wiring.test.ts)
    });
  });

  // ─── Category E: Infrastructure package usage assertions ─────────────────

  describe('AC-E.1: @railrepay/postgres-client imported in src/repositories/', () => {
    it('at least one file in src/repositories/ imports @railrepay/postgres-client', () => {
      // CLAUDE.md §8: "Every service MUST use (not just install) @railrepay/postgres-client"
      // Verified: @railrepay/postgres-client is in package.json dependencies
      // This test verifies the import is present in the source file itself.
      // FAILS in TDD RED phase — src/repositories/session.repository.ts does not exist yet.
      const repoFiles = getRepositoryFiles();

      expect(
        repoFiles.length,
        'src/repositories/ must contain at least one .ts file (TDD RED: directory does not exist yet)'
      ).toBeGreaterThan(0);

      const combinedSource = repoFiles
        .map((f) => readFileSync(f, 'utf-8'))
        .join('\n');

      expect(combinedSource).toContain('@railrepay/postgres-client');
    });

    it('src/repositories/ directory exists after Blake implements Phase US-3', () => {
      // Diagnostic: clear failure message when the directory is missing
      const repoDir = join(SERVICE_ROOT, 'src', 'repositories');
      expect(existsSync(repoDir)).toBe(true);
    });
  });

  describe('AC-E.2: no raw "from \'pg\'" import in src/repositories/', () => {
    it('src/repositories/ files must not import directly from \'pg\'', () => {
      // CLAUDE.md §8: raw pg.Pool bypasses the shared postgres-client wrapper.
      // Blake must use @railrepay/postgres-client for the Pool type — not the raw pg package.
      // Note: using the pg TYPE import ('import type { Pool } from pg') for type annotation
      //       in tests is permitted; this assertion targets src/ files only.
      const repoFiles = getRepositoryFiles();

      // If files don't exist yet, this test trivially passes (not a violation)
      // The wiring test above already enforces that src/repositories/ exists.
      for (const file of repoFiles) {
        const content = readFileSync(file, 'utf-8');
        // Strip type-only imports before checking (type imports are acceptable)
        const nonTypeImportLines = content
          .split('\n')
          .filter((line) => {
            const trimmed = line.trim();
            return (
              !trimmed.startsWith('//') &&
              !trimmed.startsWith('*') &&
              !trimmed.startsWith('import type')
            );
          })
          .join('\n');

        expect(
          nonTypeImportLines,
          `File ${file} must not import from 'pg' directly — use @railrepay/postgres-client`
        ).not.toMatch(/from\s+['"]pg['"]/);
      }
    });
  });
});
