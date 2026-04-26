/**
 * JwtService — auth-service
 *
 * Issues and verifies HS256 JWTs for session-bound access tokens.
 *
 * Story   : RAILREPAY-AUTH-004
 * Phase   : US-3 (Blake — Implementation, TDD GREEN per ADR-014)
 * Date    : 2026-04-26
 *
 * Design decisions (HUMAN-LOCKED):
 *   - Algorithm : HS256 only (RS256 post-beta via TD)
 *   - Claims    : EXACTLY { sub, sid, exp, iat, iss, aud } — no PII, no extras
 *   - TTL       : JWT_ACCESS_TTL_MS / 1000 seconds (default 900s)
 *   - secret    : hex string ≥32 chars, converted to Uint8Array via TextEncoder
 *
 * ADR references:
 *   ADR-002  — Structured logging with correlation IDs
 *   ADR-014  — TDD
 *   CLAUDE.md §8 — Mandatory shared package usage (@railrepay/winston-logger)
 */

import { SignJWT, jwtVerify } from 'jose';
import { createLogger } from '@railrepay/winston-logger';

function getLogger() {
  return createLogger({
    serviceName: 'auth-service',
    level: process.env.LOG_LEVEL || 'info',
    environment: process.env.NODE_ENV || 'development',
  });
}

// ─── Config interface ─────────────────────────────────────────────────────────

export interface JwtServiceConfig {
  /** Raw secret string (hex or any string ≥32 chars) — encoded to Uint8Array via TextEncoder */
  secret: string;
  /** JWT issuer claim (iss) */
  issuer: string;
  /** JWT audience claim (aud) */
  audience: string;
  /** Access token TTL in milliseconds */
  ttlMs: number;
}

// ─── JWT payload shape (locked) ───────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  sid: string;
  exp: number;
  iat: number;
  iss: string;
  aud: string | string[];
  [key: string]: unknown;
}

// ─── Sign input ───────────────────────────────────────────────────────────────

export interface SignInput {
  userId: string;
  sessionId: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * JwtService — issues and verifies HS256 JWTs.
 *
 * AC-D1.2: Payload is EXACTLY { sub, sid, exp, iat, iss, aud }
 * AC-D1.3: sub === userId; sid === sessionId; iss/aud from config
 * AC-D1.4: exp − iat === ttlMs / 1000; iat within 1s of server clock
 * AC-D2.3: Malformed/wrong-signature JWT → verify() throws
 * AC-D2.4: Expired JWT (exp past) → verify() throws
 */
export class JwtService {
  private readonly secretBytes: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlMs: number;

  constructor(config: JwtServiceConfig) {
    // Encode the secret string to bytes for jose
    this.secretBytes = new TextEncoder().encode(config.secret);
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.ttlMs = config.ttlMs;
  }

  /**
   * Sign a new HS256 JWT.
   *
   * AC-D1.2: Payload has EXACTLY { sub, sid, exp, iat, iss, aud }
   * AC-D1.3: sub === userId; sid === sessionId
   * AC-D1.4: exp = iat + ttlMs/1000
   *
   * @param input - { userId, sessionId }
   * @returns Signed JWT string (3-segment JWS)
   */
  async sign(input: SignInput): Promise<string> {
    const { userId, sessionId } = input;
    const ttlSeconds = Math.floor(this.ttlMs / 1000);

    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secretBytes);

    getLogger().info('JWT issued', {
      component: 'auth-service/jwt',
      session_id: sessionId,
    });

    return token;
  }

  /**
   * Verify a JWT and return its payload.
   *
   * AC-D2.3: Throws on malformed or wrong-signature token
   * AC-D2.4: Throws on expired token (exp past)
   *
   * @param token - JWT string to verify
   * @returns Verified payload { sub, sid, exp, iat, iss, aud }
   * @throws When token is invalid, expired, or has wrong signature
   */
  async verify(token: string): Promise<JwtPayload> {
    const { payload } = await jwtVerify(token, this.secretBytes, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['HS256'],
    });

    return {
      sub: payload.sub as string,
      sid: payload['sid'] as string,
      exp: payload.exp as number,
      iat: payload.iat as number,
      iss: payload.iss as string,
      aud: payload.aud as string | string[],
    };
  }
}
