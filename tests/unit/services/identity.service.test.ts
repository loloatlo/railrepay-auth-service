/**
 * Unit Tests: IdentityService (AUTH-003)
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, Blake hands back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates:
 *   src/services/identity.service.ts
 * Expected failure mode: "Cannot find module '../../../src/services/identity.service.js'"
 *
 * IdentityService encapsulates the "upsert user + channel_identity" logic.
 * It receives a mocked pg Pool — no real DB required in unit tests.
 *
 * AC coverage map:
 *   AC-3.1  New phone-channel pair: INSERTs user (status=active) + channel_identity row; returns new user_id
 *   AC-3.2  Existing pair: SELECTs existing user_id; updates last_seen_at; NO new user INSERT
 *   AC-4.1  Cross-channel: pre-existing whatsapp identity → web channel upsert reuses user_X; INSERTs second channel_identities row
 *   AC-5.1  DB failures are propagated as thrown errors (caught upstream by OtpService, which logs + returns 503)
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation (user_identity schema)
 *   ADR-014  — TDD
 *   ADR-017  — Jessie owns fixtures
 *   ADR-025  — user_identity schema: users + channel_identities tables
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryResult } from 'pg';

// ─── Shared logger mock (Guideline #11) ──────────────────────────────────────
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

// ─── Module under test ───────────────────────────────────────────────────────
// @ts-expect-error — module does not exist yet (TDD RED phase per ADR-014)
import { IdentityService } from '../../../src/services/identity.service.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────────
// ADR-017: fixtures use real-shaped data, not fabricated placeholder UUIDs.
// All UUIDs use v4 format (4xxx-[89ab]xxx) as per gen_random_uuid() output.

/** Valid user_id UUID for a "new user" scenario (AC-3.1) */
const NEW_USER_ID = 'c1a2b3c4-0000-4000-8000-000000000011';
/** Valid user_id UUID for an "existing user" scenario (AC-3.2) */
const EXISTING_USER_ID = 'c1a2b3c4-0000-4000-8000-000000000012';
/** Valid user_id UUID shared across channels for cross-channel test (AC-4.1) */
const CROSS_CHANNEL_USER_ID = 'c1a2b3c4-0000-4000-8000-000000000013';

// Phone series — unique per test to avoid shared-state interference (Guideline #6)
const PHONE_NEW = '+447700900030';           // AC-3.1 new pair
const PHONE_EXISTING = '+447700900031';      // AC-3.2 existing pair
const PHONE_CROSS_CHANNEL = '+447700900032'; // AC-4.1 cross-channel

function makeQueryResult<T extends object>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: rows.length ? 'SELECT' : 'SELECT',
    fields: [],
    oid: 0,
  } as unknown as QueryResult<T>;
}

