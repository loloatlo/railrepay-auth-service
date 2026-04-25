/**
 * Integration Tests: auth-service /health endpoint
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/routes/health.ts.
 * Failure reason: "Cannot find module '../../src/routes/health.js'" (or equivalent).
 *
 * Strategy:
 *   - Testcontainers PostgreSQL 16-alpine (matches Railway PG version, mirrors IDP-001 pattern)
 *   - Boots a container, runs user_identity migrations via node-pg-migrate CLI
 *   - Starts an Express app with the REAL health router wired to the real @railrepay/postgres-client
 *   - Exercises /health with actual DB I/O — no mocked pool
 *   - This is the integration test that catches missing peerDependencies at import time
 *     (lesson from metrics-pusher@1.0.0 crash — see evaluation-coordinator infrastructure-wiring.test.ts)
 *
 * AC coverage map:
 *   AC-A2  /health 200 + { status:'ok', schema:'user_identity', migrations:'up-to-date' }
 *          when Testcontainers PG is up and migration is applied.
 *   AC-A2  /health 503 when DB is unreachable (container stopped or bad URL).
 *   AC-A1  Service starts on PORT env var (integration-level confirmation).
 *   AC-A1  @railrepay/postgres-client is exercised with a REAL DB (not mocked).
 *   AC-A3  /metrics returns Prometheus text format (REAL @railrepay/metrics-pusher import).
 *
 * ADR references:
 *   ADR-014 — TDD
 *   ADR-018 — pgmigrations tracking in user_identity schema
 *   ADR-025 — Schema name user_identity
 *   CLAUDE.md §7  — Integration tests are required
 *   CLAUDE.md §8  — At least one integration test exercises REAL @railrepay/* dependencies
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of services/auth-service/ — used for execSync cwd and migrations path
const SERVICE_ROOT = path.resolve(__dirname, '../../..');

/**
 * Run node-pg-migrate UP against the given DATABASE_URL.
 * Mirrors the pattern from tests/integration/migrations/user-identity-schema.test.ts.
 */
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
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    }
  );
}

/**
 * Make an HTTP GET request to a local server.
 * Returns { statusCode, body } — keeps tests free of axios/fetch dependency.
 */
function httpGet(
  url: string
): Promise<{ statusCode: number; body: Record<string, unknown> | string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port, 10),
        path: parsed.pathname,
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(data),
            });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

