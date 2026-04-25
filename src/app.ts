/**
 * Express application factory for auth-service
 *
 * createApp(pool) creates the Express app, mounts routes, and returns it
 * WITHOUT calling .listen() — enabling testability (tests call .listen() directly).
 *
 * ADR references:
 *   ADR-008 — Health check endpoint
 *   ADR-014 — TDD / testable app factory pattern
 *   CLAUDE.md §8 — Mandatory shared package usage
 *
 * AC-WIRE.1 (AUTH-002): SessionRepository is constructed here with the injected pool
 *   and exposed via app.locals.sessionRepository for route handlers to consume.
 */

import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { createHealthRouter } from './routes/health.js';
import { createMetricsRouter } from './routes/metrics.js';
import { getLogger } from './lib/logger.js';
import { SessionRepository } from './repositories/session.repository.js';

/**
 * Create and configure the auth-service Express application.
 *
 * @param pool - PostgreSQL connection pool (injected for testability)
 * @returns Configured Express application (not yet listening)
 */
export function createApp(pool: Pool): Express {
  const app = express();
  const logger = getLogger();

  // AC-WIRE.1 (AUTH-002): wire SessionRepository on app.locals for route handlers
  app.locals.sessionRepository = new SessionRepository(pool);

  // Trust proxy headers — required for Railway/proxy environments (ADR note)
  app.set('trust proxy', true);

  // Standard middleware
  app.use(express.json());

  // Request logging middleware (ADR-002: structured logging)
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`, {
      component: 'auth-service/http',
      method: req.method,
      path: req.path,
    });
    next();
  });

  // Health check route (ADR-008)
  app.use('/health', createHealthRouter(pool));

  // Metrics route (ADR-006)
  app.use('/metrics', createMetricsRouter());

  return app;
}
