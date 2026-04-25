# RFC-001: user_identity Schema — Initial Bootstrap (IDP-001)

**Status**: Accepted  
**Author**: Hoops (Data Architect)  
**Date**: 2026-04-25  
**BL item**: BL-207  
**Story**: RAILREPAY-IDP-001  
**ADRs cited**: ADR-001, ADR-003, ADR-018, ADR-025  

---

## Rationale

ADR-022 introduced a canonical `user_id` model separating identity from channel. ADR-025
(accepted 2026-04-25) settled the schema ownership question: a new `user_identity` schema,
owned exclusively by `auth-service`, houses all identity-related tables. The schema name
deliberately differs from the service name (`auth-service` vs `user_identity`) because the
schema represents the *concept* (user identity in all forms) rather than the service that
happens to own it — consistent with ADR-025 §Reasoning point 4.

IDP-001 is the pre-beta minimal slice: schema creation plus the two tables needed before any
app channel can authenticate a user. Sessions and draft tables are post-beta (IDP-002).

**Microservice boundary**: auth-service is the single writer to `user_identity`. All other
services (web-app-bff, whatsapp-handler) read/write identity data via auth-service REST APIs,
never via direct SQL (ADR-001 §Cross-Service Data Access). No cross-schema foreign keys are
created; the FK in `channel_identities.user_id` is within `user_identity` schema only.

---

## Forward Migration SQL

Produced by `node-pg-migrate` from `migrations/1745539200000_create-user-identity-schema.ts`.
Equivalent raw SQL for review:

```sql
-- ADR-001: schema-per-service
CREATE SCHEMA IF NOT EXISTS user_identity;

-- AC-1: users table
CREATE TABLE user_identity.users (
  user_id    UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status     VARCHAR(20)  NOT NULL
);

-- AC-3: status CHECK (Q2 locked 2026-04-25)
ALTER TABLE user_identity.users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'suspended', 'deleted'));

-- Supporting index: status lookups (admin, data-retention sweep)
CREATE INDEX idx_users_status ON user_identity.users USING btree (status);

-- AC-4: channel_identities table
CREATE TABLE user_identity.channel_identities (
  user_id         UUID         NOT NULL
                    REFERENCES user_identity.users(user_id)
                    ON DELETE CASCADE,
  channel         VARCHAR(32)  NOT NULL,
  channel_user_id VARCHAR(255) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- AC-6: channel CHECK (Q3 locked 2026-04-25)
ALTER TABLE user_identity.channel_identities
  ADD CONSTRAINT channel_identities_channel_check
  CHECK (channel IN ('whatsapp', 'web', 'rn', 'swift', 'browser_extension'));

-- AC-5: composite UNIQUE — named exactly per AC specification
ALTER TABLE user_identity.channel_identities
  ADD CONSTRAINT channel_identities_channel_user_unique
  UNIQUE (channel, channel_user_id);

-- Supporting index: user_id lookups (auth path, cross-channel continuity)
CREATE INDEX idx_channel_identities_user_id
  ON user_identity.channel_identities USING btree (user_id);

-- Table documentation
COMMENT ON TABLE user_identity.users IS
  'Canonical user records — one row per real-world user. Owned by auth-service (ADR-025).';
COMMENT ON TABLE user_identity.channel_identities IS
  'Maps a canonical user_id to a per-channel external identifier. Composite unique on
   (channel, channel_user_id) prevents identity collisions. Owned by auth-service (ADR-025).';
```

### Index Justifications

| Index | Table | Columns | Query Served | Write Cost |
|-------|-------|---------|-------------|------------|
| `idx_users_status` | `users` | `(status)` | Admin list queries; data-retention-service sweeps deleted users | Very low — status changes are rare lifecycle events |
| `idx_channel_identities_user_id` | `channel_identities` | `(user_id)` | Auth lookup: "all channels for user X"; cross-channel continuity (ADR-025 §Reasoning 2) | Low — one write per new channel identity |

The `channel_identities_channel_user_unique` UNIQUE constraint implicitly creates a btree index
on `(channel, channel_user_id)` which additionally serves the auth lookup: "find canonical
user_id for this channel + channel_user_id pair." This is the hot-path query; no additional
index is needed.

No `updated_at` column is present on either table by design:
- `users`: status transitions are infrequent; callers can query audit logs (future).
- `channel_identities`: `last_seen_at` carries the recency signal; a separate `updated_at`
  would duplicate it.

---

## Rollback Migration SQL

Equivalent raw SQL for the `down()` function:

```sql
-- Drop in FK-dependency order, then schema
DROP TABLE IF EXISTS user_identity.channel_identities CASCADE;
DROP TABLE IF EXISTS user_identity.users CASCADE;
DROP SCHEMA IF EXISTS user_identity CASCADE;
```

