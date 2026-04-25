/**
 * Integration tests: user_identity.sessions schema migration
 *
 * BL item : BL-201
 * Story   : RAILREPAY-AUTH-002
 * Phase   : 2 (Hoops — Data Layer own tests, not Jessie's US-2 repository tests)
 *
 * These tests verify Hoops's migration deliverable
 * (1745625600000_create-sessions-table.ts). They run against real PostgreSQL 16
 * via Testcontainers, mirroring the pattern from user-identity-schema.test.ts (IDP-001).
 *
 * IMPORTANT — Jessie's Phase 3.1 (US-2) tests for SessionRepository application code
 * are a SEPARATE file written by Jessie BEFORE Blake's implementation. This file tests
 * the schema shape only.
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation
 *   ADR-003  — node-pg-migrate as migration tool
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-017  — Hoops provides sample-data queries; Jessie owns fixtures
 *   ADR-018  — per-service migration tracking (pgmigrations in user_identity schema)
 *   ADR-025  — user_identity schema, owned by auth-service
 *   DR-UC-002 — auth-service owns session issuance for all channels
 *
 * Infrastructure:
 *   - Vitest (ADR-004 / CLAUDE.md §7.1) — NEVER Jest
 *   - Testcontainers PostgreSQL 16-alpine (matches Railway PG version)
 *   - node-pg-migrate CLI invoked via execSync (mirrors IDP-001 pattern)
 *   - Both IDP-001 AND AUTH-002 migrations are run in sequence — sessions depends on
 *     user_identity schema + users table created by IDP-001
 *
 * AC coverage map:
 *   AC-B1.1  sessions table — columns, types, defaults, nullability
 *   AC-B1.2  sessions_channel_check constraint — valid and invalid channel values
 *   AC-B1.3  FK sessions_user_id_fk — named, enforced, CASCADE DELETE
 *   AC-B1.4  Indexes — idx_sessions_user_id and idx_sessions_expires_at exist
 *   AC-B1.5  down() drops sessions only; up→down→up is idempotent
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

/**
 * Run node-pg-migrate UP (ALL pending migrations) against the given DATABASE_URL.
 *
 * Both IDP-001 (1745539200000) and AUTH-002 (1745625600000) are applied in
 * timestamp order. AUTH-002 depends on the user_identity schema and users table
 * created by IDP-001.
 *
 * migrationsSchema:
 *   - 'user_identity' (default): production ADR-018 behaviour; pgmigrations tracking
 *     table lives inside user_identity. Verified by AC-B1.1 test suite.
 *   - 'public': used in rollback/idempotency containers where DOWN drops the
 *     user_identity schema (and everything in it) via CASCADE. pgmigrations in public
 *     survives the schema drop so node-pg-migrate can mark the migration as rolled back
 *     without hitting "relation does not exist".
 */
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

/**
 * Run node-pg-migrate DOWN (one step) against the given DATABASE_URL.
 *
 * One step undoes the most recent migration (1745625600000_create-sessions-table).
 * @param migrationsSchema Must match what was used during UP for the same container.
 */
function runMigrationDown(
  databaseUrl: string,
  migrationsSchema: 'user_identity' | 'public' = 'user_identity'
): void {
  execSync(
    [
      'npx node-pg-migrate down',
      '--migrations-dir dist/migrations',
      `--migrations-schema ${migrationsSchema}`,
    ].join(' '),
    {
      cwd: SERVICE_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    }
  );
}

// ---------------------------------------------------------------------------
// Main test suite — shared container (schema-shape + constraint + FK tests)
// All tests share one container with IDP-001 + AUTH-002 applied.
// ---------------------------------------------------------------------------

