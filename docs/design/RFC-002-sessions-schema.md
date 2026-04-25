# RFC-002: user_identity.sessions Table (AUTH-002)

**Status**: Accepted  
**Author**: Hoops (Data Architect)  
**Date**: 2026-04-25  
**BL item**: BL-201  
**Story**: RAILREPAY-AUTH-002  
**ADRs cited**: ADR-001, ADR-003, ADR-018, ADR-025  
**DRs cited**: DR-UC-002  

---

## Rationale

DR-UC-002 (accepted 2026-04-25) settled that auth-service owns session issuance for all
channels — WhatsApp, web/PWA, future React Native, and future Swift. AUTH-001 delivered the
service skeleton and the `user_identity` schema (users + channel_identities). AUTH-002 adds
the `sessions` table that AUTH-003 (OTP verify → create session) and AUTH-004 (JWT issuance,
revoke, touch) will write and read against.

**Why a new table rather than embedding session state in `users`?**

Sessions are ephemeral, multi-row-per-user records with a fixed TTL. Embedding session state
in a single column on `users` would force JSON arrays, lose relational enforcement, and
prevent the per-session `revoked_at` / `expires_at` lifecycle that the `SessionRepository`
contract requires (AC-B2 through AC-B4). A dedicated `sessions` table is the correct
3NF design.

**Why inside `user_identity` schema rather than a new schema?**

ADR-025 explicitly lists `sessions` as a pre-beta table in the `user_identity` schema
(ADR-025 §Decision — Tables in user_identity schema). Keeping sessions schema-local means
the critical identity→sessions join (used by every authenticated request) stays
schema-local, avoiding any cross-schema carve-out under ADR-001 Addendum.

**Microservice boundary**: auth-service is the single writer to `user_identity`. No other
service holds a direct database connection to this schema. All session reads/writes by
web-app-bff, whatsapp-handler, and future BFFs go through auth-service REST APIs (ADR-001
§Cross-Service Data Access). No cross-schema foreign keys are created; the FK
`sessions.user_id → user_identity.users(user_id)` is wholly within `user_identity`.

---

## Forward Migration SQL

Produced by `node-pg-migrate` from
`migrations/1745625600000_create-sessions-table.ts`.  
Equivalent raw SQL for review:

```sql
-- sessions table — AC-B1.1
-- user_identity schema pre-exists (created by IDP-001 migration 1745539200000)
CREATE TABLE user_identity.sessions (
  session_id  UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID         NOT NULL
                REFERENCES user_identity.users(user_id)
                ON DELETE CASCADE,
  channel     VARCHAR(32)  NOT NULL,
  issued_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ  NOT NULL,  -- NO default — app computes now() + 30d (Q-AUTH-002-2)
  revoked_at  TIMESTAMPTZ  NULL       -- NULL = active; non-null = revoked
);

-- channel CHECK constraint — AC-B1.2
-- Constraint name: sessions_channel_check (spec-exact)
-- Same enum as channel_identities.channel, locked Q-AUTH-002-1, 2026-04-25
ALTER TABLE user_identity.sessions
  ADD CONSTRAINT sessions_channel_check
  CHECK (channel IN ('whatsapp', 'web', 'rn', 'swift', 'browser_extension'));

-- FK constraint name (for reference in tests) — AC-B1.3
-- Named by node-pg-migrate from referencesConstraintName: 'sessions_user_id_fk'
-- Already established by the CREATE TABLE REFERENCES clause above.

-- Index: user lookups — AC-B1.4
-- Serves: SessionRepository.findActive (WHERE user_id = $1 AND ...)
CREATE INDEX idx_sessions_user_id
  ON user_identity.sessions USING btree (user_id);

-- Index: expiry cleanup sweeps — AC-B1.4
-- Serves: future DELETE FROM sessions WHERE expires_at < NOW() (post-beta sweep job)
CREATE INDEX idx_sessions_expires_at
  ON user_identity.sessions USING btree (expires_at);

-- Table documentation
COMMENT ON TABLE user_identity.sessions IS
  'Session records for all channels. Created on OTP verify (AUTH-003), revoked on logout (AUTH-004). 30-day TTL enforced at application level by SessionRepository.touch() — Q-AUTH-002-2. Owned by auth-service (ADR-025, DR-UC-002).';
```