**Validation steps after rollback**:

```sql
-- Confirm schema no longer exists
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name = 'user_identity';
-- Expected: 0 rows

-- Confirm pgmigrations tracking table also gone (dropped with schema CASCADE)
SELECT tablename
FROM pg_tables
WHERE schemaname = 'user_identity';
-- Expected: 0 rows
```

### Rollback Risk Assessment

**Risk: LOW**

auth-service has no production deployment at the time this migration runs. The schema is
created empty. No other service reads from `user_identity` (they call auth-service APIs).
Rolling back drops the schema without any data loss risk during pre-beta. If rollback is
needed during a future live deployment, the app must be taken offline first (the service
itself holds the connection pool; no other service has a direct DB connection to this schema).

---

## TypeScript vs CJS Migration Format

This migration uses a TypeScript `.ts` source file compiled to CommonJS `.cjs` via
`tsconfig.migrations.json`, mirroring the pattern established in whatsapp-handler.

**Rationale for `.ts` over raw `.cjs`**:

1. **Type safety on `pgm` calls**: The `MigrationBuilder` type catches typos in table/column
   specs at compile time, not at migration runtime against a live database.
2. **Consistency with whatsapp-handler**: The existing TS-migration template is proven in
   production; diverging to raw CJS for a new service would fragment the codebase.
3. **Readable diffs**: TypeScript source is the reviewer-facing artefact; the compiled `.cjs`
   in `dist/migrations/` is a build output, not hand-maintained.

**Why not raw `.cjs` directly** (as delay-tracker uses): delay-tracker predates the
whatsapp-handler TS pattern. IDP-001 is greenfield — no legacy reason to use raw CJS.

**Build pipeline**: `npm run build:migrations` runs `tsc -p tsconfig.migrations.json` (outputs
`.js` to `dist/migrations/`) then `node scripts/rename-migrations.js` renames them to `.cjs`.
The Railway migrate:up script reads from `dist/migrations/`.

---

## Zero-Downtime Considerations

Not applicable for IDP-001. auth-service does not exist in production; the schema is created
empty. There are no:
- Existing tables to alter (no locking risk)
- Existing callers to maintain backward compatibility with
- Data backfill requirements

The expand-migrate-contract pattern is not needed here. It will be relevant for IDP-002
(sessions) and IDP-003 (VARCHAR→UUID migration on `journey_matcher.journeys.user_id`).

---

## Performance Impact Assessment

**Affected queries at time of migration**: None — schema is empty.

**Post-IDP-001 hot-path query** (when BL-201 application code lands):

```sql
-- Auth lookup: resolve channel identity to canonical user_id
SELECT ci.user_id, u.status
FROM user_identity.channel_identities ci
JOIN user_identity.users u ON u.user_id = ci.user_id
WHERE ci.channel = $1
  AND ci.channel_user_id = $2;
```

EXPLAIN ANALYZE projection (Testcontainers PG, empty table, post-seeding):
- Uses index scan on `channel_identities_channel_user_unique` (channel, channel_user_id)
- Then nested loop to `users` PK index
- Expected: < 1 ms P95 at MVP scale (tens of thousands of users)

No partitioning needed at pre-beta scale.

---

## Data Migration Strategy

No existing data to migrate in IDP-001. The schema is created empty.

**Related deferred migrations** (not in scope for IDP-001):
- `whatsapp_handler.users.id` → `user_identity.users.user_id` reconciliation: tracked in
  RAILREPAY-IDP-003. Q1 investigation confirmed this is a one-row-per-user identity copy
  (whatsapp_handler.users.id is already a UUID).
- `journey_matcher.journeys.user_id` VARCHAR→UUID drift: tracked in RAILREPAY-IDP-003 AC-4.

---

## Integration Test Specifications

(For Jessie, Phase 3.1 — tests written BEFORE these specifications are executed, per ADR-014.)

Jessie's integration tests MUST verify:

1. **Schema existence after `up()`**:
   ```sql
   SELECT schema_name FROM information_schema.schemata
   WHERE schema_name = 'user_identity';
   -- Expected: 1 row
   ```

2. **`users` table structure**:
   - `user_id` is UUID, primary key, NOT NULL, default `gen_random_uuid()`
   - `created_at` is TIMESTAMPTZ, NOT NULL, default NOW()
   - `status` is VARCHAR(20), NOT NULL

3. **`users_status_check` constraint**:
   - INSERT with `status = 'active'` succeeds
   - INSERT with `status = 'suspended'` succeeds
   - INSERT with `status = 'deleted'` succeeds
   - INSERT with `status = 'banned'` raises constraint violation

