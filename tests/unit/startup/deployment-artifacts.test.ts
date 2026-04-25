/**
 * Unit Tests: auth-service deployment artifact existence (AC-A4, AC-A5)
 *
 * Story   : RAILREPAY-AUTH-001
 * Phase   : US-2 (Jessie — Test Specification, TDD per ADR-014)
 * Date    : 2026-04-25
 *
 * Test Lock Rule (CLAUDE.md §6): Blake MUST NOT modify these tests.
 * If a test appears wrong, hand back to Jessie with explanation.
 *
 * These tests MUST FAIL until Blake creates Dockerfile and railway.toml.
 * Failure reason: existsSync() returns false for both files.
 *
 * AC coverage map:
 *   AC-A4  Dockerfile exists at services/auth-service/Dockerfile.
 *   AC-A4  railway.toml exists at services/auth-service/railway.toml.
 *   AC-A4  railway.toml includes healthcheck path /health.
 *   AC-A5  railway.toml references migration run as a pre-deploy step
 *          OR the migration command appears in Dockerfile or package.json scripts.
 *          Blake mirrors the whatsapp-handler / delay-tracker deployment shape.
 *
 * ADR references:
 *   ADR-014 — TDD
 *   CLAUDE.md §3.1 — Railway service creation is a human gate (Moykle Phase 5)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const SERVICE_ROOT = resolve(process.cwd());

describe('RAILREPAY-AUTH-001: deployment artifacts (AC-A4, AC-A5)', () => {
  // ─── AC-A4: Dockerfile ────────────────────────────────────────────────────

  describe('AC-A4: Dockerfile existence and content', () => {
    const dockerfilePath = resolve(SERVICE_ROOT, 'Dockerfile');

    it('AC-A4: Dockerfile must exist at services/auth-service/Dockerfile', () => {
      // AC-A4: "Dockerfile and railway.toml exist"
      expect(existsSync(dockerfilePath)).toBe(true);
    });

    it('AC-A4: Dockerfile must reference the correct Node.js base image (>=20)', () => {
      // AC-A4: Node>=20 per package.json engines field
      const content = readFileSync(dockerfilePath, 'utf-8');
      // Accepts node:20, node:20-alpine, node:20-slim, node:22, etc.
      expect(content).toMatch(/FROM node:2[0-9]/);
    });

    it('AC-A4: Dockerfile must expose PORT or CMD uses the PORT env var', () => {
      // AC-A4: container must listen on PORT (Railway injects PORT at runtime)
      const content = readFileSync(dockerfilePath, 'utf-8');
      // Either EXPOSE instruction or ENV PORT, or the CMD invokes node on src/index
      expect(content).toMatch(/EXPOSE|PORT|node.*dist\/index/);
    });
  });

  // ─── AC-A4: railway.toml ─────────────────────────────────────────────────

  describe('AC-A4: railway.toml existence and healthcheck configuration', () => {
    const railwayTomlPath = resolve(SERVICE_ROOT, 'railway.toml');

    it('AC-A4: railway.toml must exist at services/auth-service/railway.toml', () => {
      // AC-A4: "railway.toml exists"
      expect(existsSync(railwayTomlPath)).toBe(true);
    });

    it('AC-A4: railway.toml must configure healthcheck path as /health', () => {
      // AC-A4: "healthcheck path /health configured in railway.toml"
      const content = readFileSync(railwayTomlPath, 'utf-8');
      expect(content).toContain('/health');
    });

    it('AC-A4: railway.toml healthcheckPath entry should be exactly "/health"', () => {
      // AC-A4: exact path match — Railway uses healthcheckPath key
      const content = readFileSync(railwayTomlPath, 'utf-8');
      // Matches: healthcheckPath = "/health" (TOML format)
      expect(content).toMatch(/healthcheckPath\s*=\s*["']?\/health["']?/);
    });
  });

  // ─── AC-A5: migration as pre-deploy step ─────────────────────────────────

  describe('AC-A5: migration is wired as a pre-deploy step', () => {
    it('AC-A5: railway.toml must reference a migration/pre-deploy command OR Dockerfile RUN migrate', () => {
      // AC-A5: "Migration runs as a Railway pre-deploy step (mirror existing services' pattern)"
      //
      // Blake may implement this via:
      //   (a) railway.toml [deploy] section with startCommand containing migrate, OR
      //   (b) railway.toml [build] section calling npm run migrate:up, OR
      //   (c) Dockerfile RUN npm run migrate:up (less preferred — prefer pre-deploy hook)
      //
      // This test accepts any of the above approaches.
      // Moykle will decide the exact wiring at Phase US-5 (CLAUDE.md §3.1 human gate).

      const railwayTomlPath = resolve(SERVICE_ROOT, 'railway.toml');
      const dockerfilePath = resolve(SERVICE_ROOT, 'Dockerfile');

      const railwayContent = existsSync(railwayTomlPath)
        ? readFileSync(railwayTomlPath, 'utf-8')
        : '';
      const dockerfileContent = existsSync(dockerfilePath)
        ? readFileSync(dockerfilePath, 'utf-8')
        : '';

      const combinedContent = railwayContent + dockerfileContent;

      // Must mention migrate in railway.toml or Dockerfile
      expect(combinedContent).toMatch(/migrate|migration/i);
    });

    it('AC-A5: package.json must have a migrate:up script', () => {
      // AC-A5: migration script must be runnable via npm — Railway pre-deploy hooks
      // call npm run <script>. The script already exists (Hoops created it).
      const pkgPath = resolve(SERVICE_ROOT, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      expect(pkg.scripts['migrate:up']).toBeDefined();
      expect(pkg.scripts['migrate:up']).toContain('node-pg-migrate');
    });
  });
});