### Column Design Notes

| Column | Type | Nullable | Default | Rationale |
|--------|------|----------|---------|-----------|
| `session_id` | `uuid` | NOT NULL | `gen_random_uuid()` | Opaque handle — not guessable, not sequential, safe to expose as session token identifier |
| `user_id` | `uuid` | NOT NULL | — | FK to canonical user record; CASCADE DELETE keeps schema consistent on user purge |
| `channel` | `varchar(32)` | NOT NULL | — | Records originating channel for audit and future per-channel policy differentiation |
| `issued_at` | `timestamptz` | NOT NULL | `NOW()` | Immutable creation timestamp; used in audit logs and session age calculations |
| `expires_at` | `timestamptz` | NOT NULL | **NONE** | App-computed: `NOW() + SESSION_TTL_MS`. No DB default intentionally — forces explicit TTL at insert, prevents silent "never expires" bugs (Q-AUTH-002-2) |
| `revoked_at` | `timestamptz` | NULL | `NULL` | `NULL` = active. Soft-revoke avoids DELETE races; `SessionRepository.revoke()` is idempotent (AC-B3: second call is a no-op) |

**Why `expires_at` has no column default** (Q-AUTH-002-2 locked):  
A database-level default (e.g. `DEFAULT NOW() + INTERVAL '30 days'`) would silently
accept inserts that omit `expires_at`. Blake's `SessionRepository.create()` must pass
an explicit `expires_at` computed from the `SESSION_TTL_MS` constant — the NOT NULL
no-default combination enforces this at the database constraint level and causes an
immediate error if the application code omits the value.

**Why `revoked_at` is nullable rather than a boolean `is_revoked`**:  
The timestamp provides a free audit trail of when each session was revoked. A boolean
column would require a separate `revoked_at_ts` column to answer "when was this session
revoked?" — two columns instead of one nullable column.

### Index Justifications

| Index | Columns | Query Served | Partial? | Write Cost |
|-------|---------|--------------|---------|------------|
| `idx_sessions_user_id` | `(user_id)` | `SessionRepository.findActive`: `WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()` | No — deferred per Q-AUTH-002-3 | Low — one entry per session creation |
| `idx_sessions_expires_at` | `(expires_at)` | Future cleanup sweep: `DELETE WHERE expires_at < NOW()` paged deletion | No | Low — one entry per session creation |

**Why no partial index `WHERE revoked_at IS NULL`?** (Q-AUTH-002-3 deferred to IDP-002)  
A partial index on active sessions would give a tighter index scan for `findActive`.
However, at pre-beta scale (tens of thousands of sessions) the full btree on `user_id`
is efficient enough and avoids the complexity of a predicate index. The deferred item
is recorded as tech debt (see §Technical Debt below).

**Why no `updated_at` column?**  
Sessions are append-light records. `issued_at` is immutable. `expires_at` changes on
`touch()` and `revoked_at` changes on `revoke()` — both are semantically distinct
timestamp columns. A generic `updated_at` would duplicate one of these. Keeping
timestamps purposeful and named for their domain role is cleaner than a catch-all
`updated_at` (compare IDP-001 `users` and `channel_identities` design in RFC-001).

---

## Rollback Migration SQL

Equivalent raw SQL for the `down()` function:

```sql
-- Drop sessions table only — schema NOT dropped (owned by IDP-001 migration)
DROP TABLE IF EXISTS user_identity.sessions CASCADE;
```

**Validation steps after rollback**:

