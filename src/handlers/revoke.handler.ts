/**
 * POST /auth/sessions/revoke handler — auth-service
 *
 * Revokes the session identified by the JWT's sid claim.
 * Returns 204 No Content on success (idempotent — second call also 204).
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * AC coverage:
 *   AC-D4.1  POST /auth/sessions/revoke with valid JWT → revoke(sid), 204
 *   AC-D4.2  Idempotent — second call also returns 204
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 */

import type { Request, Response } from 'express';
import { createLogger } from '@railrepay/winston-logger';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Dependency interface ─────────────────────────────────────────────────────

export interface ISessionRepository {
  revoke(sessionId: string): Promise<void>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * POST /auth/sessions/revoke
 *
 * AC-D4.1: Calls sessionRepo.revoke(sid) and returns 204 No Content.
 * AC-D4.2: Idempotent — repository guards with WHERE revoked_at IS NULL.
 *
 * @param req - Express request with req.jwtPayload attached by middleware
 * @param res - Express response
 * @param sessionRepo - Repository that revokes sessions
 */
export async function handleRevoke(
  req: Request,
  res: Response,
  sessionRepo: ISessionRepository
): Promise<void> {
  const payload = (req as unknown as Record<string, { sub: string; sid: string }>).jwtPayload;
  const sessionId = payload.sid;

  await sessionRepo.revoke(sessionId);

  getLogger().info('Session revoked', {
    component: 'auth-service/revoke-handler',
    session_id: sessionId,
  });

  res.status(204).end();
}
