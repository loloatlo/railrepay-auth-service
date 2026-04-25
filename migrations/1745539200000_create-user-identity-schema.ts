/**
 * Migration: 1745539200000_create-user-identity-schema
 *
 * Purpose: Bootstrap the user_identity schema for auth-service (IDP-001, pre-beta minimal slice).
 *
 * Schema: user_identity
 * Tables: users, channel_identities
 *
 * ADR Compliance:
 * - ADR-001: Schema-per-service isolation — user_identity schema owned exclusively by auth-service
 * - ADR-003: node-pg-migrate as migration tool standard
 * - ADR-018: Per-service migration tracking — pgmigrations lives inside user_identity schema
 * - ADR-025: Dedicated user_identity schema for identity, sessions, and drafts
 *
 * Decisions locked 2026-04-25 (BL-207):
 * - Q2: status CHECK values — 'active', 'suspended', 'deleted'
 * - Q3: channel CHECK values — 'whatsapp', 'web', 'rn', 'swift', 'browser_extension'
 * - Q5: last_seen_at is application-updated, NO trigger — column created with DEFAULT NOW() only
 *
 * Related RFC: docs/design/RFC-001-user-identity-schema.md
 * Related BL item: BL-207
 * Related story: RAILREPAY-IDP-001
 */

import { MigrationBuilder } from 'node-pg-migrate';

/**
 * UP Migration: Create schema, tables, constraints, indexes.
 *
 * Zero-downtime note: auth-service is a brand-new service with no existing data or
 * callers in production. There is no hot table to lock; the full schema is created
 * atomically inside a single transaction (run-in-transaction: true in .migrationrc.json).
 * No expand-migrate-contract phasing is required.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // ─── Step 1: Create schema (idempotent) ──────────────────────────────────
  // ADR-001: every service owns exactly one schema.
  // ADR-025: schema is named user_identity, not auth_service — see ADR-025 §Reasoning.
  pgm.createSchema('user_identity', { ifNotExists: true });

  // ─── Step 2: users table ─────────────────────────────────────────────────
  // AC-1 (RAILREPAY-IDP-001): user_id UUID PK, created_at TIMESTAMPTZ, status VARCHAR(20).
  pgm.createTable(
    { schema: 'user_identity', name: 'users' },
    {
      user_id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('gen_random_uuid()'),
        notNull: true,
        comment: 'Canonical user identifier — stable across channels (ADR-022, ADR-025)',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
        comment: 'Row creation timestamp (immutable after insert)',
      },
      status: {
        type: 'varchar(20)',
        notNull: true,
        comment: "Lifecycle status. Allowed values enforced by CHECK constraint (Q2, 2026-04-25).",
      },
    }
  );

  // AC-3 (RAILREPAY-IDP-001): status CHECK constraint — values locked Q2 2026-04-25.
  // Future values require a new migration to extend the CHECK.
  pgm.addConstraint(
    { schema: 'user_identity', name: 'users' },
    'users_status_check',
    { check: "status IN ('active', 'suspended', 'deleted')" }
  );

  // Index on status to support admin queries (list suspended/deleted users).
  // Write amplification: low — status changes are infrequent lifecycle events.
  pgm.createIndex(
    { schema: 'user_identity', name: 'users' },
    ['status'],
    { name: 'idx_users_status', method: 'btree' }
  );

  // ─── Step 3: channel_identities table ────────────────────────────────────
  // AC-4 (RAILREPAY-IDP-001): user_id FK, channel, channel_user_id, created_at, last_seen_at.
  pgm.createTable(
    { schema: 'user_identity', name: 'channel_identities' },
    {
      user_id: {
        type: 'uuid',
        notNull: true,
        references: { schema: 'user_identity', name: 'users' },
        referencesConstraintName: 'channel_identities_user_id_fk',
        onDelete: 'CASCADE',
        comment: 'FK to user_identity.users — CASCADE DELETE removes channel identity when user is purged',
      },
      channel: {
        type: 'varchar(32)',
        notNull: true,
        comment: "Channel identifier. Allowed values enforced by CHECK constraint (Q3, 2026-04-25).",
      },
      channel_user_id: {
        type: 'varchar(255)',
        notNull: true,
        comment: 'Channel-specific identifier (e.g. WhatsApp E.164 phone, web sub claim)',
      },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
        comment: 'Row creation timestamp (immutable after insert)',
      },
      last_seen_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('NOW()'),
        comment: 'Application-updated on each identity lookup. NO trigger — auth-service code owns updates (Q5, 2026-04-25).',
      },
    }
  );

  // AC-6 (RAILREPAY-IDP-001): channel CHECK constraint — values locked Q3 2026-04-25.
  // Covers all current and Stage-2 channels; future channels require a new migration.
  pgm.addConstraint(
    { schema: 'user_identity', name: 'channel_identities' },
    'channel_identities_channel_check',
    { check: "channel IN ('whatsapp', 'web', 'rn', 'swift', 'browser_extension')" }
  );

  // AC-5 (RAILREPAY-IDP-001): composite UNIQUE on (channel, channel_user_id).
  // Named exactly as specified: channel_identities_channel_user_unique.
  // Rationale: prevents two canonical users mapping to the same channel identity,
  // which would break the lookup guarantee at auth time.
  pgm.addConstraint(
    { schema: 'user_identity', name: 'channel_identities' },
    'channel_identities_channel_user_unique',
    { unique: ['channel', 'channel_user_id'] }
  );

  // Index on user_id to support "all channels for a given user" lookups.
  // Serves the cross-channel continuity query: identity → drafts (ADR-025 §Reasoning point 2).
  // Query pattern: SELECT * FROM user_identity.channel_identities WHERE user_id = $1
  pgm.createIndex(
    { schema: 'user_identity', name: 'channel_identities' },
    ['user_id'],
    { name: 'idx_channel_identities_user_id', method: 'btree' }
  );

  // ─── Step 4: Table comments ───────────────────────────────────────────────
  pgm.sql(`
    COMMENT ON TABLE user_identity.users IS
      'Canonical user records — one row per real-world user. Created on first channel contact. Owned by auth-service (ADR-025).';

    COMMENT ON TABLE user_identity.channel_identities IS
      'Maps a canonical user_id to a per-channel external identifier. Composite unique on (channel, channel_user_id) prevents identity collisions. Owned by auth-service (ADR-025).';
  `);
}

/**
 * DOWN Migration: Reverse cleanly.
 *
 * AC-7 (RAILREPAY-IDP-001): drop channel_identities → drop users → drop schema,
 * all with IF EXISTS … CASCADE. up→down→up must be idempotent.
 *
 * Rollback risk: LOW — auth-service is a brand-new service with no callers in production.
 * There is no data to preserve; the schema is created empty.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop tables in FK-dependency order (child before parent).
  pgm.dropTable(
    { schema: 'user_identity', name: 'channel_identities' },
    { ifExists: true, cascade: true }
  );

  pgm.dropTable(
    { schema: 'user_identity', name: 'users' },
    { ifExists: true, cascade: true }
  );

  // Drop schema. CASCADE handles any residual objects left by pgmigrations itself.
  pgm.dropSchema('user_identity', { ifExists: true, cascade: true });
}
