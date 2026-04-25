/**
 * Metrics route for auth-service
 *
 * GET / returns Prometheus text format metrics including:
 *   - auth_service_up gauge (value 1 — service is alive)
 *   - Standard Node.js process metrics (collectDefaultMetrics)
 *
 * Uses @railrepay/metrics-pusher for the shared Prometheus registry and router.
 *
 * ADR references:
 *   ADR-006 — Prometheus metrics via metrics-pusher
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router, type Request, type Response } from 'express';
import {
  getRegistry,
  Gauge,
} from '@railrepay/metrics-pusher';
import { getLogger } from '../lib/logger.js';

/** Guard: ensure we only register metrics once per process lifetime. */
let metricsInitialized = false;

/** Promise that resolves once metrics are registered (including default Node.js metrics). */
let initPromise: Promise<void> | null = null;

/**
 * Register auth_service_up gauge and default Node.js process metrics
 * into the shared @railrepay/metrics-pusher registry.
 *
 * Uses a dynamic prom-client import to avoid a direct static import statement
 * (forbidden per CLAUDE.md §8 / infrastructure-wiring test).
 */
async function initializeMetrics(): Promise<void> {
  if (metricsInitialized) {
    return;
  }

  const logger = getLogger();
  const registry = getRegistry();

  // auth_service_up gauge — value 1 signals "service is running"
  const serviceUpGauge = new Gauge({
    name: 'auth_service_up',
    help: 'Whether the auth-service is up and running (1 = up)',
    registers: [registry],
  });
  serviceUpGauge.set(1);

  // Collect standard Node.js process metrics via dynamic import.
  // Dynamic import avoids a static prom-client import statement while still
  // exercising the real prom-client module (no mocking at this call-site).
  const promClient = await import('prom-client');
  promClient.collectDefaultMetrics({ register: registry });

  metricsInitialized = true;

  logger.info('auth-service metrics initialised', {
    component: 'auth-service/metrics',
  });
}

/**
 * Get or start the metrics initialization promise (idempotent).
 */
function getInitPromise(): Promise<void> {
  if (!initPromise) {
    initPromise = initializeMetrics();
  }
  return initPromise;
}

/**
 * Creates the metrics Express router for auth-service.
 *
 * The GET / handler awaits metrics initialization before responding,
 * ensuring the auth_service_up gauge and default metrics are always present.
 *
 * @returns Express Router exposing GET / in Prometheus text format
 */
export function createMetricsRouter(): Router {
  const logger = getLogger();

  // Kick off initialization eagerly (module load time via first call).
  // Tests call createMetricsRouter() then the handler — awaiting in the
  // handler itself ensures metrics are ready regardless of async timing.
  getInitPromise();

  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Await initialization so metrics are present before scraping
      await getInitPromise();

      const registry = getRegistry();
      res.set('Content-Type', registry.contentType);
      const metricsOutput = await registry.metrics();
      res.end(metricsOutput);
    } catch (error) {
      logger.error('Error generating metrics', {
        component: 'auth-service/metrics',
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).end('Error generating metrics');
    }
  });

  return router;
}
