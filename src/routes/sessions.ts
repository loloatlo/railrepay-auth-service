/**
 * Sessions Router — auth-service
 *
 * Exports createSessionsRouter(jwtService, sessionRepo) → Express Router.
 * Mount at /auth/sessions: app.use('/auth/sessions', createSessionsRouter(...))
 *
 *   GET  /auth/sessions/me      — handleGetMe (jwt-auth protected)
 *   POST /auth/sessions/refresh — handleRefresh (jwt-auth protected)
 *   POST /auth/sessions/revoke  — handleRevoke (jwt-auth protected)
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * Design decisions (HUMAN-LOCKED):
 *   - Auth middleware mounted per-route only (NOT globally)
 *   - No CORS middleware (server-to-server only per OQ-4)
 *
 * ADR references:
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router } from 'express';
import { createJwtAuthMiddleware } from '../middleware/jwt-auth.js';
import { handleGetMe } from '../handlers/me.handler.js';
import { handleRefresh } from '../handlers/refresh.handler.js';
import { handleRevoke } from '../handlers/revoke.handler.js';
import type { JwtService } from '../jwt/jwt.service.js';
import type { SessionRepository } from '../repositories/session.repository.js';

/**
 * Create the sessions router with JWT auth middleware applied per-route.
 *
 * @param jwtService - JwtService instance for token verification and signing
 * @param sessionRepo - SessionRepository instance for session DB operations
 * @returns Express Router mounted at /auth/sessions
 */
export function createSessionsRouter(
  jwtService: JwtService,
  sessionRepo: SessionRepository
): Router {
  const router = Router();

  // Per-route jwt-auth middleware (not global — HUMAN-LOCKED decision)
  const jwtAuth = createJwtAuthMiddleware(jwtService, sessionRepo);

  // Signature-only middleware for revoke: verifies JWT signature but skips
  // session liveness check so a revoked session can still be re-revoked (AC-D4.2 idempotency).
  const jwtAuthSignatureOnly = createJwtAuthMiddleware(jwtService, sessionRepo, {
    skipSessionCheck: true,
  });

  /**
   * GET /me
   * AC-D2.1: Returns 200 { user_id, session_id } when JWT is valid and session active
   */
  router.get('/me', jwtAuth, (req, res) => {
    handleGetMe(req, res);
  });

  /**
   * POST /refresh
   * AC-D3.1: touch() + new JWT, returns 200 { access_token, expires_in: 900 }
   */
  router.post('/refresh', jwtAuth, (req, res) => {
    void handleRefresh(req, res, jwtService, sessionRepo);
  });

  /**
   * POST /revoke
   * AC-D4.1: revoke(sid), returns 204
   * AC-D4.2: Idempotent — uses signature-only middleware so revoked JWT still works
   */
  router.post('/revoke', jwtAuthSignatureOnly, (req, res) => {
    void handleRevoke(req, res, sessionRepo);
  });

  return router;
}
