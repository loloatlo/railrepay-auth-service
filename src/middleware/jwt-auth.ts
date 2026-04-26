/**
 * JWT Authentication Middleware — auth-service
 *
 * createJwtAuthMiddleware(jwtService, sessionRepo) — Express middleware factory.
 * Extracts Bearer token, verifies via jwtService, checks session is active in DB,
 * attaches req.jwtPayload on success, returns 401 { error: 'unauthorized' } on failure.
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * AC coverage:
 *   AC-D2.2  No Authorization header → 401 { error: 'unauthorized' }
 *   AC-D2.3  Malformed/wrong-signature JWT → 401 { error: 'unauthorized' }
 *   AC-D2.4  Expired JWT → 401 { error: 'unauthorized' }
 *   AC-D2.5  Valid JWT but session revoked (findActive returns null) → 401
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@railrepay/winston-logger';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Dependency interfaces (interface-based mocking per Guideline #3) ─────────

export interface IJwtService {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface ISessionRepository {
  findActive(sessionId: string): Promise<object | null>;
}

// ─── Middleware options ───────────────────────────────────────────────────────

export interface JwtAuthMiddlewareOptions {
  /**
   * When true, skip the sessionRepo.findActive() check.
   * Use for endpoints where a revoked session's JWT is still valid (e.g. revoke itself).
   * Default: false (full session liveness check enabled).
   */
  skipSessionCheck?: boolean;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Create a JWT authentication middleware.
 *
 * Extracts the Bearer token from the Authorization header, verifies it with
 * jwtService, and optionally checks the session is still active in the database.
 * On success, attaches the decoded payload as req.jwtPayload.
 * On any failure, returns 401 { error: 'unauthorized' }.
 *
 * @param jwtService - Service that verifies JWT tokens
 * @param sessionRepo - Repository that checks if a session is active
 * @param options - { skipSessionCheck: boolean } — skip findActive for revoke route
 * @returns Express middleware
 */
export function createJwtAuthMiddleware(
  jwtService: IJwtService,
  sessionRepo: ISessionRepository,
  options: JwtAuthMiddlewareOptions = {}
) {
  const { skipSessionCheck = false } = options;

  return async function jwtAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    // AC-D2.2: No Authorization header or non-Bearer prefix → 401
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      getLogger().warn('JWT auth: missing or non-Bearer Authorization header', {
        component: 'auth-service/jwt-auth',
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = authHeader.slice('Bearer '.length);

    let payload: Record<string, unknown>;
    try {
      // AC-D2.3: malformed/wrong-signature → throws
      // AC-D2.4: expired → throws
      payload = await jwtService.verify(token);
    } catch (err) {
      getLogger().warn('JWT auth: token verification failed', {
        component: 'auth-service/jwt-auth',
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!skipSessionCheck) {
      const sid = payload['sid'] as string;

      // AC-D2.5: valid signature but session revoked → findActive returns null
      const session = await sessionRepo.findActive(sid);
      if (session === null) {
        getLogger().warn('JWT auth: session not found or revoked', {
          component: 'auth-service/jwt-auth',
          session_id: sid,
        });
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }

    // Attach payload for downstream handlers
    (req as unknown as Record<string, unknown>).jwtPayload = payload;
    next();
  };
}