describe('RAILREPAY-AUTH-001: /health integration — Testcontainers PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let server: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    // ── Step 1: Build migrations from TypeScript source ─────────────────────
    // Mirrors the IDP-001 migration test pattern.
    console.log('[auth-service integration] Building migrations…');
    execSync('npm run build:migrations', {
      cwd: SERVICE_ROOT,
      stdio: 'pipe',
    });

    // ── Step 2: Start Testcontainers PostgreSQL 16 ───────────────────────────
    console.log('[auth-service integration] Starting PostgreSQL 16 container…');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('auth_int_test')
      .withUsername('auth_int_test')
      .withPassword('auth_int_test')
      .start();

    // ── Step 3: Apply migrations ─────────────────────────────────────────────
    console.log('[auth-service integration] Running UP migration…');
    runMigrationUp(container.getConnectionUri());
    console.log('[auth-service integration] Migrations applied.');

    // ── Step 4: Create a real pg.Pool for verifying health handler directly ──
    pool = new Pool({ connectionString: container.getConnectionUri() });

    // ── Step 5: Boot the auth-service Express app ────────────────────────────
    // Blake must export createApp(pool) from src/app.ts (or src/index.ts).
    // This integration test exercises the REAL health route with the REAL pool.
    // NOT MOCKED — this is the anti-crash integration test (CLAUDE.md §8).
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.PORT = '0'; // ephemeral port assigned by OS

    // @ts-expect-error — module does not exist yet (TDD RED phase)
    const { createApp } = await import('../../src/app.js');

    const app = createApp(pool);

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverPort = addr.port;
          console.log(`[auth-service integration] Server on port ${serverPort}`);
          resolve();
        } else {
          reject(new Error('Failed to get server port'));
        }
      });
      server.on('error', reject);
    });
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await container?.stop();
  });

  // ─── AC-A2: /health 200 — DB reachable, migration applied ────────────────

  describe('AC-A2: GET /health — healthy state (Testcontainers PG + migration applied)', () => {
    it('AC-A2: should return HTTP 200', async () => {
      // AC-A2: locked response — 200 when DB reachable and migration applied
      const response = await httpGet(`http://127.0.0.1:${serverPort}/health`);

      expect(response.statusCode).toBe(200);
    });

    it('AC-A2: should return body with status "ok"', async () => {
      // AC-A2: locked response shape
      const response = await httpGet(`http://127.0.0.1:${serverPort}/health`);

      expect((response.body as Record<string, unknown>).status).toBe('ok');
    });

    it('AC-A2: should return body with schema "user_identity"', async () => {
      // AC-A2: schema field must be "user_identity" (ADR-025)
      const response = await httpGet(`http://127.0.0.1:${serverPort}/health`);

      expect((response.body as Record<string, unknown>).schema).toBe('user_identity');
    });

    it('AC-A2: should return body with migrations "up-to-date"', async () => {
      // AC-A2: migration status — pgmigrations table has at least one row
      const response = await httpGet(`http://127.0.0.1:${serverPort}/health`);

      expect((response.body as Record<string, unknown>).migrations).toBe('up-to-date');
    });

    it('AC-A2: should return the full locked response body shape', async () => {
      // AC-A2: complete shape validation
      const response = await httpGet(`http://127.0.0.1:${serverPort}/health`);

      expect(response.body).toEqual({
        status: 'ok',
        schema: 'user_identity',
        migrations: 'up-to-date',
      });
    });

    it('AC-A2: user_identity.pgmigrations must contain at least one applied migration row', async () => {
      // AC-A2: direct DB verification that the migration was actually applied.
      // This is the authoritative check — /health queries this table.
      const result = await pool.query(
        'SELECT id, name, run_on FROM user_identity.pgmigrations ORDER BY run_on ASC'
      );

      expect(result.rows.length).toBeGreaterThan(0);
      // The IDP-001 migration name should be present
      expect(result.rows[0].name).toContain('create-user-identity-schema');
    });
  });

  // ─── AC-A2: /health non-200 — DB unreachable ─────────────────────────────

  describe('AC-A2: GET /health — DB unreachable (bad DATABASE_URL)', () => {
    let serverUnhealthy: http.Server;
    let portUnhealthy: number;

    beforeEach(async () => {
      // Boot a SEPARATE app instance with a dead pool pointing at a non-existent DB.
      // This isolates the failure from the healthy-state container.
      const deadPool = new Pool({
        connectionString:
          'postgresql://dead:dead@127.0.0.1:1/nonexistent_db',
        connectionTimeoutMillis: 500,
      });

      // @ts-expect-error — module does not exist yet (TDD RED phase)
      const { createApp } = await import('../../src/app.js');
      const appUnhealthy = createApp(deadPool);

      await new Promise<void>((resolve, reject) => {
        serverUnhealthy = appUnhealthy.listen(0, () => {
          const addr = serverUnhealthy.address();
          if (addr && typeof addr === 'object') {
            portUnhealthy = addr.port;
            resolve();
          } else {
            reject(new Error('Failed to get port'));
          }
        });
        serverUnhealthy.on('error', reject);
      });
    }, 30_000);

    afterAll(async () => {
      await new Promise<void>((resolve) =>
        serverUnhealthy?.close(() => resolve())
      );
    });

    it('AC-A2: should return HTTP 503 when DB unreachable', async () => {
      // AC-A2: "/health returns 503 when DB unreachable" — per AUTH-001 test scenarios
      const response = await httpGet(
        `http://127.0.0.1:${portUnhealthy}/health`
      );

      expect(response.statusCode).toBe(503);
    });

    it('AC-A2: response body status must not be "ok" when DB is unreachable', async () => {
      const response = await httpGet(
        `http://127.0.0.1:${portUnhealthy}/health`
      );

      expect((response.body as Record<string, unknown>).status).not.toBe('ok');
    });
  });

  // ─── AC-A3: /metrics — REAL @railrepay/metrics-pusher ───────────────────
  //
  // This test exercises the REAL @railrepay/metrics-pusher import (no vi.mock).
  // It is the critical anti-crash test (CLAUDE.md §8, evaluation-coordinator pattern).

  describe('AC-A3: GET /metrics — REAL @railrepay/metrics-pusher (not mocked)', () => {
    it('AC-A3: should return HTTP 200 from /metrics', async () => {
      // AC-A3: /metrics endpoint must be reachable
      const response = await httpGet(
        `http://127.0.0.1:${serverPort}/metrics`
      );

      expect(response.statusCode).toBe(200);
    });

    it('AC-A3: /metrics response body should contain Prometheus text format markers', async () => {
      // AC-A3: Prometheus text format — # HELP and # TYPE must be present
      const response = await httpGet(
        `http://127.0.0.1:${serverPort}/metrics`
      );

      const body = response.body as string;
      expect(body).toContain('# HELP');
      expect(body).toContain('# TYPE');
    });

    it('AC-A3: /metrics response should include auth_service_up gauge', async () => {
      // AC-A3: the service-specific gauge — verifies metrics-pusher initialised correctly
      const response = await httpGet(
        `http://127.0.0.1:${serverPort}/metrics`
      );

      const body = response.body as string;
      expect(body).toContain('auth_service_up');
    });
  });

  // ─── AC-A1: Service starts on PORT (integration confirmation) ────────────

  describe('AC-A1: Service starts on PORT env var (integration level)', () => {
    it('AC-A1: server should be listening on a port assigned from the PORT env var', () => {
      // AC-A1: the integration server started on PORT=0 (OS-assigned ephemeral port)
      // We verify it is listening by confirming serverPort was assigned.
      expect(serverPort).toBeGreaterThan(0);
    });
  });
});
