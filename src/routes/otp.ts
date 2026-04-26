/**
 * OTP Router — auth-service
 *
 * Exports createOtpRouter(otpService) → Express Router.
 * Mount at /auth: app.use('/auth', createOtpRouter(otpService))
 *
 *   POST /auth/otp/start   → handleStartOtp
 *   POST /auth/otp/verify  → handleVerifyOtp
 *
 * Story   : RAILREPAY-AUTH-003
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-25
 *
 * ADR references:
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage
 */

import { Router } from 'express';
import type { OtpService } from '../services/otp.service.js';
import { handleStartOtp, handleVerifyOtp } from '../handlers/otp.handler.js';

export function createOtpRouter(otpService: OtpService): Router {
  const router = Router();

  /**
   * POST /otp/start
   * AC-1.1: Start OTP verification for phone
   * AC-6.1: Rate limiting enforced inside OtpService (or middleware added here)
   */
  router.post('/otp/start', (req, res) => {
    void handleStartOtp(req, res, otpService);
  });

  /**
   * POST /otp/verify
   * AC-2.2: Verify OTP code and create session
   */
  router.post('/otp/verify', (req, res) => {
    void handleVerifyOtp(req, res, otpService);
  });

  return router;
}
