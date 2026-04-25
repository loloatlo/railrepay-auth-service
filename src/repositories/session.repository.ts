/**
 * SessionRepository — auth-service
 *
 * Owns all CRUD operations on user_identity.sessions.
 *
 * Story   : RAILREPAY-AUTH-002
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * ADR references:
 *   ADR-001  — schema-per-service isolation (sessions in user_identity schema)
 *   ADR-002  — structured logging with correlation IDs
 *   ADR-014  — TDD: tests written before implementation
 *   ADR-025  — user_identity schema, owned by auth-service
 *   DR-UC-002 — auth-service owns session issuance for all channels
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/postgres-client)
 *
 * Design decisions:
 *   - Pool type from @railrepay/postgres-client (not raw pg) — AC-E.1 / AC-E.2
 *   - expires_at is app-computed (not DB default) — Q-AUTH-002-2, RFC-002 §Column Design
 *   - revoke() guards with WHERE revoked_at IS NULL for idempotency — AC-B3.1
 *   - touch() guards with WHERE revoked_at IS NULL AND expires_at > NOW() — AC-B4.1
 *   - Input validation fires BEFORE SQL — AC-B2.1 edge cases
 */

import type { Pool } from '@railrepay/postgres-client';
import { validate as isUuid } from 'uuid';

// ─── Constants ────────────────────────────────────────────────────────────────

/** 30-day session TTL in milliseconds — Q-AUTH-002-2, BL-201 §Decisions */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Valid channel enum — Q-AUTH-002-1, locked 2026-04-25 */
const VALID_CHANNELS = new Set(['whatsapp', 'web', 'rn', 'swift', 'browser_extension']);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  session_id: string;
  user_id: string;
  channel: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface CreateSessionParams {
  user_id: string;
  channel: string;
}

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * SessionRepository
 *
 * Constructor-injected with a pg Pool (from @railrepay/postgres-client).
 * All methods use parameterised queries — no raw string concatenation.
 */
export class SessionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Create a new session record.
   *
   * AC-B2.1: Inserts with computed expires_at = NOW() + SESSION_TTL_MS.
   * Validates user_id (UUID) and channel (enum) before SQL — rejects early.
   *
   * @param params - { user_id, channel }
   * @returns The inserted session record (from RETURNING clause)
   */
  async create(params: CreateSessionParams): Promise<SessionRecord> {
    const { user_id, channel } = params;

    // Input validation: fires BEFORE SQL (AC-B2.1 edge cases)
    if (!user_id || !isUuid(user_id)) {
      throw new Error(`Invalid user_id: "${user_id}" is not a valid UUID`);
    }
    if (!channel || !VALID_CHANNELS.has(channel)) {
      throw new Error(
        `Invalid channel: "${channel}" is not in the allowed set [${[...VALID_CHANNELS].join(', ')}]`
      );
    }

    // App-computes expires_at — no DB default (Q-AUTH-002-2)
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const result = await this.pool.query<SessionRecord>(
      `INSERT INTO user_identity.sessions (user_id, channel, expires_at)
       VALUES ($1, $2, $3)
       RETURNING session_id, user_id, channel, issued_at, expires_at, revoked_at`,
      [user_id, channel, expiresAt]
    );

    return result.rows[0];
  }

  /**
   * Find an active session by session_id.
   *
   * AC-B2.2: Returns the row when active (revoked_at IS NULL AND expires_at > NOW()).
   * Returns null when revoked, expired, or non-existent.
   *
   * @param session_id - UUID of the session
   * @returns SessionRecord or null
   */
  async findActive(session_id: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRecord>(
      `SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
       FROM user_identity.sessions
       WHERE session_id = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [session_id]
    );

    return result.rows[0] ?? null;
  }

  /**
   * Revoke a session (set revoked_at = NOW()).
   *
   * AC-B3.1: Idempotent — WHERE revoked_at IS NULL ensures second call is a no-op.
   * Does not throw if session does not exist (rowCount = 0).
   *
   * @param session_id - UUID of the session to revoke
   */
  async revoke(session_id: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_identity.sessions
       SET revoked_at = NOW()
       WHERE session_id = $1
         AND revoked_at IS NULL`,
      [session_id]
    );
  }

  /**
   * Extend an active session's expiry (sliding refresh).
   *
   * AC-B4.1: Only updates when session is active (revoked_at IS NULL AND expires_at > NOW()).
   * No-op for revoked or expired sessions. Does not throw on no-op.
   *
   * @param session_id - UUID of the session to refresh
   */
  async touch(session_id: string): Promise<void> {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.pool.query(
      `UPDATE user_identity.sessions
       SET expires_at = $2
       WHERE session_id = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [session_id, newExpiresAt]
    );
  }
}
