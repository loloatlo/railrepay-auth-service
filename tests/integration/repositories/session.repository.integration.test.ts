/**
 * Integration Tests: SessionRepository (AUTH-002)
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
 * Test category: C — Integration tests (Testcontainers PostgreSQL 16)
 * Uses real database interactions — no mocks for SQL paths.
 *
 * Infrastructure:
 *   - Vitest (ADR-004 / CLAUDE.md §7.1) — NEVER Jest
 *   - Testcontainers PostgreSQL 16-alpine (matches Railway PG version)
 *   - node-pg-migrate CLI invoked via execSync (mirrors sessions-schema.test.ts pattern)
 *   - BOTH IDP-001 AND AUTH-002 migrations applied — full schema required before repo tests
 *   - @railrepay/postgres-client Pool type used (Mandatory Rule #8 / CLAUDE.md §8)
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation (sessions in user_identity schema)
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-017  — Jessie owns fixtures; Hoops provided seed data queries (RFC-002 §Fixture Data Samples)
 *   ADR-025  — user_identity schema, owned by auth-service
 *   DR-UC-002 — auth-service owns session issuance for all channels
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/postgres-client)
 *
 * Fixture data source:
 *   Derived from RFC-002-sessions-schema.md §Fixture Data Samples for Jessie (Hoops-provided).
 *   User IDs prefixed 'c0000000-...' to avoid collision with sessions-schema.test.ts seeds.
 *
 * AC coverage map (Blake's US-3 ACs):
 *   AC-B2.1  create({ user_id, channel }) inserts row with correct shape; returns new record
 *   AC-B2.2  findActive(session_id) returns row when active; null when revoked/expired/missing
 *   AC-B3.1  revoke(session_id) sets revoked_at; second call is idempotent (timestamp unchanged)
 *   AC-B4.1  touch(session_id) extends expires_at for active sessions; no-op for revoked/expired
 *   cross     CASCADE DELETE: delete user → sessions disappear (via repository, not raw SQL)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of services/auth-service/ — used for all path resolutions and execSync cwd
const SERVICE_ROOT = path.resolve(__dirname, '../../..');

// ─── Module under test ────────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { SessionRepository } from '../../../src/repositories/session.repository.js';

// ─── Migration helpers (same pattern as sessions-schema.test.ts) ─────────────

function runMigrationUp(
  databaseUrl: string,
  migrationsSchema: 'user_identity' | 'public' = 'user_identity'
): void {
  execSync(
    [
      'npx node-pg-migrate up',
      '--migrations-dir dist/migrations',
      `--migrations-schema ${migrationsSchema}`,
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

// ─── Fixture constants (from RFC-002 §Fixture Data Samples, Hoops-provided) ──

/** User A: active user for happy-path create/findActive tests */
const USER_A = 'c0000000-0000-4000-8000-000000000001';
/** User B: active user for revoke idempotency tests */
const USER_B = 'c0000000-0000-4000-8000-000000000002';
/** User C: active user for touch tests */
const USER_C = 'c0000000-0000-4000-8000-000000000003';
/** User D: active user for CASCADE DELETE test */
const USER_D = 'c0000000-0000-4000-8000-000000000004';

