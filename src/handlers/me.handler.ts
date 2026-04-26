/**
 * GET /auth/sessions/me handler — auth-service
 *
 * Reads req.jwtPayload (attached by createJwtAuthMiddleware) and returns
 * 200 { user_id, session_id }.
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * AC coverage:
 *   AC-D2.1  GET /auth/sessions/me with valid JWT → 200 { user_id, session_id }
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

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * GET /auth/sessions/me
 *
 * AC-D2.1: Returns 200 { user_id, session_id } when jwtPayload is present.
 * The jwt-auth middleware attaches req.jwtPayload on successful verification.
 *
 * @param req - Express request with jwtPayload attached by middleware
 * @param res - Express response
 */
export function handleGetMe(req: Request, res: Response): void {
  const payload = (req as unknown as Record<string, { sub: string; sid: string }>).jwtPayload;

  getLogger().info('GET /auth/sessions/me', {
    component: 'auth-service/me-handler',
    user_id: payload.sub,
    session_id: payload.sid,
  });

  res.status(200).json({
    user_id: payload.sub,
    session_id: payload.sid,
  });
}
