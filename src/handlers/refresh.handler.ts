/**
 * POST /auth/sessions/refresh handler — auth-service
 *
 * Sliding-window session refresh:
 *   1. Calls sessionRepo.touch(sid) — extends session expiry
 *   2. Mints fresh JWT via jwtService.sign — same sub/sid, fresh iat/exp
 *   3. Returns 200 { access_token, expires_in: 900 }
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * Design decisions (HUMAN-LOCKED):
 *   - Sliding-window via touch() only — same sid, fresh iat/exp
 *   - Old JWT continues to verify until its own exp (no blocklist)
 *   - expires_in is always 900 (matches JWT_ACCESS_TTL_MS default / 1000)
 *
 * AC coverage:
 *   AC-D3.1  POST /auth/sessions/refresh → touch() once, 200 { access_token, expires_in: 900 }
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

// ─── Dependency interfaces ────────────────────────────────────────────────────

export interface IJwtService {
  sign(input: { userId: string; sessionId: string }): Promise<string>;
}

export interface ISessionRepository {
  touch(sessionId: string): Promise<void>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * POST /auth/sessions/refresh
 *
 * AC-D3.1: touch() first (sliding window), then sign new JWT.
 * Returns 200 { access_token, expires_in: 900 }.
 *
 * @param req - Express request with req.jwtPayload attached by middleware
 * @param res - Express response
 * @param jwtService - Service that mints JWTs
 * @param sessionRepo - Repository that touches sessions
 */
export async function handleRefresh(
  req: Request,
  res: Response,
  jwtService: IJwtService,
  sessionRepo: ISessionRepository
): Promise<void> {
  const payload = (req as unknown as Record<string, { sub: string; sid: string }>).jwtPayload;
  const userId = payload.sub;
  const sessionId = payload.sid;

  // AC-D3.1: touch() BEFORE sign() — sliding window first
  await sessionRepo.touch(sessionId);

  const accessToken = await jwtService.sign({ userId, sessionId });

  getLogger().info('Session refreshed', {
    component: 'auth-service/refresh-handler',
    session_id: sessionId,
  });

  res.status(200).json({
    access_token: accessToken,
    expires_in: 900,
  });
}