```sql
-- Confirm sessions table no longer exists
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'user_identity'
  AND table_name = 'sessions';
-- Expected: 0 rows

-- Confirm users and channel_identities are unaffected
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'user_identity'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
-- Expected: channel_identities, users (sessions ABSENT)
```

### Rollback Risk Assessment

**Risk: LOW**

At the time of this migration, auth-service has no session callers in production.
AUTH-003 (OTP verify → session create) and AUTH-004 (JWT/session endpoints) are not yet
deployed. The `sessions` table is created empty. Rolling back drops only the `sessions`
table — `users` and `channel_identities` (IDP-001 tables) are unaffected.

If rollback is needed after AUTH-003/404 are deployed and sessions exist, the app MUST
be taken offline first. A running auth-service holds an active connection pool to
`user_identity`; dropping `sessions` with live session traffic would cause 500s on
every authenticated request until the service restarts and reconnects with no sessions
table. Plan any post-AUTH-003 rollback during a maintenance window.

---

## FK CASCADE Reasoning

`user_id REFERENCES user_identity.users(user_id) ON DELETE CASCADE`

When a user record is purged (e.g. GDPR deletion, data-retention-service sweep), all
sessions for that user must be removed atomically. Without CASCADE:

1. Application code would need to explicitly delete sessions before deleting the user —
   a two-step operation that can leave orphan sessions if the second step fails.
2. Audit: "what sessions existed for this user?" becomes unanswerable because the user
   row is gone but sessions linger with a dangling FK that Postgres would refuse anyway.

CASCADE DELETE is the correct choice here: session records have no independent value
without a user, and the `data-retention-service` already operates user-level deletions
that must be cascade-complete.

---

## Zero-Downtime Considerations

Not applicable for AUTH-002. auth-service was deployed as a skeleton (AUTH-001) with no
session callers. There are no:
- Existing `sessions` rows to preserve
- Callers holding session references that need backward compatibility
- Large tables to lock with a long-running ALTER

The expand-migrate-contract pattern is reserved for post-AUTH-003 schema changes where
live session rows exist. Document in ADR-003 compliance note: if future AUTH-NNN migrations
alter the `sessions` table (e.g. adding columns), they MUST use expand-migrate-contract
to avoid locking the table while AUTH-003/404 are serving live traffic.

---

## Performance Impact Assessment

**Affected queries at time of migration**: None — table is created empty.

**Post-AUTH-002 hot-path query** (when AUTH-003/404 land):

```sql
-- AC-B2: SessionRepository.findActive — called on every authenticated request
SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
FROM user_identity.sessions
WHERE session_id = $1
  AND revoked_at IS NULL
  AND expires_at > NOW();
```

`session_id` is the primary key — lookup is O(log n) on the PK btree regardless of table
size. No additional index needed for this pattern.

```sql
-- AC-B4: SessionRepository.touch — sliding refresh
UPDATE user_identity.sessions
SET expires_at = NOW() + INTERVAL '30 days'
WHERE session_id = $1
  AND revoked_at IS NULL
  AND expires_at > NOW();
```

Again PK lookup. The `idx_sessions_user_id` index is not involved in the primary
hot-path (single-session lookup by session_id). Its value is in "list sessions for
admin / data-retention" queries.

EXPLAIN ANALYZE projection (Testcontainers PG, empty table, post-seed):
- `findActive(session_id)`: Index scan on sessions PK. Expected < 1 ms P95.
- `touch(session_id)`: Index scan on sessions PK + heap update. Expected < 1 ms P95.
- No partitioning needed at pre-beta scale.

---

## Data Migration Strategy

No existing data to migrate in AUTH-002. The `sessions` table is created empty.

**Future migration notes** (not in scope for AUTH-002):

- AUTH-003 will begin inserting session rows after OTP verify. The first `sessions` row
  is created by application code, not by this migration.
- IDP-002 (post-beta) adds `claim_drafts` and `journey_drafts` — no schema changes to
  `sessions` anticipated.
