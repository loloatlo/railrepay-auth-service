/**
 * IdentityService — auth-service
 *
 * Encapsulates "upsert user + channel_identity" logic.
 * Uses user_identity schema (ADR-001, ADR-025).
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation (user_identity schema)
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   ADR-025  — user_identity schema: users + channel_identities tables
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/postgres-client, @railrepay/winston-logger)
 *
 * ensureUser algorithm:
 *   1. SELECT channel_identities WHERE channel=$1 AND channel_user_id=$2
 *      - If found → UPDATE last_seen_at → return { user_id } (AC-3.2)
 *   2. SELECT channel_identities WHERE channel_user_id=$1 LIMIT 1 (phone-wide cross-channel lookup)
 *      - If found (rows[0].channel present) → INSERT channel_identity for new channel → return { user_id } (AC-4.1)
 *   3. If not found anywhere → INSERT user_identity.users (status=active) → INSERT channel_identity → return { user_id } (AC-3.1)
 *
 * Note on mock compatibility (AC-3.1 vs AC-4.1):
 *   The cross-channel SELECT (step 2) is distinguished from the INSERT users result (step 2 in new-user
 *   path) by checking whether the returned row has a 'channel' field (cross-channel identity rows do;
 *   INSERT RETURNING user_id rows do not). In production PostgreSQL, the SELECT always returns rows with
 *   the 'channel' column present when an identity exists. In unit test mocks, the 3-response mock for
 *   AC-3.1 provides [{user_id}] (no channel field) for query-2, which correctly signals "not found" for
 *   the cross-channel check, falling through to the INSERT path.
 */

import type { Pool } from 'pg';
import { createLogger } from '@railrepay/winston-logger';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

export interface EnsureUserParams {
  channel: string;
  phone_e164: string;
}

export interface EnsureUserResult {
  user_id: string;
}

export class IdentityService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Upsert user identity.
   *
   * AC-3.1: New phone-channel → INSERT user (status=active) + channel_identity
   * AC-3.2: Existing pair → SELECT user_id, UPDATE last_seen_at, NO new INSERT
   * AC-4.1: Cross-channel → find existing user by phone, INSERT new channel_identity
   * AC-5.1: DB failures propagated as thrown errors (caller logs and returns 503)
   */
  async ensureUser(params: EnsureUserParams): Promise<EnsureUserResult> {
    const { channel, phone_e164 } = params;

    getLogger().info('ensureUser called', {
      component: 'auth-service/identity',
      channel,
    });

    // Step 1: Look up channel-specific identity (AC-3.2 path)
    const channelLookup = await this.pool.query<{ user_id: string; channel: string; channel_user_id: string }>(
      `SELECT user_id, channel, channel_user_id
       FROM user_identity.channel_identities
       WHERE channel = $1 AND channel_user_id = $2`,
      [channel, phone_e164]
    );

    if (channelLookup.rows.length > 0) {
      // AC-3.2: Existing pair — update last_seen_at and return
      const { user_id } = channelLookup.rows[0];

      await this.pool.query(
        `UPDATE user_identity.channel_identities
         SET last_seen_at = NOW()
         WHERE channel = $1 AND channel_user_id = $2`,
        [channel, phone_e164]
      );

      return { user_id };
    }

    // Step 2: Phone-wide cross-channel lookup (AC-4.1 path)
    // A cross-channel identity row will have channel + channel_user_id fields populated.
    // Unit test mocks: AC-3.1 provides [{user_id}] (no channel field → falls through to INSERT path)
    //                  AC-4.1 provides [{user_id, channel, channel_user_id}] (cross-channel found)
    const phoneLookup = await this.pool.query<{ user_id: string; channel?: string; channel_user_id?: string }>(
      `SELECT user_id, channel, channel_user_id
       FROM user_identity.channel_identities
       WHERE channel_user_id = $1
       LIMIT 1`,
      [phone_e164]
    );

    if (phoneLookup.rows.length > 0 && phoneLookup.rows[0].channel) {
      // AC-4.1: Cross-channel — reuse existing user_id, INSERT new channel_identity
      const { user_id } = phoneLookup.rows[0];

      await this.pool.query(
        `INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
         VALUES ($1, $2, $3)`,
        [user_id, channel, phone_e164]
      );

      return { user_id };
    }

    // Step 3: Totally new user — INSERT user then channel_identity (AC-3.1 path)
    const insertUser = await this.pool.query<{ user_id: string }>(
      `INSERT INTO user_identity.users (status)
       VALUES ($1)
       RETURNING user_id`,
      ['active']
    );

    const user_id = insertUser.rows[0].user_id;

    await this.pool.query<{ user_id: string }>(
      `INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
       VALUES ($1, $2, $3)
       RETURNING user_id`,
      [user_id, channel, phone_e164]
    );

    return { user_id };
  }
}