4. **`channel_identities` table structure**:
   - `user_id` is UUID, NOT NULL, FK to `user_identity.users(user_id)`
   - `channel` is VARCHAR(32), NOT NULL
   - `channel_user_id` is VARCHAR(255), NOT NULL
   - `created_at` is TIMESTAMPTZ, NOT NULL, default NOW()
   - `last_seen_at` is TIMESTAMPTZ, NOT NULL, default NOW()

5. **`channel_identities_channel_check` constraint**:
   - INSERT with each of `'whatsapp'`, `'web'`, `'rn'`, `'swift'`, `'browser_extension'` succeeds
   - INSERT with `'telegram'` raises constraint violation

6. **`channel_identities_channel_user_unique` UNIQUE constraint**:
   - Two rows with same `(channel, channel_user_id)` but different `user_id` raises unique violation
   - Two rows with same `channel` but different `channel_user_id` succeeds

7. **CASCADE DELETE**:
   - DELETE from `users` where a `channel_identities` row references it → channel_identities row
     is also deleted

8. **`down()` reversal**:
   - After `down()`: `user_identity` schema does not exist
   - After `up()` again: schema, tables, constraints, indexes all present (idempotency)

9. **`pgmigrations` table location** (ADR-018):
   - `pgmigrations` table exists in `user_identity` schema, not `public`

---

## Fixture Data Samples for Jessie

Per ADR-017: Hoops provides sample extraction queries for integration test fixtures.

### Sample Extraction Queries

Run these after the migration `up()` and seed data insertion in Testcontainers:

```sql
-- Happy path: active user with a WhatsApp identity
SELECT u.user_id, u.status, ci.channel, ci.channel_user_id, ci.last_seen_at
FROM user_identity.users u
JOIN user_identity.channel_identities ci ON ci.user_id = u.user_id
WHERE u.status = 'active'
  AND ci.channel = 'whatsapp'
LIMIT 3;

-- Edge case: suspended user
SELECT user_id, status, created_at
FROM user_identity.users
WHERE status = 'suspended'
LIMIT 2;

-- Edge case: deleted user (should still have no channel_identities after CASCADE)
SELECT u.user_id, u.status, COUNT(ci.user_id) AS ci_count
FROM user_identity.users u
LEFT JOIN user_identity.channel_identities ci ON ci.user_id = u.user_id
WHERE u.status = 'deleted'
GROUP BY u.user_id, u.status
LIMIT 2;

-- Edge case: user with multiple channel identities (WhatsApp + web)
SELECT u.user_id, u.status, ci.channel, ci.channel_user_id
FROM user_identity.users u
JOIN user_identity.channel_identities ci ON ci.user_id = u.user_id
WHERE u.user_id IN (
  SELECT user_id FROM user_identity.channel_identities
  GROUP BY user_id HAVING COUNT(*) > 1
)
ORDER BY u.user_id, ci.channel
LIMIT 6;

-- Edge case: channel_user_id with unicode (international phone number)
SELECT channel, channel_user_id
FROM user_identity.channel_identities
WHERE channel = 'whatsapp'
  AND channel_user_id LIKE '+%'
LIMIT 3;

-- Verify pgmigrations is in user_identity schema (ADR-018)
SELECT schemaname, tablename
FROM pg_tables
WHERE tablename = 'pgmigrations'
  AND schemaname = 'user_identity';
-- Expected: 1 row
```

### Suggested Seed Data for Testcontainers

```sql
-- User 1: active, WhatsApp identity
INSERT INTO user_identity.users (user_id, status)
VALUES ('a0000000-0000-0000-0000-000000000001', 'active');

INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
VALUES ('a0000000-0000-0000-0000-000000000001', 'whatsapp', '+447700900001');

-- User 2: active, web identity
INSERT INTO user_identity.users (user_id, status)
VALUES ('a0000000-0000-0000-0000-000000000002', 'active');

INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
VALUES ('a0000000-0000-0000-0000-000000000002', 'web', 'auth0|sub_abc123');

-- User 3: active, multi-channel (WhatsApp + web)
INSERT INTO user_identity.users (user_id, status)
VALUES ('a0000000-0000-0000-0000-000000000003', 'active');

INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
VALUES
  ('a0000000-0000-0000-0000-000000000003', 'whatsapp', '+447700900003'),
  ('a0000000-0000-0000-0000-000000000003', 'web', 'auth0|sub_def456');

-- User 4: suspended
INSERT INTO user_identity.users (user_id, status)
VALUES ('a0000000-0000-0000-0000-000000000004', 'suspended');

INSERT INTO user_identity.channel_identities (user_id, channel, channel_user_id)
VALUES ('a0000000-0000-0000-0000-000000000004', 'whatsapp', '+447700900004');

-- User 5: deleted (no channel_identities — they would have been CASCADE deleted)
INSERT INTO user_identity.users (user_id, status)
VALUES ('a0000000-0000-0000-0000-000000000005', 'deleted');
```
