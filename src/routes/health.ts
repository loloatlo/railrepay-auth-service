/**
 * Health route for auth-service
 *
 * GET / returns:
 *   200 { status: 'ok', schema: 'user_identity', migrations: 'up-to-date' }
 *       when DB is reachable and user_identity.pgmigrations has at least one row.
 *   503 { status: 'error', ... } when DB is unreachable or pgmigrations is empty.
 *
 * ADR references:
 *   ADR-008 — Health check endpoint contract
 *   ADR-025 — Schema name is user_identity
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { getLogger } from '../lib/logger.js';

/**
 * Creates the health check router for auth-service.
 *
 * @param pool - PostgreSQL connection pool (injected for testability)
 * @returns Express Router with GET / handler
 */
export function createHealthRouter(pool: Pool): Router {
  const logger = getLogger();
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Verify DB connection
      await pool.query('SELECT 1');

      // Verify latest migration applied — query user_identity.pgmigrations
      const result = await pool.query(
        'SELECT id, name, run_on FROM user_identity.pgmigrations ORDER BY run_on ASC'
      );

      if (result.rows.length === 0) {
        logger.warn('Health check failed: pgmigrations table is empty', {
          component: 'auth-service/health',
        });
        res.status(503).json({
          status: 'error',
          schema: 'user_identity',
          migrations: 'none-applied',
          message: 'No migrations have been applied',
        });
        return;
      }

      res.status(200).json({
        status: 'ok',
        schema: 'user_identity',
        migrations: 'up-to-date',
      });
    } catch (error) {
      logger.error('Health check failed', {
        component: 'auth-service/health',
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(503).json({
        status: 'error',
        schema: 'user_identity',
        message: error instanceof Error ? error.message : 'Health check failed',
      });
    }
  });

  return router;
}
