# auth-service

Authentication service for RailRepay. Owns the `user_identity` PostgreSQL schema.

**Status**: Schema bootstrapped (IDP-001). Application code is BL-201.

## Schema

Schema name: `user_identity` (ADR-025 — differs from service name by design; see ADR-025 §Reasoning).

Tables created by IDP-001:
- `user_identity.users` — canonical user records, one per real-world user
- `user_identity.channel_identities` — maps user_id to per-channel external identifiers

Post-beta tables (IDP-002):
- `user_identity.sessions`
- `user_identity.claim_drafts`
- `user_identity.journey_drafts`

## Running migrations

### Development (against local or Testcontainers PG)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/railrepay
npm run migrate:up:dev
```

### Production (Railway deploy hook — compiled .cjs)

```bash
npm run build:migrations
npm run migrate:up
```

## ADR references

- ADR-001: Schema-per-service isolation
- ADR-003: node-pg-migrate as migration tool standard
- ADR-018: Per-service migration tracking (pgmigrations inside user_identity schema)
- ADR-025: Dedicated user_identity schema for identity, sessions, and drafts

## Related stories

- RAILREPAY-IDP-001 (this slice — schema only)
- BL-201 / RAILREPAY-RBP-001 (application code, endpoints)
- RAILREPAY-IDP-002 (sessions, claim_drafts, journey_drafts — post-beta)
- RAILREPAY-IDP-003 (cross-channel reconciliation with whatsapp-handler)