describe('user_identity.sessions migration — AUTH-002 / BL-201', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    // Build migrations from TypeScript source before running tests.
    // This compiles both IDP-001 and AUTH-002 migration files.
    console.log('[auth-service] Building migrations from TypeScript source…');
    execSync('npm run build:migrations', {
      cwd: SERVICE_ROOT,
      stdio: 'pipe',
    });

    // Start PostgreSQL 16 container (matches Railway's PG version).
    console.log('[auth-service] Starting PostgreSQL 16 container via Testcontainers…');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('auth_test_sessions')
      .withUsername('auth_test_sessions')
      .withPassword('auth_test_sessions')
      .start();

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Run ALL UP migrations: IDP-001 first (schema + users + channel_identities),
    // then AUTH-002 (sessions). node-pg-migrate applies in timestamp order.
    console.log('[auth-service] Running UP migrations (IDP-001 + AUTH-002)…');
    runMigrationUp(container.getConnectionUri());
    console.log('[auth-service] UP migrations complete.');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ─── AC-B1.1: sessions table columns ─────────────────────────────────────

  describe('AC-B1.1: user_identity.sessions table structure', () => {
    it('should have exactly the specified columns in order', async () => {
      // AC-B1.1: column list must match spec exactly
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
        ORDER BY ordinal_position
      `);
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toEqual([
        'session_id',
        'user_id',
        'channel',
        'issued_at',
        'expires_at',
        'revoked_at',
      ]);
    });

    it('session_id: UUID type, NOT NULL, PRIMARY KEY, DEFAULT gen_random_uuid()', async () => {
      // AC-B1.1: session_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      const colResult = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'session_id'
      `);
      expect(colResult.rows).toHaveLength(1);
      expect(colResult.rows[0].data_type).toBe('uuid');
      expect(colResult.rows[0].is_nullable).toBe('NO');
      expect(colResult.rows[0].column_default).toContain('gen_random_uuid()');

      // Verify PRIMARY KEY
      const pkResult = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'user_identity'
          AND tc.table_name = 'sessions'
      `);
      expect(pkResult.rows).toHaveLength(1);
      expect(pkResult.rows[0].column_name).toBe('session_id');
    });

    it('session_id: insert without explicit value yields a UUID', async () => {
      // AC-B1.1: DEFAULT gen_random_uuid() actually fires on insert
      // Need a valid user first
      const userResult = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      const sessionResult = await pool.query(`
        INSERT INTO user_identity.sessions (user_id, channel, expires_at)
        VALUES ($1, 'whatsapp', NOW() + INTERVAL '30 days')
        RETURNING session_id
      `, [userId]);

      expect(sessionResult.rows).toHaveLength(1);
      // UUID v4 pattern
      expect(sessionResult.rows[0].session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

      // Clean up
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [userId]);
    });

    it('user_id: UUID type, NOT NULL', async () => {
      // AC-B1.1: user_id uuid NOT NULL
      const result = await pool.query(`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'user_id'
      `);
      expect(result.rows[0].data_type).toBe('uuid');
      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('channel: VARCHAR(32) type, NOT NULL', async () => {
      // AC-B1.1: channel varchar(32) NOT NULL
      const result = await pool.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'channel'
      `);
      expect(result.rows[0].data_type).toBe('character varying');
      expect(result.rows[0].character_maximum_length).toBe(32);
      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('issued_at: TIMESTAMPTZ type, NOT NULL, DEFAULT NOW()', async () => {
      // AC-B1.1: issued_at timestamptz NOT NULL DEFAULT NOW()
      const result = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'issued_at'
      `);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].is_nullable).toBe('NO');
      expect(result.rows[0].column_default).toContain('now()');
    });

    it('expires_at: TIMESTAMPTZ type, NOT NULL, NO default (Q-AUTH-002-2)', async () => {
      // AC-B1.1: expires_at timestamptz NOT NULL — no default at DB level
      // Application (Blake) computes NOW() + SESSION_TTL_MS at INSERT time
      const result = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'expires_at'
      `);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].is_nullable).toBe('NO');
      // Explicitly assert NO default — this is load-bearing (Q-AUTH-002-2)
      expect(result.rows[0].column_default).toBeNull();
    });

    it('expires_at: insert without expires_at value is rejected (NOT NULL, no default)', async () => {
      // AC-B1.1: NOT NULL no-default enforces app-computed expires_at (Q-AUTH-002-2)
      const userResult = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      await expect(
        pool.query(`
          INSERT INTO user_identity.sessions (user_id, channel)
          VALUES ($1, 'web')
        `, [userId])
      ).rejects.toThrow(/null value in column "expires_at"/);

      // Clean up
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [userId]);
    });

    it('revoked_at: TIMESTAMPTZ type, nullable, no default (NULL = active session)', async () => {
      // AC-B1.1: revoked_at timestamptz NULL (defaults to NULL)
      const result = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND column_name = 'revoked_at'
      `);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].is_nullable).toBe('YES');
      expect(result.rows[0].column_default).toBeNull();
    });

    it('revoked_at is NULL on a freshly inserted session', async () => {
      // AC-B1.1: row inserted without revoked_at should have revoked_at = NULL
      const userResult = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      const sessionResult = await pool.query(`
        INSERT INTO user_identity.sessions (user_id, channel, expires_at)
        VALUES ($1, 'web', NOW() + INTERVAL '30 days')
        RETURNING session_id, revoked_at
      `, [userId]);

      expect(sessionResult.rows[0].revoked_at).toBeNull();

      // Clean up
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [userId]);
    });
  });

  // ─── AC-B1.2: sessions_channel_check ─────────────────────────────────────

  describe('AC-B1.2: sessions_channel_check constraint', () => {
    let sharedUserId: string;

    beforeAll(async () => {
      const result = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      sharedUserId = result.rows[0].user_id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [sharedUserId]);
    });

    const validChannels = ['whatsapp', 'web', 'rn', 'swift', 'browser_extension'];

    for (const channel of validChannels) {
      it(`should accept "${channel}" as a valid channel value`, async () => {
        // AC-B1.2: each locked enum value (Q-AUTH-002-1, same as channel_identities)
        const uniqueId = `${channel}_${Date.now()}`;
        const result = await pool.query(`
          INSERT INTO user_identity.sessions (user_id, channel, expires_at)
          VALUES ($1, $2, NOW() + INTERVAL '30 days')
          RETURNING channel, session_id
        `, [sharedUserId, channel]);
        expect(result.rows[0].channel).toBe(channel);
        // Clean up this specific session to keep the table tidy
        await pool.query('DELETE FROM user_identity.sessions WHERE session_id = $1', [
          result.rows[0].session_id,
        ]);
      });
    }

    it('should reject "telegram" — not in locked enum', async () => {
      // AC-B1.2: telegram is not a valid channel
      await expect(
        pool.query(`
          INSERT INTO user_identity.sessions (user_id, channel, expires_at)
          VALUES ($1, 'telegram', NOW() + INTERVAL '30 days')
        `, [sharedUserId])
      ).rejects.toThrow(/violates check constraint/);
    });

    it('should reject "sms" — not in locked enum', async () => {
      // AC-B1.2: boundary — an arbitrary unlisted channel
      await expect(
        pool.query(`
          INSERT INTO user_identity.sessions (user_id, channel, expires_at)
          VALUES ($1, 'sms', NOW() + INTERVAL '30 days')
        `, [sharedUserId])
      ).rejects.toThrow(/violates check constraint/);
    });

    it('sessions_channel_check constraint is named exactly as specified', async () => {
      // AC-B1.2: constraint name must match spec exactly
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND constraint_type = 'CHECK'
          AND constraint_name = 'sessions_channel_check'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });

  // ─── AC-B1.3: FK sessions_user_id_fk + CASCADE ───────────────────────────

  describe('AC-B1.3: sessions_user_id_fk FK constraint and CASCADE DELETE', () => {
    it('sessions_user_id_fk constraint is named exactly as specified', async () => {
      // AC-B1.3: constraint name must match spec exactly
      const result = await pool.query(`
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'user_identity'
          AND tc.table_name = 'sessions'
          AND tc.constraint_name = 'sessions_user_id_fk'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it('FK references user_identity.users(user_id)', async () => {
      // AC-B1.3: FK must point to user_identity.users(user_id)
      const result = await pool.query(`
        SELECT
          kcu.column_name,
          ccu.table_schema AS foreign_table_schema,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'user_identity'
          AND tc.table_name = 'sessions'
          AND tc.constraint_name = 'sessions_user_id_fk'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_name).toBe('user_id');
      expect(result.rows[0].foreign_table_schema).toBe('user_identity');
      expect(result.rows[0].foreign_table_name).toBe('users');
      expect(result.rows[0].foreign_column_name).toBe('user_id');
    });

    it('should reject inserting a session with a non-existent user_id (FK violation)', async () => {
      // AC-B1.3: FK enforcement — orphan sessions must be rejected
      const nonExistentUserId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      await expect(
        pool.query(`
          INSERT INTO user_identity.sessions (user_id, channel, expires_at)
          VALUES ($1, 'web', NOW() + INTERVAL '30 days')
        `, [nonExistentUserId])
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('should CASCADE DELETE sessions when the parent user is deleted', async () => {
      // AC-B1.3: ON DELETE CASCADE — sessions removed when user is purged
      const userResult = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      // Insert two sessions for this user (different channels)
      await pool.query(`
        INSERT INTO user_identity.sessions (user_id, channel, expires_at)
        VALUES
          ($1, 'web',      NOW() + INTERVAL '30 days'),
          ($1, 'whatsapp', NOW() + INTERVAL '30 days')
      `, [userId]);

      // Confirm both sessions exist before deletion
      const beforeDelete = await pool.query(`
        SELECT session_id FROM user_identity.sessions WHERE user_id = $1
      `, [userId]);
      expect(beforeDelete.rows).toHaveLength(2);

      // Delete the user
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [userId]);

      // Both sessions must have been CASCADE-deleted
      const afterDelete = await pool.query(`
        SELECT session_id FROM user_identity.sessions WHERE user_id = $1
      `, [userId]);
      expect(afterDelete.rows).toHaveLength(0);
    });
  });

  // ─── AC-B1.4: Indexes ────────────────────────────────────────────────────

  describe('AC-B1.4: idx_sessions_user_id and idx_sessions_expires_at indexes', () => {
    it('idx_sessions_user_id index exists on user_identity.sessions(user_id)', async () => {
      // AC-B1.4: plain btree index on (user_id) — supports findActive queries
      const result = await pool.query(`
        SELECT indexname, tablename, schemaname
        FROM pg_indexes
        WHERE schemaname = 'user_identity'
          AND tablename = 'sessions'
          AND indexname = 'idx_sessions_user_id'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].indexname).toBe('idx_sessions_user_id');
    });

    it('idx_sessions_expires_at index exists on user_identity.sessions(expires_at)', async () => {
      // AC-B1.4: plain btree index on (expires_at) — supports future cleanup sweeps
      const result = await pool.query(`
        SELECT indexname, tablename, schemaname
        FROM pg_indexes
        WHERE schemaname = 'user_identity'
          AND tablename = 'sessions'
          AND indexname = 'idx_sessions_expires_at'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].indexname).toBe('idx_sessions_expires_at');
    });

    it('no partial index WHERE revoked_at IS NULL (deferred to IDP-002, Q-AUTH-002-3)', async () => {
      // AC-B1.4: partial index deferred — assert it does NOT exist in this migration
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'user_identity'
          AND tablename = 'sessions'
          AND indexdef ILIKE '%where%revoked_at%is%null%'
      `);
      expect(result.rows).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Rollback suite — dedicated containers for AC-B1.5.
// Uses migrations-schema=public so pgmigrations survives DROP SCHEMA user_identity CASCADE.
// See IDP-001 test file for the pattern rationale.
// ---------------------------------------------------------------------------

describe('user_identity.sessions migration — rollback and idempotency (AC-B1.5)', () => {
  it('down() drops sessions table only — users and channel_identities survive', async () => {
    // AC-B1.5: sessions table removed by down(); schema and other IDP-001 tables intact
    const rollbackContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('rollback_sessions_test')
      .withUsername('rollback_sessions')
      .withPassword('rollback_sessions')
      .start();

    const rollbackPool = new Pool({ connectionString: rollbackContainer.getConnectionUri() });

    try {
      // UP all migrations (IDP-001 + AUTH-002), tracking in public
      runMigrationUp(rollbackContainer.getConnectionUri(), 'public');

      // Verify sessions table exists after UP
      let tablesResult = await rollbackPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      let tableNames = tablesResult.rows.map((r) => r.table_name);
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('channel_identities');

      // DOWN one step — rolls back 1745625600000_create-sessions-table only
      runMigrationDown(rollbackContainer.getConnectionUri(), 'public');

      // sessions must be gone; users and channel_identities must remain
      tablesResult = await rollbackPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      tableNames = tablesResult.rows.map((r) => r.table_name);
      expect(tableNames).not.toContain('sessions');
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('channel_identities');

      // Schema itself must still exist
      const schemaResult = await rollbackPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(schemaResult.rows).toHaveLength(1);
    } finally {
      await rollbackPool.end();
      await rollbackContainer.stop();
    }
  }, 120_000);

  it('up → down → up is idempotent — sessions table, constraints, and indexes survive a full cycle', async () => {
    // AC-B1.5: up→down→up idempotency; IF EXISTS / CREATE TABLE guards work on second UP
    const idempotencyContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('idempotency_sessions_test')
      .withUsername('idempotency_sessions')
      .withPassword('idempotency_sessions')
      .start();

    const idempotencyPool = new Pool({
      connectionString: idempotencyContainer.getConnectionUri(),
    });

    try {
      // UP (first time) — tracking in public
      runMigrationUp(idempotencyContainer.getConnectionUri(), 'public');

      // Seed a session to verify it is gone after DOWN
      const userResult = await idempotencyPool.query(`
        INSERT INTO user_identity.users (user_id, status)
        VALUES ('c0000000-0000-0000-0000-000000000001', 'active')
        RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      await idempotencyPool.query(`
        INSERT INTO user_identity.sessions (user_id, channel, expires_at)
        VALUES ($1, 'web', NOW() + INTERVAL '30 days')
      `, [userId]);

      // Verify session exists
      let sessionsResult = await idempotencyPool.query(
        'SELECT session_id FROM user_identity.sessions WHERE user_id = $1',
        [userId]
      );
      expect(sessionsResult.rows).toHaveLength(1);

      // DOWN (one step — removes sessions table)
      runMigrationDown(idempotencyContainer.getConnectionUri(), 'public');

      // sessions table must be gone
      let tablesResult = await idempotencyPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
      `);
      expect(tablesResult.rows).toHaveLength(0);

      // UP again (second time — must succeed without errors)
      runMigrationUp(idempotencyContainer.getConnectionUri(), 'public');

      // sessions table must exist again
      tablesResult = await idempotencyPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
      `);
      expect(tablesResult.rows).toHaveLength(1);

      // All named constraints must exist after second UP
      const constraintsResult = await idempotencyPool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND table_name = 'sessions'
          AND constraint_name IN (
            'sessions_channel_check',
            'sessions_user_id_fk'
          )
        ORDER BY constraint_name
      `);
      const constraintNames = constraintsResult.rows.map((r) => r.constraint_name);
      expect(constraintNames).toContain('sessions_channel_check');
      expect(constraintNames).toContain('sessions_user_id_fk');

      // Both indexes must exist after second UP
      const indexesResult = await idempotencyPool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'user_identity'
          AND tablename = 'sessions'
          AND indexname IN ('idx_sessions_user_id', 'idx_sessions_expires_at')
        ORDER BY indexname
      `);
      const indexNames = indexesResult.rows.map((r) => r.indexname);
      expect(indexNames).toContain('idx_sessions_user_id');
      expect(indexNames).toContain('idx_sessions_expires_at');

      // Insert must succeed after second UP (schema fully functional)
      const insertResult = await idempotencyPool.query(`
        INSERT INTO user_identity.sessions (user_id, channel, expires_at)
        VALUES ($1, 'swift', NOW() + INTERVAL '30 days')
        RETURNING session_id
      `, [userId]);
      expect(insertResult.rows).toHaveLength(1);
    } finally {
      await idempotencyPool.end();
      await idempotencyContainer.stop();
    }
  }, 120_000);
});
