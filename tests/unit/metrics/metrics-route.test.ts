/**
 * Unit Tests: auth-service /metrics endpoint
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates src/routes/metrics.ts.
 * Failure reason: "Cannot find module '../../../src/routes/metrics.js'"
 *
 * AC coverage map:
 *   AC-A3  /metrics returns Prometheus text format.
 *   AC-A3  Response includes auth_service_up gauge with value 1.
 *   AC-A3  Response includes standard Node.js process metrics (per ADR-008 + metrics-pusher).
 *   AC-A3  @railrepay/metrics-pusher is used (not prom-client directly).
 *
 * ADR references:
 *   ADR-006 — Prometheus metrics via metrics-pusher
 *   ADR-014 — TDD: tests written before implementation
 *   CLAUDE.md §8 — Mandatory shared package usage
 *
 * NOTE on env-var failure mode for AC-A3:
 * Metrics registration happens at module load time (standard prom-client / metrics-pusher
 * pattern). Blake does NOT need PORT/DATABASE_URL present to register metrics — the
 * registry is initialised statically. These unit tests therefore do not need to set
 * env vars; they just import the router and inspect output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @ts-expect-error — module does not exist yet (TDD RED phase)
import { createMetricsRouter } from '../../../src/routes/metrics.js';

// Shared logger mock (Guideline #11 — SAME instance across all tests)
const sharedLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@railrepay/winston-logger', () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

describe('RAILREPAY-AUTH-001: /metrics route (unit)', () => {
  let mockReq: { method: string; path: string };
  let mockRes: {
    status: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  let capturedMetrics: string;

  beforeEach(() => {
    capturedMetrics = '';

    mockReq = { method: 'GET', path: '/metrics' };

    // Support both res.send() and res.end() — metrics-pusher uses res.end()
    // (same pattern as whatsapp-handler/tests/unit/routes/metrics.test.ts)
    mockRes = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      send: vi.fn().mockImplementation((data: string) => {
        capturedMetrics = data;
        return mockRes;
      }),
      end: vi.fn().mockImplementation((data: string) => {
        capturedMetrics = data;
        return mockRes;
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── AC-A3: Prometheus format ─────────────────────────────────────────────

  describe('AC-A3: GET /metrics — Prometheus format', () => {
    it('AC-A3: should set Content-Type to text/plain (Prometheus scrape format)', async () => {
      // AC-A3: Prometheus scrapers require Content-Type text/plain
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(mockRes.set).toHaveBeenCalledWith(
        'Content-Type',
        expect.stringContaining('text/plain')
      );
    });

    it('AC-A3: should return non-empty metrics payload', async () => {
      // AC-A3: /metrics must produce output (not empty body)
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toBeDefined();
      expect(capturedMetrics.length).toBeGreaterThan(0);
    });

    it('AC-A3: should include Prometheus HELP and TYPE comment lines', async () => {
      // AC-A3: Prometheus text format requires # HELP and # TYPE annotations
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('# HELP');
      expect(capturedMetrics).toContain('# TYPE');
    });
  });

  // ─── AC-A3: auth_service_up gauge ────────────────────────────────────────

  describe('AC-A3: auth_service_up gauge', () => {
    it('AC-A3: should include auth_service_up in metrics output', async () => {
      // AC-A3: spec explicitly requires auth_service_up gauge
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('auth_service_up');
    });

    it('AC-A3: auth_service_up should be declared as gauge TYPE', async () => {
      // AC-A3: gauge type is required (not counter or histogram)
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('TYPE auth_service_up gauge');
    });

    it('AC-A3: auth_service_up should have value 1 when service is running', async () => {
      // AC-A3: gauge value of 1 signals "service is up" — set at startup
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      // Prometheus text format: metric_name{labels} value
      // For a gauge with no labels: auth_service_up 1
      expect(capturedMetrics).toMatch(/auth_service_up\s+1(\s|$)/m);
    });
  });

  // ─── AC-A3: Standard Node.js process metrics ─────────────────────────────

  describe('AC-A3: Standard Node.js process metrics (metrics-pusher collectDefaultMetrics)', () => {
    it('AC-A3: should include process_cpu_user_seconds_total', async () => {
      // AC-A3: standard Node.js process metrics — same set as whatsapp-handler
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('process_cpu_user_seconds_total');
    });

    it('AC-A3: should include process_resident_memory_bytes', async () => {
      // AC-A3: RSS memory metric — standard prom-client default metric
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('process_resident_memory_bytes');
    });

    it('AC-A3: should include nodejs_version_info', async () => {
      // AC-A3: Node.js version info gauge — standard prom-client default metric
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('nodejs_version_info');
    });

    it('AC-A3: should include nodejs_heap_size_total_bytes', async () => {
      // AC-A3: heap size metrics — standard prom-client default metric
      const router = createMetricsRouter();
      const handler = router.stack[0]?.route?.stack[0]?.handle;

      await handler!(mockReq, mockRes, vi.fn());

      expect(capturedMetrics).toContain('nodejs_heap_size_total_bytes');
    });
  });
});
