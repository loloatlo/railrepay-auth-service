/**
 * auth-service — entry point
 *
 * Exports:
 *   startServer(opts?)  — creates app, listens on PORT
 *   shutdown(signal, server, pool) — graceful shutdown
 *   app                 — Express instance (set after startServer() completes)
 *
 * Top-level auto-start fires only when process.argv[1] points at this file
 * (i.e. `node dist/index.js`). When imported by Vitest tests, startServer()
 * is NOT called automatically.
 *
 * ADR references:
 *   ADR-002 — Structured logging with correlation IDs
 *   ADR-008 — Health check endpoint
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import http from 'http';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { PostgresClient } from '@railrepay/postgres-client';
import { getConfig } from './config/index.js';
import { getLogger } from './lib/logger.js';
import { createApp } from './app.js';

/** Options accepted by startServer() */
export interface StartServerOptions {
  /** When true, skip real DB connection (for unit tests) */
  skipDbConnect?: boolean;
}

/** The running Express app instance (set after startServer succeeds). */
export let app: Express | null = null;

/**
 * Start the auth-service HTTP server.
 *
 * Reads PORT and DATABASE_URL from the environment via getConfig().
 * Throws if config is missing — top-level catch calls process.exit(1).
 *
 * @param opts - Optional startup options
 */
export async function startServer(
  opts: StartServerOptions = {}
): Promise<void> {
  const logger = getLogger();
  const config = getConfig();

  let pool: Pool;

  if (opts.skipDbConnect) {
    // Construct a pg.Pool without connecting — for unit test environments.
    // We import pg via @railrepay/postgres-client's re-export to avoid
    // a direct 'pg' import violating CLAUDE.md §8.
    const pgClientModule = await import('@railrepay/postgres-client');
    pool = new pgClientModule.Pool({ connectionString: config.databaseUrl });
  } else {
    const client = new PostgresClient({
      serviceName: 'auth-service',
      schemaName: 'user_identity',
      logger,
    });
    await client.connect();
    pool = client.getPool();
  }

  const expressApp = createApp(pool);
  app = expressApp;

  await new Promise<void>((resolve) => {
    const server = http.createServer(expressApp);

    server.listen(config.port, () => {
      logger.info('auth-service started', {
        component: 'auth-service/server',
        port: config.port,
      });
      resolve();
    });

    // Register graceful shutdown signal handlers
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM', server, pool);
    });
    process.on('SIGINT', () => {
      void shutdown('SIGINT', server, pool);
    });
  });
}

/**
 * Graceful shutdown — close HTTP server then release DB pool.
 *
 * @param signal - OS signal name (e.g. 'SIGTERM', 'SIGINT')
 * @param server - HTTP server to close
 * @param pool   - PostgreSQL pool to end
 */
export async function shutdown(
  signal: string,
  server: http.Server,
  pool: Pool
): Promise<void> {
  const logger = getLogger();

  logger.info(`Received shutdown signal: ${signal}`, {
    component: 'auth-service/server',
    signal,
  });

  // Close HTTP server — stop accepting new connections
  await new Promise<void>((resolve) => {
    server.close(() => {
      logger.info('HTTP server closed', {
        component: 'auth-service/server',
      });
      resolve();
    });
  });

  // Release database pool
  await pool.end();

  logger.info('Database pool closed', {
    component: 'auth-service/server',
  });
}

// ── Auto-start when run as main entry point ──────────────────────────────────
// process.argv[1] is the script path when running `node dist/index.js`.
// Vitest runner sets argv[1] to its own binary, not to our index file,
// so this guard prevents accidental startup during tests.
const argv1 = process.argv[1] ?? '';
const isMain = argv1.endsWith('index.js') || argv1.endsWith('index.ts');

if (isMain) {
  startServer().catch((error: unknown) => {
    const logger = getLogger();
    logger.error('Fatal startup error', {
      component: 'auth-service/server',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