/** Build a mock Pool where query() can return sequenced results */
function makePool(
  queryResponses: Array<QueryResult<Record<string, unknown>>>
): import('pg').Pool {
  let callIndex = 0;
  return {
    query: vi.fn().mockImplementation(() => {
      const response = queryResponses[callIndex] ?? queryResponses[queryResponses.length - 1];
      callIndex++;
      return Promise.resolve(response);
    }),
  } as unknown as import('pg').Pool;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RAILREPAY-AUTH-003: IdentityService unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedLogger.child.mockReturnThis();
  });

  describe('constructor', () => {
    it('can be instantiated with a pg Pool', () => {
      const pool = makePool([]);
      expect(() => new IdentityService(pool)).not.toThrow();
    });
  });

  // ─── AC-3.1: New phone-channel pair ──────────────────────────────────────

  describe('AC-3.1: ensureUser() — new phone-channel pair', () => {
    it('AC-3.1: should return a user_id (UUID format) for a new phone+channel', async () => {
      // AC-3.1: first-time registration creates a new user_id
      // Query sequence: [1] no existing identity → [2] insert user → [3] insert channel_identity
      const noExistingRow = makeQueryResult([]);
      const insertedUser = makeQueryResult([{ user_id: NEW_USER_ID }]);
      const insertedIdentity = makeQueryResult([{ user_id: NEW_USER_ID }]);

      const pool = makePool([noExistingRow, insertedUser, insertedIdentity]);
      const service = new IdentityService(pool);

      const result = await service.ensureUser({
        channel: 'web',
        phone_e164: PHONE_NEW,
      });

      // Must return a UUID v4 shaped value
      expect(result.user_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('AC-3.1: should target user_identity.users for the INSERT', async () => {
      // AC-3.1: INSERT must go to user_identity.users (ADR-025)
      const noExistingRow = makeQueryResult([]);
      const insertedUser = makeQueryResult([{ user_id: NEW_USER_ID }]);
      const insertedIdentity = makeQueryResult([{ user_id: NEW_USER_ID }]);

      const pool = makePool([noExistingRow, insertedUser, insertedIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_NEW });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const sqlStatements = calls.map(([sql]) => sql.toLowerCase());
      // At least one INSERT INTO user_identity.users
      expect(
        sqlStatements.some((sql) => sql.includes('insert') && sql.includes('user_identity.users'))
      ).toBe(true);
    });

    it('AC-3.1: should INSERT user with status=active', async () => {
      // AC-3.1: new users created with status='active'
      const noExistingRow = makeQueryResult([]);
      const insertedUser = makeQueryResult([{ user_id: NEW_USER_ID }]);
      const insertedIdentity = makeQueryResult([{ user_id: NEW_USER_ID }]);

      const pool = makePool([noExistingRow, insertedUser, insertedIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_NEW });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const allParams = calls.flatMap(([, params]) => params ?? []);
      // 'active' must be passed as a parameterised value
      expect(allParams).toContain('active');
    });

    it('AC-3.1: should INSERT into user_identity.channel_identities for the new pair', async () => {
      // AC-3.1: "a corresponding row in user_identity.channel_identities (channel, channel_user_id=phone_e164, user_id=fk)"
      const noExistingRow = makeQueryResult([]);
      const insertedUser = makeQueryResult([{ user_id: NEW_USER_ID }]);
      const insertedIdentity = makeQueryResult([{ user_id: NEW_USER_ID }]);

      const pool = makePool([noExistingRow, insertedUser, insertedIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_NEW });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const sqlStatements = calls.map(([sql]) => sql.toLowerCase());
      expect(
        sqlStatements.some(
          (sql) => sql.includes('insert') && sql.includes('channel_identities')
        )
      ).toBe(true);
    });

    it('AC-3.1: channel_identities INSERT must pass channel and phone as parameterised values', async () => {
      // AC-3.1: no raw string concatenation (SQL injection prevention)
      const noExistingRow = makeQueryResult([]);
      const insertedUser = makeQueryResult([{ user_id: NEW_USER_ID }]);
      const insertedIdentity = makeQueryResult([{ user_id: NEW_USER_ID }]);

      const pool = makePool([noExistingRow, insertedUser, insertedIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_NEW });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const allParams = calls.flatMap(([, params]) => params ?? []);
      expect(allParams).toContain('web');
      expect(allParams).toContain(PHONE_NEW);
    });
  });

  // ─── AC-3.2: Existing phone-channel pair ─────────────────────────────────

  describe('AC-3.2: ensureUser() — existing phone-channel pair', () => {
    it('AC-3.2: should return the existing user_id without creating a new user', async () => {
      // AC-3.2: "Existing pair: SELECTs existing user_id, NO new user inserted"
      // Query sequence: [1] found existing identity → [2] update last_seen_at
      const existingRow = makeQueryResult([{
        user_id: EXISTING_USER_ID,
        channel: 'whatsapp',
        channel_user_id: PHONE_EXISTING,
      }]);
      const updateResult = makeQueryResult([]);

      const pool = makePool([existingRow, updateResult]);
      const service = new IdentityService(pool);

      const result = await service.ensureUser({
        channel: 'whatsapp',
        phone_e164: PHONE_EXISTING,
      });

      expect(result.user_id).toBe(EXISTING_USER_ID);
    });

    it('AC-3.2: should NOT INSERT a new users row when identity already exists', async () => {
      // AC-3.2: existing user → no INSERT INTO user_identity.users
      const existingRow = makeQueryResult([{
        user_id: EXISTING_USER_ID,
        channel: 'whatsapp',
        channel_user_id: PHONE_EXISTING,
      }]);
      const updateResult = makeQueryResult([]);

      const pool = makePool([existingRow, updateResult]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'whatsapp', phone_e164: PHONE_EXISTING });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const insertCalls = calls.filter(
        ([sql]) => sql.toUpperCase().startsWith('INSERT') && sql.toLowerCase().includes('users')
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('AC-3.2: should update last_seen_at for the existing identity', async () => {
      // AC-3.2: "last_seen_at updated to NOW()" on re-use
      const existingRow = makeQueryResult([{
        user_id: EXISTING_USER_ID,
        channel: 'web',
        channel_user_id: PHONE_EXISTING,
      }]);
      const updateResult = makeQueryResult([]);

      const pool = makePool([existingRow, updateResult]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_EXISTING });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const sqlStatements = calls.map(([sql]) => sql.toLowerCase());
      expect(
        sqlStatements.some(
          (sql) => sql.includes('last_seen_at') && (sql.includes('update') || sql.includes('set'))
        )
      ).toBe(true);
    });
  });

  // ─── AC-4.1: Cross-channel identity coexistence ──────────────────────────

  describe('AC-4.1: cross-channel identity coexistence', () => {
    it('AC-4.1: should reuse existing user_id when adding a second channel for the same phone', async () => {
      // AC-4.1: pre-seeded (whatsapp, PHONE_CROSS_CHANNEL, CROSS_CHANNEL_USER_ID)
      // Call: ensureUser({ channel: 'web', phone_e164: PHONE_CROSS_CHANNEL })
      // Expectation: returns CROSS_CHANNEL_USER_ID (same user, different channel)
      //
      // Lookup sequence: SELECT on (channel=whatsapp) → no row (web-channel lookup)
      //   → fallback lookup by phone across all channels → find existing whatsapp user
      //   → INSERT channel_identity for (web, PHONE_CROSS_CHANNEL, CROSS_CHANNEL_USER_ID)
      //
      // NOTE for Blake: implementation may do a phone-wide lookup first OR a channel-specific
      // lookup first. Either approach is acceptable as long as the result is correct.
      // The critical invariant: user_id returned MUST equal CROSS_CHANNEL_USER_ID.
      const webChannelLookup = makeQueryResult([]);
      const phoneLookup = makeQueryResult([{
        user_id: CROSS_CHANNEL_USER_ID,
        channel: 'whatsapp',
        channel_user_id: PHONE_CROSS_CHANNEL,
      }]);
      const insertIdentity = makeQueryResult([{ user_id: CROSS_CHANNEL_USER_ID }]);

      const pool = makePool([webChannelLookup, phoneLookup, insertIdentity]);
      const service = new IdentityService(pool);

      const result = await service.ensureUser({
        channel: 'web',
        phone_e164: PHONE_CROSS_CHANNEL,
      });

      expect(result.user_id).toBe(CROSS_CHANNEL_USER_ID);
    });

    it('AC-4.1: should INSERT a second channel_identities row for the new channel', async () => {
      // AC-4.1: "INSERTs second channel_identities row for (web, +447700900032)"
      const webChannelLookup = makeQueryResult([]);
      const phoneLookup = makeQueryResult([{
        user_id: CROSS_CHANNEL_USER_ID,
        channel: 'whatsapp',
        channel_user_id: PHONE_CROSS_CHANNEL,
      }]);
      const insertIdentity = makeQueryResult([{ user_id: CROSS_CHANNEL_USER_ID }]);

      const pool = makePool([webChannelLookup, phoneLookup, insertIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_CROSS_CHANNEL });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const sqlStatements = calls.map(([sql]) => sql.toLowerCase());
      // Must INSERT into channel_identities for the new (web) channel
      expect(
        sqlStatements.some(
          (sql) => sql.includes('insert') && sql.includes('channel_identities')
        )
      ).toBe(true);
    });

    it('AC-4.1: should NOT INSERT a new users row when user already exists cross-channel', async () => {
      // AC-4.1: the user already exists — only a new channel_identity is inserted, not a new user
      const webChannelLookup = makeQueryResult([]);
      const phoneLookup = makeQueryResult([{
        user_id: CROSS_CHANNEL_USER_ID,
        channel: 'whatsapp',
        channel_user_id: PHONE_CROSS_CHANNEL,
      }]);
      const insertIdentity = makeQueryResult([{ user_id: CROSS_CHANNEL_USER_ID }]);

      const pool = makePool([webChannelLookup, phoneLookup, insertIdentity]);
      const service = new IdentityService(pool);

      await service.ensureUser({ channel: 'web', phone_e164: PHONE_CROSS_CHANNEL });

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
      const insertUserCalls = calls.filter(
        ([sql]) => sql.toUpperCase().includes('INSERT') && sql.toLowerCase().includes('user_identity.users')
      );
      expect(insertUserCalls).toHaveLength(0);
    });
  });

  // ─── AC-5.1: DB error propagation ────────────────────────────────────────

  describe('AC-5.1: DB error propagation', () => {
    it('AC-5.1: should throw when pool.query fails (caller logs and returns 503)', async () => {
      // AC-5.1: IdentityService propagates DB errors upward — OtpService catches and logs
      const pool = {
        query: vi.fn().mockRejectedValue(new Error('connection lost')),
      } as unknown as import('pg').Pool;
      const service = new IdentityService(pool);

      await expect(
        service.ensureUser({ channel: 'web', phone_e164: '+447700900040' })
      ).rejects.toThrow();
    });
  });
});