/** All valid channels per Q-AUTH-002-1 */
const VALID_CHANNELS = ['whatsapp', 'web', 'rn', 'swift', 'browser_extension'] as const;
type Channel = (typeof VALID_CHANNELS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Shared container suite — all repository-behaviour tests share one container.
// This avoids the overhead of spinning up a new container for every describe block.
// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-002: SessionRepository integration tests', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let repo: InstanceType<typeof SessionRepository>;

  beforeAll(async () => {
    // Build migrations from TypeScript source before running tests.
    // Compiles both IDP-001 and AUTH-002 migration files.
    console.log('[auth-service] Building migrations from TypeScript source…');
    execSync('npm run build:migrations', {
      cwd: SERVICE_ROOT,
      stdio: 'pipe',
    });

    console.log('[auth-service] Starting PostgreSQL 16 container for SessionRepository integration tests…');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('auth_repo_integration')
      .withUsername('auth_repo_integration')
      .withPassword('auth_repo_integration')
      .start();

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Run BOTH migrations: IDP-001 (schema + users + channel_identities) then AUTH-002 (sessions)
    console.log('[auth-service] Running UP migrations (IDP-001 + AUTH-002)…');
    runMigrationUp(container.getConnectionUri());
    console.log('[auth-service] UP migrations complete.');

    // Seed prerequisite users (used across all test suites in this file)
    // Per RFC-002 §Fixture Data Samples: user IDs prefixed c0000000-... to avoid collision
    await pool.query(`
      INSERT INTO user_identity.users (user_id, status)
      VALUES
        ('${USER_A}', 'active'),
        ('${USER_B}', 'active'),
        ('${USER_C}', 'active'),
        ('${USER_D}', 'active')
    `);

    // SessionRepository uses the @railrepay/postgres-client Pool type (CLAUDE.md §8)
    // The injected pool here satisfies the Pool interface from @railrepay/postgres-client
    repo = new SessionRepository(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ─── AC-B2.1: create() ─────────────────────────────────────────────────

  describe('AC-B2.1: create({ user_id, channel }) — insert and read-back', () => {
    it('should insert a new session row and return the full session record', async () => {
      // AC-B2.1: create() inserts a row; returns { session_id, user_id, channel, issued_at, expires_at, revoked_at: null }
      // Unique input: USER_A + 'whatsapp' — not used by any other test in this describe block
      const result = await repo.create({ user_id: USER_A, channel: 'whatsapp' as Channel });

      expect(result).toBeDefined();
      expect(result.user_id).toBe(USER_A);
      expect(result.channel).toBe('whatsapp');
      expect(result.session_id).toBeDefined();
      // session_id must be a UUID
      expect(result.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(result.revoked_at).toBeNull();
      expect(result.issued_at).toBeDefined();
      expect(result.expires_at).toBeDefined();
    });

    it('should persist the session to the database (read-back verification)', async () => {
      // AC-B2.1: row actually written — verify via direct SQL read-back (not just the return value)
      // Unique input: USER_A + 'web' — distinct channel from the previous test
      const created = await repo.create({ user_id: USER_A, channel: 'web' as Channel });

      const dbResult = await pool.query(
        `SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
         FROM user_identity.sessions
         WHERE session_id = $1`,
        [created.session_id]
      );

      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].session_id).toBe(created.session_id);
      expect(dbResult.rows[0].user_id).toBe(USER_A);
      expect(dbResult.rows[0].channel).toBe('web');
      expect(dbResult.rows[0].revoked_at).toBeNull();
    });

    it('should set expires_at approximately 30 days from now (±60 seconds)', async () => {
      // AC-B2.1: expires_at = now() + 30d; app-computed per Q-AUTH-002-2
      // Unique input: USER_A + 'rn' — third distinct channel for USER_A
      const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const beforeCreate = Date.now();
      const created = await repo.create({ user_id: USER_A, channel: 'rn' as Channel });
      const afterCreate = Date.now();

      const expiresAtMs = new Date(created.expires_at).getTime();
      const expectedMin = beforeCreate + TTL_30_DAYS_MS - 60_000;
      const expectedMax = afterCreate + TTL_30_DAYS_MS + 60_000;

      expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAtMs).toBeLessThanOrEqual(expectedMax);
    });

    it('should set revoked_at to null on a freshly created session', async () => {
      // AC-B2.1: revoked_at IS NULL on creation (AC-B1.1 column design)
      // Unique input: USER_B + 'whatsapp'
      const created = await repo.create({ user_id: USER_B, channel: 'whatsapp' as Channel });
      expect(created.revoked_at).toBeNull();
    });
  });

  // ─── AC-B2.2: findActive() ─────────────────────────────────────────────

  describe('AC-B2.2: findActive(session_id) — active/revoked/expired/missing paths', () => {
    it('should return the row when the session is active (revoked_at IS NULL AND expires_at > now())', async () => {
      // AC-B2.2: happy path — active session found
      // Unique input: USER_B + 'web' active session
      const created = await repo.create({ user_id: USER_B, channel: 'web' as Channel });
      const found = await repo.findActive(created.session_id);

      expect(found).not.toBeNull();
      expect(found!.session_id).toBe(created.session_id);
      expect(found!.user_id).toBe(USER_B);
      expect(found!.channel).toBe('web');
      expect(found!.revoked_at).toBeNull();
    });

    it('should return null when the session has been revoked (revoked_at IS NOT NULL)', async () => {
      // AC-B2.2: revoked path — findActive returns null
      // Unique input: USER_B + 'rn' session revoked directly in DB (not via repo to avoid dependency)
      const created = await repo.create({ user_id: USER_B, channel: 'rn' as Channel });
      // Revoke directly in the DB to isolate this test from revoke() repo method
      await pool.query(
        `UPDATE user_identity.sessions SET revoked_at = NOW() WHERE session_id = $1`,
        [created.session_id]
      );

      const found = await repo.findActive(created.session_id);
      expect(found).toBeNull();
    });

    it('should return null when the session has expired (expires_at <= now(), revoked_at IS NULL)', async () => {
      // AC-B2.2: expired path — findActive returns null
      // Unique input: USER_B + 'swift' session with expires_at set to the past
      const created = await repo.create({ user_id: USER_B, channel: 'swift' as Channel });
      // Backdate expires_at to make it expired
      await pool.query(
        `UPDATE user_identity.sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE session_id = $1`,
        [created.session_id]
      );

      const found = await repo.findActive(created.session_id);
      expect(found).toBeNull();
    });

    it('should return null when the session_id does not exist', async () => {
      // AC-B2.2: non-existent path — findActive returns null (not throws)
      const nonExistentId = 'a9999999-9999-4999-8999-999999999999';
      const found = await repo.findActive(nonExistentId);
      expect(found).toBeNull();
    });
  });

  // ─── AC-B3.1: revoke() ─────────────────────────────────────────────────

  describe('AC-B3.1: revoke(session_id) — sets revoked_at; idempotent second call', () => {
    it('should set revoked_at on an active session', async () => {
      // AC-B3.1: revoke() sets revoked_at = now()
      // Unique input: USER_C + 'whatsapp' active session
      const beforeRevoke = new Date();
      const created = await repo.create({ user_id: USER_C, channel: 'whatsapp' as Channel });
      await repo.revoke(created.session_id);
      const afterRevoke = new Date();

      const dbResult = await pool.query(
        `SELECT revoked_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );

      expect(dbResult.rows).toHaveLength(1);
      const revokedAt = dbResult.rows[0].revoked_at as Date;
      expect(revokedAt).not.toBeNull();
      expect(revokedAt.getTime()).toBeGreaterThanOrEqual(beforeRevoke.getTime());
      expect(revokedAt.getTime()).toBeLessThanOrEqual(afterRevoke.getTime() + 1_000);
    });

    it('should make the session no longer findActive after revoke()', async () => {
      // AC-B3.1: revoked session must not be returned by findActive (AC-B2.2 integration)
      // Unique input: USER_C + 'web' session
      const created = await repo.create({ user_id: USER_C, channel: 'web' as Channel });
      await repo.revoke(created.session_id);

      const found = await repo.findActive(created.session_id);
      expect(found).toBeNull();
    });

    it('should be idempotent: revoked_at timestamp does NOT change on second call', async () => {
      // AC-B3.1: second call to revoke() is a no-op — revoked_at must remain the ORIGINAL timestamp
      // This is the key idempotency invariant: the first revoke timestamp is preserved.
      // Unique input: USER_C + 'rn' session
      const created = await repo.create({ user_id: USER_C, channel: 'rn' as Channel });

      // First revoke
      await repo.revoke(created.session_id);
      const afterFirstRevoke = await pool.query(
        `SELECT revoked_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const firstRevokedAt = afterFirstRevoke.rows[0].revoked_at as Date;
      expect(firstRevokedAt).not.toBeNull();

      // Wait 5ms to ensure a second NOW() call would produce a different timestamp
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second revoke (must be a no-op)
      await repo.revoke(created.session_id);
      const afterSecondRevoke = await pool.query(
        `SELECT revoked_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const secondRevokedAt = afterSecondRevoke.rows[0].revoked_at as Date;

      // revoked_at must NOT have changed — idempotency guarantee
      expect(secondRevokedAt.getTime()).toBe(firstRevokedAt.getTime());
    });

    it('should not throw when session_id does not exist (no-op)', async () => {
      // AC-B3.1: revoke() on a non-existent session must not throw
      await expect(
        repo.revoke('a8888888-8888-4888-8888-888888888888')
      ).resolves.not.toThrow();
    });
  });

  // ─── AC-B4.1: touch() ──────────────────────────────────────────────────

  describe('AC-B4.1: touch(session_id) — extends expires_at for active sessions only', () => {
    it('should extend expires_at to approximately now() + 30d for an active session', async () => {
      // AC-B4.1: touch() updates expires_at on an active session (sliding refresh)
      // Unique input: USER_C + 'swift' session
      const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const created = await repo.create({ user_id: USER_C, channel: 'swift' as Channel });
      const originalExpiresAt = new Date(created.expires_at).getTime();

      // Wait a small amount to ensure the updated expires_at is measurably different
      await new Promise((resolve) => setTimeout(resolve, 5));

      const beforeTouch = Date.now();
      await repo.touch(created.session_id);
      const afterTouch = Date.now();

      const dbResult = await pool.query(
        `SELECT expires_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const updatedExpiresAt = (dbResult.rows[0].expires_at as Date).getTime();

      // expires_at must have been updated (sliding forward by ~30d from the touch call)
      expect(updatedExpiresAt).toBeGreaterThan(originalExpiresAt);

      const expectedMin = beforeTouch + TTL_30_DAYS_MS - 60_000;
      const expectedMax = afterTouch + TTL_30_DAYS_MS + 60_000;
      expect(updatedExpiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(updatedExpiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should be a no-op for a revoked session (revoked_at IS NOT NULL)', async () => {
      // AC-B4.1: touch() must not extend expires_at on a revoked session
      // Unique input: USER_C + 'browser_extension' session (5th distinct channel for USER_C)
      const created = await repo.create({ user_id: USER_C, channel: 'browser_extension' as Channel });
      const originalExpiresAt = new Date(created.expires_at).getTime();

      // Revoke the session directly in DB to isolate from revoke() method
      await pool.query(
        `UPDATE user_identity.sessions SET revoked_at = NOW() WHERE session_id = $1`,
        [created.session_id]
      );

      await repo.touch(created.session_id);

      const dbResult = await pool.query(
        `SELECT expires_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const expiresAtAfterTouch = (dbResult.rows[0].expires_at as Date).getTime();

      // expires_at must NOT have changed — touch() is a no-op for revoked sessions
      expect(expiresAtAfterTouch).toBe(originalExpiresAt);
    });

    it('should be a no-op for an expired session (expires_at <= now())', async () => {
      // AC-B4.1: touch() must not extend expires_at on an already-expired session
      // Unique input: USER_D + 'whatsapp' session with backdated expires_at
      const created = await repo.create({ user_id: USER_D, channel: 'whatsapp' as Channel });
      // Set expires_at to the past
      await pool.query(
        `UPDATE user_identity.sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE session_id = $1`,
        [created.session_id]
      );
      const dbAfterExpiry = await pool.query(
        `SELECT expires_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const expiredAt = (dbAfterExpiry.rows[0].expires_at as Date).getTime();

      await repo.touch(created.session_id);

      const dbAfterTouch = await pool.query(
        `SELECT expires_at FROM user_identity.sessions WHERE session_id = $1`,
        [created.session_id]
      );
      const expiresAtAfterTouch = (dbAfterTouch.rows[0].expires_at as Date).getTime();

      // expires_at must NOT have changed — touch() is a no-op for expired sessions
      expect(expiresAtAfterTouch).toBe(expiredAt);
    });

    it('should not throw when session_id does not exist (no-op)', async () => {
      // AC-B4.1: touch() on a non-existent session must not throw
      await expect(
        repo.touch('a7777777-7777-4777-8777-777777777777')
      ).resolves.not.toThrow();
    });
  });

  // ─── Cross-table: CASCADE DELETE ──────────────────────────────────────

  describe('Cross-table CASCADE DELETE: delete user → sessions disappear (via repository perspective)', () => {
    it('should remove sessions when the owning user is deleted', async () => {
      // Verify the FK CASCADE behaviour is observable through the repository's pool connection.
      // This tests the real database constraint as experienced by the SessionRepository's pool.
      // Unique: USER_D + 'web' + 'rn' — fresh sessions; USER_D is then deleted
      const sessionWeb = await repo.create({ user_id: USER_D, channel: 'web' as Channel });
      const sessionRn = await repo.create({ user_id: USER_D, channel: 'rn' as Channel });

      // Confirm both sessions exist before deletion
      const beforeDelete = await pool.query(
        `SELECT session_id FROM user_identity.sessions WHERE user_id = $1`,
        [USER_D]
      );
      // At least the two sessions we just created are present
      const sessionIds = beforeDelete.rows.map((r: { session_id: string }) => r.session_id);
      expect(sessionIds).toContain(sessionWeb.session_id);
      expect(sessionIds).toContain(sessionRn.session_id);

      // Delete the user — CASCADE should remove all sessions
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [USER_D]);

      // Both sessions must have been CASCADE-deleted
      const afterDelete = await pool.query(
        `SELECT session_id FROM user_identity.sessions WHERE user_id = $1`,
        [USER_D]
      );
      expect(afterDelete.rows).toHaveLength(0);

      // findActive must now return null (consistent with repository perspective)
      const found = await repo.findActive(sessionWeb.session_id);
      expect(found).toBeNull();
    });
  });
});
