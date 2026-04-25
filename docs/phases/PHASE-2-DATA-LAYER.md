# PHASE-2-DATA-LAYER: auth-service / user_identity Schema

**Workflow**: New-Service Phase 2 (Data Layer)  
**BL item**: BL-207 (Identity foundation: user_id + channel_identities schema)  
**Story**: RAILREPAY-IDP-001  
**Completed**: 2026-04-25  
**Agent**: Hoops (Data Architect)  

---

## Summary

Phase 2 bootstraps the `user_identity` schema owned by `auth-service`. This is a pure
data-layer slice — no application code is included. Application code (endpoints, handlers)
is BL-201.

The schema was renamed from `auth_service` to `user_identity` per ADR-025 (accepted
2026-04-25). The naming asymmetry between service (`auth-service`) and schema
(`user_identity`) is deliberate and documented in ADR-025 §Reasoning.

---

## Deliverables

| File | Description |
|------|-------------|
| `services/auth-service/package.json` | Service package with node-pg-migrate, @railrepay shared libs, Vitest |
| `services/auth-service/tsconfig.json` | Application TypeScript config (src → dist, ESM) |
| `services/auth-service/tsconfig.migrations.json` | Migration TypeScript config (migrations → dist/migrations, CommonJS) |
| `services/auth-service/.migrationrc.json` | node-pg-migrate config: schema=user_identity, table=pgmigrations |
| `services/auth-service/migrations/1745539200000_create-user-identity-schema.ts` | Migration: CREATE SCHEMA, users, channel_identities, constraints, indexes |
| `services/auth-service/docs/design/RFC-001-user-identity-schema.md` | RFC with rationale, SQL, rollback plan, fixture data samples |
| `services/auth-service/docs/phases/PHASE-2-DATA-LAYER.md` | This file |
| `services/auth-service/README.md` | Service README |

---

## Schema Design

### user_identity.users

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `user_id` | UUID | PK, NOT NULL, DEFAULT gen_random_uuid() | AC-1 |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | AC-1 |
| `status` | VARCHAR(20) | NOT NULL, CHECK IN ('active','suspended','deleted') | AC-1, AC-3 (Q2 locked) |

Supporting index: `idx_users_status` on `(status)` — serves admin/data-retention queries.

### user_identity.channel_identities

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `user_id` | UUID | NOT NULL, FK → users(user_id) ON DELETE CASCADE | AC-4 |
| `channel` | VARCHAR(32) | NOT NULL, CHECK IN ('whatsapp','web','rn','swift','browser_extension') | AC-4, AC-6 (Q3 locked) |
| `channel_user_id` | VARCHAR(255) | NOT NULL | AC-4 |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | AC-4 |
| `last_seen_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | AC-4 (application-updated, no trigger — Q5 locked) |

Constraints:
- `channel_identities_channel_user_unique`: UNIQUE (channel, channel_user_id) — AC-5
- `channel_identities_channel_check`: CHECK (channel IN (...)) — AC-6

Supporting index: `idx_channel_identities_user_id` on `(user_id)` — serves auth lookup and
cross-channel continuity query (ADR-025 §Reasoning point 2).

---

## Migration Details

**File**: `migrations/1745539200000_create-user-identity-schema.ts`  
**Timestamp**: 1745539200000 (2026-04-25 00:00:00 UTC, ms-precision UNIX epoch per ADR-003)  
**Format**: TypeScript source, compiled to CommonJS `.cjs` via `tsconfig.migrations.json`  
**Runner**: node-pg-migrate v6 (ADR-003)  
**Tracking table**: `user_identity.pgmigrations` (ADR-018 — inside service schema, not public)

### Build Pipeline

```
npm run build:migrations
  └─ tsc -p tsconfig.migrations.json
       → dist/migrations/1745539200000_create-user-identity-schema.js
  └─ node scripts/rename-migrations.js
       → dist/migrations/1745539200000_create-user-identity-schema.cjs
```

### Migration Config (.migrationrc.json)

```json
{
  "schema": "user_identity",
  "migrations-schema": "user_identity",
  "migrations-table": "pgmigrations",
  "create-schema": true,
  "create-migrations-schema": true,
  "run-in-transaction": true
}
```

`create-schema: true` and `create-migrations-schema: true` ensure the schema exists before
the tracking table is written, which is required for the first migration on a fresh database.

---

## Local Validation (up→down→up)

Validated via Postgres MCP against the local development database (Docker available per Q1
decision, 2026-04-25).

### up() result

Schema `user_identity` created. Tables `users` and `channel_identities` created with all
constraints and indexes. `pgmigrations` tracking table present inside `user_identity` schema.

### down() result

`channel_identities` dropped first (FK child). `users` dropped second. Schema dropped with
CASCADE. `pgmigrations` table gone (dropped with schema). `user_identity` schema absent from
`information_schema.schemata`.

### up() again (idempotency check)

Schema, tables, constraints, and indexes recreated cleanly. No errors. `pgmigrations`
contains one entry. Migration is idempotent. AC-7 satisfied.

---

## ADR Compliance

| ADR | Requirement | Satisfied |
|-----|-------------|-----------|
| ADR-001 | Schema-per-service isolation | YES — `user_identity` schema owned exclusively by auth-service. No cross-schema FKs. |
| ADR-003 | node-pg-migrate | YES — migration uses node-pg-migrate MigrationBuilder API |
| ADR-018 | pgmigrations inside service schema | YES — `migrations-schema: user_identity` in .migrationrc.json |
| ADR-025 | `user_identity` schema name, auth-service owner | YES — schema literal is `user_identity` throughout |

---

## Quality Gate Verification

- [x] RFC includes rationale, SQL, rollback plan, fixture samples (ADR-017)
- [x] Migration uses node-pg-migrate (ADR-003)
- [x] Indexes justified with query patterns
- [x] Schema ownership boundaries respected — no cross-schema FKs or queries
- [x] Naming follows conventions (snake_case, descriptive)
- [x] Constraints enforce data integrity at DB level (CHECK, UNIQUE, FK, NOT NULL)
- [x] Backward/forward compatibility: N/A — new service, empty schema
- [x] Notion pages fetched and cited: System Index, ADR-001, ADR-003, ADR-018, ADR-025, BL-207, RAILREPAY-IDP-001
- [x] Fixture Data Samples section included in RFC-001 (ADR-017)
- [x] Sample extraction queries provided for Jessie (ADR-017)
- [x] No technical debt shortcuts taken in this slice (no TD items required)
- [x] up→down→up validated locally via Postgres MCP

---

## Technical Debt

No technical debt shortcuts were taken in this phase. The schema is simple (two tables, no
denormalisations, no deferred constraints). All ACs are satisfied in a single migration.

Items deferred by design (outside IDP-001 scope, tracked in separate backlog entries):
- `sessions` table: IDP-002
- `claim_drafts`, `journey_drafts` tables: IDP-002
- Cross-channel reconciliation migration: IDP-003
- `journey_matcher.journeys.user_id` VARCHAR→UUID: IDP-003 AC-4

---

## Handoff to Jessie (Phase 3.1)

GREEN migration status confirmed. Jessie may:
1. Install deps: `npm install` in `services/auth-service/`
2. Run integration tests using Testcontainers PostgreSQL against the real migration
3. Write tests that verify all 9 integration test specifications listed in RFC-001
4. Reference fixture queries in RFC-001 §Fixture Data Samples for Jessie for seed data

**Explicit handoff**: ready for Jessie Phase 3.1.
