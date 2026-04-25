/**
 * Integration tests: user_identity schema migration
 *
 * BL item : BL-207
 * Story   : RAILREPAY-IDP-001
 * Phase   : 3.1 (Jessie — Test Specification, TDD per ADR-014)
 *
 * These tests are written BEFORE Blake's implementation phase (skipped for this
 * slice — Phase 3.2 is empty because there is no application code in IDP-001).
 * They verify Hoops's migration deliverable: the migration must make every test
 * below GREEN.
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests. If a test
 * appears wrong, hand back to Jessie with explanation.
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation
 *   ADR-003  — node-pg-migrate as migration tool
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-017  — Jessie owns fixtures; Hoops provides sample-data queries
 *   ADR-018  — per-service migration tracking (pgmigrations in user_identity schema)
 *   ADR-025  — user_identity schema, owned by auth-service
 *
 * Infrastructure:
 *   - Vitest (ADR-004 / CLAUDE.md §7.1) — NEVER Jest
 *   - Testcontainers PostgreSQL 16-alpine (matches Railway PG version)
 *   - node-pg-migrate CLI invoked via execSync (mirrors delay-tracker pattern)
 *   - Migration compiled first via `npm run build:migrations`
 *     (tsc → dist/migrations/*.js → rename-migrations.js → dist/migrations/*.cjs)
 *
 * AC coverage map:
 *   AC-1  user_identity schema exists after up()
 *   AC-2  users table — columns, types, defaults
 *   AC-3  users.status CHECK constraint
 *   AC-4  channel_identities table — columns, FK, ON DELETE CASCADE
 *   AC-5  composite UNIQUE (channel, channel_user_id)
 *   AC-6  channel_identities.channel CHECK constraint
 *   AC-7  down() reverses cleanly; up→down→up is idempotent
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
 * Run node-pg-migrate UP against the given DATABASE_URL.
 *
 * Production config (ADR-018): migrations-schema=user_identity so the pgmigrations
 * tracking table lives inside the owned schema. This is verified by the AC-1 test in
 * the main suite which uses the production settings.
 *
 * Rollback-container variant: passes migrations-schema=public so the pgmigrations
 * tracking table lives in public — it therefore survives DROP SCHEMA user_identity CASCADE.
 * This allows node-pg-migrate to record then undo the migration in a single container
 * lifecycle without hitting "relation user_identity.pgmigrations does not exist" on DOWN.
 *
 * @param databaseUrl  Connection URI for an ephemeral Testcontainers PG instance.
 * @param migrationsSchema  Where to store the pgmigrations tracking table.
 *   - 'user_identity' (default): production ADR-018 behaviour, verified by AC-1 test.
 *   - 'public': rollback-test containers where the schema itself is dropped in down().
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
 * @param migrationsSchema  Must match what was used during UP for the same container.
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
// ---------------------------------------------------------------------------

describe('user_identity schema migration — IDP-001 / BL-207', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    // Build migrations from TypeScript source before running tests.
    // This ensures dist/migrations/ is up to date with the current .ts source.
    console.log('[auth-service] Building migrations from TypeScript source…');
    execSync('npm run build:migrations', {
      cwd: SERVICE_ROOT,
      stdio: 'pipe',
    });

    // Start PostgreSQL 16 container (matches Railway's PG version per handoff spec).
    console.log('[auth-service] Starting PostgreSQL 16 container via Testcontainers…');
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('auth_test')
      .withUsername('auth_test')
      .withPassword('auth_test')
      .start();

    pool = new Pool({ connectionString: container.getConnectionUri() });

    // Run the UP migration once — all schema-shape tests share this state.
    console.log('[auth-service] Running UP migration…');
    runMigrationUp(container.getConnectionUri());
    console.log('[auth-service] UP migration complete.');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // ─── AC-1: Schema existence ───────────────────────────────────────────────

  describe('AC-1: user_identity schema', () => {
    it('should exist in information_schema.schemata after up()', async () => {
      // AC-1: user_identity schema exists after migration up
      const result = await pool.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].schema_name).toBe('user_identity');
    });

    it('should track pgmigrations inside user_identity schema (ADR-018)', async () => {
      // AC-1 + ADR-018: pgmigrations tracking table must NOT be in public schema
      const result = await pool.query(`
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE tablename = 'pgmigrations'
          AND schemaname = 'user_identity'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].schemaname).toBe('user_identity');
    });
  });

  // ─── AC-2: users table ────────────────────────────────────────────────────

  describe('AC-2: user_identity.users table structure', () => {
    it('should have exactly the specified columns', async () => {
      // AC-2: users columns — user_id, created_at, status
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'users'
        ORDER BY ordinal_position
      `);
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toEqual(['user_id', 'created_at', 'status']);
    });

    it('user_id column: UUID type, NOT NULL, is primary key', async () => {
      // AC-2: user_id UUID PK NOT NULL
      const colResult = await pool.query(`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'users'
          AND column_name = 'user_id'
      `);
      expect(colResult.rows).toHaveLength(1);
      expect(colResult.rows[0].data_type).toBe('uuid');
      expect(colResult.rows[0].is_nullable).toBe('NO');

      const pkResult = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'user_identity'
          AND tc.table_name = 'users'
      `);
      expect(pkResult.rows[0].column_name).toBe('user_id');
    });

    it('user_id column: defaults to gen_random_uuid() — inserts without explicit user_id get a UUID', async () => {
      // AC-2: DEFAULT gen_random_uuid()
      const result = await pool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('active')
        RETURNING user_id
      `);
      expect(result.rows).toHaveLength(1);
      // UUID v4 pattern
      expect(result.rows[0].user_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      // Clean up
      await pool.query(
        'DELETE FROM user_identity.users WHERE user_id = $1',
        [result.rows[0].user_id]
      );
    });

    it('created_at column: TIMESTAMPTZ type, NOT NULL, defaults to NOW()', async () => {
      // AC-2: created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      const result = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'users'
          AND column_name = 'created_at'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].is_nullable).toBe('NO');
      expect(result.rows[0].column_default).toContain('now()');
    });

    it('status column: VARCHAR(20) type, NOT NULL', async () => {
      // AC-2: status VARCHAR(20) NOT NULL
      const result = await pool.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'users'
          AND column_name = 'status'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].data_type).toBe('character varying');
      expect(result.rows[0].character_maximum_length).toBe(20);
      expect(result.rows[0].is_nullable).toBe('NO');
    });
  });

  // ─── AC-3: users.status CHECK ────────────────────────────────────────────

  describe('AC-3: users_status_check constraint', () => {
    it('should accept "active" as a valid status', async () => {
      // AC-3: status IN ('active','suspended','deleted')
      const result = await pool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('active')
        RETURNING user_id
      `);
      expect(result.rows).toHaveLength(1);
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [
        result.rows[0].user_id,
      ]);
    });

    it('should accept "suspended" as a valid status', async () => {
      // AC-3: suspended is a locked enum value (Q2, 2026-04-25)
      const result = await pool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('suspended')
        RETURNING user_id
      `);
      expect(result.rows).toHaveLength(1);
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [
        result.rows[0].user_id,
      ]);
    });

    it('should accept "deleted" as a valid status', async () => {
      // AC-3: deleted is a locked enum value (Q2, 2026-04-25)
      const result = await pool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('deleted')
        RETURNING user_id
      `);
      expect(result.rows).toHaveLength(1);
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [
        result.rows[0].user_id,
      ]);
    });

    it('should reject "banned" — not in locked enum', async () => {
      // AC-3: 'banned' is NOT a valid status (RFC-001 §test spec 3)
      await expect(
        pool.query(`
          INSERT INTO user_identity.users (status)
          VALUES ('banned')
        `)
      ).rejects.toThrow(/violates check constraint/);
    });

    it('should reject empty string — not in locked enum', async () => {
      // AC-3: boundary — empty string is not a valid status value
      await expect(
        pool.query(`
          INSERT INTO user_identity.users (status)
          VALUES ('')
        `)
      ).rejects.toThrow(/violates check constraint/);
    });

    it('users_status_check constraint is named exactly as specified', async () => {
      // AC-3: constraint name must match specification exactly
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND table_name = 'users'
          AND constraint_type = 'CHECK'
          AND constraint_name = 'users_status_check'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });

  // ─── AC-4: channel_identities table ──────────────────────────────────────

  describe('AC-4: user_identity.channel_identities table structure', () => {
    it('should have exactly the specified columns', async () => {
      // AC-4: user_id, channel, channel_user_id, created_at, last_seen_at
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
        ORDER BY ordinal_position
      `);
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toEqual([
        'user_id',
        'channel',
        'channel_user_id',
        'created_at',
        'last_seen_at',
      ]);
    });

    it('user_id column: UUID type, NOT NULL', async () => {
      // AC-4: user_id UUID NOT NULL
      const result = await pool.query(`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND column_name = 'user_id'
      `);
      expect(result.rows[0].data_type).toBe('uuid');
      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('channel column: VARCHAR(32) type, NOT NULL', async () => {
      // AC-4: channel VARCHAR(32) NOT NULL
      const result = await pool.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND column_name = 'channel'
      `);
      expect(result.rows[0].data_type).toBe('character varying');
      expect(result.rows[0].character_maximum_length).toBe(32);
      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('channel_user_id column: VARCHAR(255) type, NOT NULL', async () => {
      // AC-4: channel_user_id VARCHAR(255) NOT NULL
      const result = await pool.query(`
        SELECT data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND column_name = 'channel_user_id'
      `);
      expect(result.rows[0].data_type).toBe('character varying');
      expect(result.rows[0].character_maximum_length).toBe(255);
      expect(result.rows[0].is_nullable).toBe('NO');
    });

    it('last_seen_at column: TIMESTAMPTZ type, NOT NULL, defaults to NOW()', async () => {
      // AC-4: last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      // Q5 locked 2026-04-25: application-updated, no trigger — column has DEFAULT NOW() only
      const result = await pool.query(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND column_name = 'last_seen_at'
      `);
      expect(result.rows[0].data_type).toBe('timestamp with time zone');
      expect(result.rows[0].is_nullable).toBe('NO');
      expect(result.rows[0].column_default).toContain('now()');
    });

    it('should have FK from user_id to user_identity.users(user_id)', async () => {
      // AC-4: user_id REFERENCES user_identity.users(user_id)
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
          AND tc.table_name = 'channel_identities'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_name).toBe('user_id');
      expect(result.rows[0].foreign_table_schema).toBe('user_identity');
      expect(result.rows[0].foreign_table_name).toBe('users');
      expect(result.rows[0].foreign_column_name).toBe('user_id');
    });

    it('should reject inserting channel_identities with a non-existent user_id (FK violation)', async () => {
      // AC-4: FK enforcement — orphan rows must be rejected
      const nonExistentUserId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      await expect(
        pool.query(`
          INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
          VALUES ($1, 'whatsapp', '+447700900099')
        `, [nonExistentUserId])
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('should cascade-delete channel_identities when the parent user is deleted', async () => {
      // AC-4: ON DELETE CASCADE — channel_identities removed when user is removed
      const insertUser = await pool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('active')
        RETURNING user_id
      `);
      const userId = insertUser.rows[0].user_id;

      await pool.query(`
        INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
        VALUES ($1, 'whatsapp', '+447700900011')
      `, [userId]);

      // Confirm channel identity exists before deletion
      const beforeDelete = await pool.query(`
        SELECT user_id FROM user_identity.channel_identities WHERE user_id = $1
      `, [userId]);
      expect(beforeDelete.rows).toHaveLength(1);

      // Delete the user
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [userId]);

      // channel_identities row must have been cascade-deleted
      const afterDelete = await pool.query(`
        SELECT user_id FROM user_identity.channel_identities WHERE user_id = $1
      `, [userId]);
      expect(afterDelete.rows).toHaveLength(0);
    });
  });

  // ─── AC-5: composite UNIQUE (channel, channel_user_id) ───────────────────

  describe('AC-5: channel_identities_channel_user_unique composite UNIQUE constraint', () => {
    it('constraint is named exactly channel_identities_channel_user_unique', async () => {
      // AC-5: name must match specification exactly
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND constraint_type = 'UNIQUE'
          AND constraint_name = 'channel_identities_channel_user_unique'
      `);
      expect(result.rows).toHaveLength(1);
    });

    it('should reject a second channel_identities row with the same (channel, channel_user_id) even for a different user_id', async () => {
      // AC-5: (channel, channel_user_id) must be unique globally
      const user1 = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const user2 = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId1 = user1.rows[0].user_id;
      const userId2 = user2.rows[0].user_id;

      await pool.query(`
        INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
        VALUES ($1, 'web', 'auth0|sub_unique001')
      `, [userId1]);

      await expect(
        pool.query(`
          INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
          VALUES ($1, 'web', 'auth0|sub_unique001')
        `, [userId2])
      ).rejects.toThrow(/duplicate key value violates unique constraint/);

      // Clean up
      await pool.query('DELETE FROM user_identity.users WHERE user_id IN ($1, $2)', [
        userId1,
        userId2,
      ]);
    });

    it('should allow two rows with the same channel but different channel_user_id values', async () => {
      // AC-5: different channel_user_id on the same channel is permitted
      const userResult = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      const userId = userResult.rows[0].user_id;

      // Two distinct web identities for two different underlying users (same channel, different id)
      const user2Result = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);

      await pool.query(`
        INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
        VALUES ($1, 'rn', 'rn_device_aaa')
      `, [userId]);

      const result = await pool.query(`
        INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
        VALUES ($1, 'rn', 'rn_device_bbb')
        RETURNING user_id
      `, [user2Result.rows[0].user_id]);

      expect(result.rows).toHaveLength(1);

      // Clean up
      await pool.query('DELETE FROM user_identity.users WHERE user_id IN ($1, $2)', [
        userId,
        user2Result.rows[0].user_id,
      ]);
    });
  });

  // ─── AC-6: channel_identities.channel CHECK ──────────────────────────────

  describe('AC-6: channel_identities_channel_check constraint', () => {
    // Seed a shared user for all AC-6 sub-tests
    let sharedUserId: string;

    beforeAll(async () => {
      const result = await pool.query(`
        INSERT INTO user_identity.users (status) VALUES ('active') RETURNING user_id
      `);
      sharedUserId = result.rows[0].user_id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM user_identity.users WHERE user_id = $1', [
        sharedUserId,
      ]);
    });

    const validChannels = ['whatsapp', 'web', 'rn', 'swift', 'browser_extension'];

    for (const channel of validChannels) {
      it(`should accept "${channel}" as a valid channel value`, async () => {
        // AC-6: each locked enum value (Q3, 2026-04-25) must be accepted
        const uniqueId = `test_${channel}_${Date.now()}`;
        const result = await pool.query(`
          INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
          VALUES ($1, $2, $3)
          RETURNING channel
        `, [sharedUserId, channel, uniqueId]);
        expect(result.rows[0].channel).toBe(channel);
      });
    }

    it('should reject "telegram" — not in locked enum (Q3, 2026-04-25)', async () => {
      // AC-6: telegram is NOT a valid channel per locked decision
      await expect(
        pool.query(`
          INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
          VALUES ($1, 'telegram', 'tg_user_12345')
        `, [sharedUserId])
      ).rejects.toThrow(/violates check constraint/);
    });

    it('should reject "sms" — not in locked enum', async () => {
      // AC-6: boundary — an arbitrary channel value that is not in the locked set
      await expect(
        pool.query(`
          INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
          VALUES ($1, 'sms', 'sms_user_99')
        `, [sharedUserId])
      ).rejects.toThrow(/violates check constraint/);
    });

    it('channel_identities_channel_check constraint is named exactly as specified', async () => {
      // AC-6: name must match specification exactly
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND table_name = 'channel_identities'
          AND constraint_type = 'CHECK'
          AND constraint_name = 'channel_identities_channel_check'
      `);
      expect(result.rows).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Rollback suite — uses a dedicated separate container to avoid polluting the
// schema-shape suite's state. Tests AC-7 (down() + up→down→up idempotency).
// ---------------------------------------------------------------------------

describe('user_identity schema migration — rollback and idempotency (AC-7)', () => {
  it('down() drops the user_identity schema cleanly', async () => {
    // AC-7: down() reverses cleanly with IF EXISTS ... CASCADE
    //
    // Note on migrations-schema=public:
    // This rollback container uses migrations-schema=public so the pgmigrations tracking
    // table lives in public (not user_identity). This prevents "relation does not exist"
    // when node-pg-migrate tries to UPDATE pgmigrations after running down() — which drops
    // the user_identity schema (and everything inside it) with CASCADE.
    // The production ADR-018 behaviour (pgmigrations inside user_identity) is already
    // verified by the AC-1 "pgmigrations in user_identity" test in the main suite.
    //
    // TD-AUTH-002-2 FIX (2026-04-25, Jessie, BL-221):
    // With AUTH-002 (1745625600000_create-sessions-table) now present in dist/migrations/,
    // runMigrationUp applies TWO migrations (IDP-001 + AUTH-002). A single runMigrationDown
    // only undoes the most recent migration (AUTH-002 sessions table), leaving the
    // user_identity schema intact. To fully roll back to an empty state, we must call
    // runMigrationDown TWICE — once for AUTH-002, once for IDP-001.
    // Fix choice: (a) roll back both migrations — matches the test's original intent
    //             ("assert user_identity schema is gone"). See TD-AUTH-002-2 §Fix.

    const rollbackContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('rollback_test')
      .withUsername('rollback_test')
      .withPassword('rollback_test')
      .start();

    const rollbackPool = new Pool({
      connectionString: rollbackContainer.getConnectionUri(),
    });

    try {
      // UP — tracking table in public so it survives DROP SCHEMA user_identity CASCADE
      runMigrationUp(rollbackContainer.getConnectionUri(), 'public');

      // Verify schema exists after UP
      let result = await rollbackPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(result.rows).toHaveLength(1);

      // DOWN step 1: undo AUTH-002 (1745625600000_create-sessions-table)
      runMigrationDown(rollbackContainer.getConnectionUri(), 'public');
      // DOWN step 2: undo IDP-001 (1745539200000_create-user-identity-schema) — drops the schema
      runMigrationDown(rollbackContainer.getConnectionUri(), 'public');

      // Schema must be gone after both steps
      result = await rollbackPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(result.rows).toHaveLength(0);

      // Tables must be gone (schema dropped cascades)
      const tablesResult = await rollbackPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
      `);
      expect(tablesResult.rows).toHaveLength(0);
    } finally {
      await rollbackPool.end();
      await rollbackContainer.stop();
    }
  }, 120_000);

  it('up → down → up is idempotent — schema, tables, and constraints survive a full cycle', async () => {
    // AC-7: up→down→up idempotency required by spec and RFC-001 §rollback
    // Verifies IF NOT EXISTS / IF EXISTS guards work correctly on second UP.
    // See note in previous test re: migrations-schema=public for rollback containers.
    //
    // TD-AUTH-002-2 FIX (2026-04-25, Jessie, BL-221):
    // Two DOWN calls required to fully unwind IDP-001 + AUTH-002. See first AC-7 test comment.
    // After two DOWN calls, all UP migrations are re-applied with a second runMigrationUp call.
    // The test then verifies the full schema (users, channel_identities) is restored.
    // The sessions table (AUTH-002) is verified to exist after the second UP via a separate
    // table list query — ensuring both migrations re-apply cleanly.

    const idempotencyContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('idempotency_test')
      .withUsername('idempotency_test')
      .withPassword('idempotency_test')
      .start();

    const idempotencyPool = new Pool({
      connectionString: idempotencyContainer.getConnectionUri(),
    });

    try {
      // UP (first time) — tracking in public so it survives the DOWN schema drop
      runMigrationUp(idempotencyContainer.getConnectionUri(), 'public');

      // Seed data so we can confirm it is gone after DOWN
      await idempotencyPool.query(`
        INSERT INTO user_identity.users (user_id, status)
        VALUES ('a0000000-0000-0000-0000-000000000001', 'active')
      `);

      // DOWN step 1: undo AUTH-002 (sessions table)
      runMigrationDown(idempotencyContainer.getConnectionUri(), 'public');
      // DOWN step 2: undo IDP-001 (drops user_identity schema + all tables)
      runMigrationDown(idempotencyContainer.getConnectionUri(), 'public');

      // Schema dropped — seed data gone
      let schemaCheck = await idempotencyPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(schemaCheck.rows).toHaveLength(0);

      // UP again (second time — must succeed without errors; both migrations re-applied)
      runMigrationUp(idempotencyContainer.getConnectionUri(), 'public');

      // Schema must exist again
      schemaCheck = await idempotencyPool.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'user_identity'
      `);
      expect(schemaCheck.rows).toHaveLength(1);

      // All three tables (IDP-001 + AUTH-002) must exist after second UP
      const tablesResult = await idempotencyPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'user_identity'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tableNames = tablesResult.rows.map((r) => r.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('channel_identities');
      // sessions table is also restored by the second UP (AUTH-002 re-applied)
      expect(tableNames).toContain('sessions');

      // All three named IDP-001 constraints must exist on second UP
      const constraintsResult = await idempotencyPool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'user_identity'
          AND constraint_name IN (
            'users_status_check',
            'channel_identities_channel_user_unique',
            'channel_identities_channel_check'
          )
        ORDER BY constraint_name
      `);
      const constraintNames = constraintsResult.rows.map((r) => r.constraint_name);
      expect(constraintNames).toContain('users_status_check');
      expect(constraintNames).toContain('channel_identities_channel_user_unique');
      expect(constraintNames).toContain('channel_identities_channel_check');

      // Inserts work correctly after second UP — schema is fully functional
      const insertResult = await idempotencyPool.query(`
        INSERT INTO user_identity.users (status)
        VALUES ('active')
        RETURNING user_id
      `);
      expect(insertResult.rows).toHaveLength(1);
    } finally {
      await idempotencyPool.end();
      await idempotencyContainer.stop();
    }
  }, 120_000);
});