- RAILREPAY-IDP-003 (VARCHAR→UUID migration on `journey_matcher.journeys.user_id`) is
  unrelated to `sessions`.

---

## Integration Test Specifications

(For Phase 2 own tests — Hoops's migration tests verifying the migration deliverable.
Jessie's US-2 tests for `SessionRepository` application code come in Phase 3.1,
written BEFORE Blake's implementation, per ADR-014.)

Hoops's migration tests MUST verify (file: `tests/integration/migrations/sessions-schema.test.ts`):

1. **`sessions` table structure after `up()`** — query `information_schema.columns`:
   - `session_id`: uuid, NOT NULL, is primary key, default `gen_random_uuid()`
   - `user_id`: uuid, NOT NULL
   - `channel`: varchar(32), NOT NULL
   - `issued_at`: timestamptz, NOT NULL, default `now()`
   - `expires_at`: timestamptz, NOT NULL, **no default**
   - `revoked_at`: timestamptz, nullable, no default

2. **`sessions_channel_check` constraint** (AC-B1.2):
   - Each of `'whatsapp'`, `'web'`, `'rn'`, `'swift'`, `'browser_extension'` accepted
   - `'telegram'` rejected with constraint violation
   - Constraint named `sessions_channel_check` exactly

3. **FK CASCADE** (AC-B1.3):
   - `sessions_user_id_fk` constraint present
   - Insert session with non-existent `user_id` rejected (FK violation)
   - Delete user → sessions rows CASCADE deleted
   - Constraint named `sessions_user_id_fk` exactly

4. **Index existence** (AC-B1.4):
   - `idx_sessions_user_id` present in `pg_indexes`
   - `idx_sessions_expires_at` present in `pg_indexes`

5. **`down()` + idempotency** (AC-B1.5):
   - After `down()`: `sessions` table absent; `users` and `channel_identities` unaffected
   - After `up() → down() → up()`: `sessions` table present with all constraints intact

---

## Fixture Data Samples for Jessie

Per ADR-017: Hoops provides sample extraction queries that Jessie can run via Postgres MCP
or Testcontainers to build integration test fixtures for the `SessionRepository` tests
(Phase 3.1, US-2).

### Sample Extraction Queries

Run these after the migration `up()` and seed data insertion in a Testcontainers instance:

```sql
-- Happy path: active session (not revoked, not expired)
SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
FROM user_identity.sessions
WHERE revoked_at IS NULL
  AND expires_at > NOW()
LIMIT 3;

-- Edge case: revoked session
SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
FROM user_identity.sessions
WHERE revoked_at IS NOT NULL
LIMIT 2;

-- Edge case: expired session (not revoked but past expires_at)
SELECT session_id, user_id, channel, issued_at, expires_at, revoked_at
FROM user_identity.sessions
WHERE revoked_at IS NULL
  AND expires_at <= NOW()
LIMIT 2;

-- Edge case: all sessions for a single user (for findActive / revoke all patterns)
SELECT session_id, channel, issued_at, expires_at, revoked_at
FROM user_identity.sessions
WHERE user_id = $1
ORDER BY issued_at DESC;

-- Edge case: sessions across multiple channels for the same user
SELECT user_id, channel, COUNT(*) AS session_count
FROM user_identity.sessions
GROUP BY user_id, channel
HAVING COUNT(*) > 1
LIMIT 3;

-- Verify pgmigrations tracking (ADR-018)
SELECT schemaname, tablename
FROM pg_tables
WHERE tablename = 'pgmigrations'
  AND schemaname = 'user_identity';
-- Expected: 1 row
```

### Suggested Seed Data for Testcontainers (US-2 Fixtures)

```sql
-- Prerequisite: user_identity.users must exist (IDP-001 migration run first)
-- User A: active user with an active WhatsApp session
INSERT INTO user_identity.users (user_id, status)
VALUES ('b0000000-0000-0000-0000-000000000001', 'active');

INSERT INTO user_identity.sessions (user_id, channel, expires_at)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'whatsapp',
  NOW() + INTERVAL '30 days'
);

-- User B: active user with an active web session
INSERT INTO user_identity.users (user_id, status)
VALUES ('b0000000-0000-0000-0000-000000000002', 'active');

INSERT INTO user_identity.sessions (user_id, channel, expires_at)
VALUES (
  'b0000000-0000-0000-0000-000000000002',
  'web',
  NOW() + INTERVAL '30 days'
);

-- User C: active user with a revoked session
INSERT INTO user_identity.users (user_id, status)
VALUES ('b0000000-0000-0000-0000-000000000003', 'active');

INSERT INTO user_identity.sessions (user_id, channel, expires_at, revoked_at)
VALUES (
  'b0000000-0000-0000-0000-000000000003',
  'web',
  NOW() + INTERVAL '30 days',
  NOW() - INTERVAL '1 hour'  -- revoked 1 hour ago
);

-- User D: active user with an expired session (not revoked)
INSERT INTO user_identity.users (user_id, status)
VALUES ('b0000000-0000-0000-0000-000000000004', 'active');

INSERT INTO user_identity.sessions (user_id, channel, expires_at)
VALUES (
  'b0000000-0000-0000-0000-000000000004',
  'rn',
  NOW() - INTERVAL '1 day'  -- expired yesterday
);

-- User E: active user with sessions on two channels (multi-channel test)
INSERT INTO user_identity.users (user_id, status)
VALUES ('b0000000-0000-0000-0000-000000000005', 'active');

INSERT INTO user_identity.sessions (user_id, channel, expires_at)
VALUES
  ('b0000000-0000-0000-0000-000000000005', 'whatsapp', NOW() + INTERVAL '30 days'),
  ('b0000000-0000-0000-0000-000000000005', 'web',      NOW() + INTERVAL '30 days');
```

---

## Technical Debt

### TD-AUTH-002-1: Partial index `WHERE revoked_at IS NULL` deferred

**Severity**: Low  
**Origin**: AUTH-002 Phase 2  
**Context**: Q-AUTH-002-3 deferred the partial index `idx_sessions_active ON sessions(user_id) WHERE revoked_at IS NULL` to IDP-002. At pre-beta scale the full btree on `user_id` is efficient; the partial index becomes valuable when the sessions table grows large and most rows are revoked/expired.  
**Acceptance Criteria**: When `sessions` table exceeds 100 k rows in production, evaluate `EXPLAIN ANALYZE` on `findActive` queries. If index scan selectivity degrades (>10 ms P95), create `CREATE INDEX CONCURRENTLY idx_sessions_active ON user_identity.sessions(user_id) WHERE revoked_at IS NULL` in a new migration.

**Note**: This tech debt item is recorded here in the RFC. A Backlog item (Type=Tech Debt, BL-xxx) MUST be created in Notion per CLAUDE.md §5 before Phase 2 is marked complete. See Phase 2 completion report for the Notion BL item reference.

---

## Cited Decisions

| Reference | What It Governs |
|-----------|----------------|
| ADR-001 | Schema-per-service isolation — no cross-schema FK; `user_identity` owned exclusively by auth-service |
| ADR-003 | node-pg-migrate as migration tool standard |
| ADR-018 | Per-service migration tracking — `pgmigrations` lives inside `user_identity` schema |
| ADR-025 | Dedicated `user_identity` schema; `sessions` table listed as pre-beta table (§Decision table) |
| DR-UC-002 | auth-service owns session issuance for all channels (WhatsApp, web, RN, Swift) |
| BL-201 | Parent backlog item for auth-service build-out with user_id sessions |
| RAILREPAY-AUTH-002 | Story delivering this migration (sub-story B of BL-201 decomposition) |
