/**
 * Configuration module for auth-service
 *
 * Reads PORT and DATABASE_URL from environment variables.
 * Throws an Error if either required variable is absent (fail-fast per whatsapp-handler convention).
 *
 * ADR references:
 *   ADR-014 — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

export interface Config {
  port: number;
  databaseUrl: string;
}

/**
 * Load and return the service configuration from environment variables.
 * Throws an Error with a clear message if PORT or DATABASE_URL is absent.
 *
 * @returns Validated Config object
 * @throws Error when a required environment variable is missing
 */
export function getConfig(): Config {
  const portStr = process.env.PORT;
  const databaseUrl = process.env.DATABASE_URL;

  if (!portStr) {
    throw new Error(
      'auth-service: required environment variable PORT is not set'
    );
  }

  if (!databaseUrl) {
    throw new Error(
      'auth-service: required environment variable DATABASE_URL is not set'
    );
  }

  const port = parseInt(portStr, 10);

  return {
    port,
    databaseUrl,
  };
}
