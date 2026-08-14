-- 1132 Fixer support and verified-rating schema
-- Final build 2026-08-07 (supersedes the spec-pack schema in the
-- renames/extensions it lists; 0-5 score checks; UPPER product enums).
-- PostgreSQL 16+.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE product AS ENUM ('WINDOWS', 'CHROME', 'MACOS');
CREATE TYPE case_kind AS ENUM ('bug', 'feedback', 'rating_feedback');
CREATE TYPE case_state AS ENUM ('new', 'in_review', 'waiting_for_user', 'resolved', 'reopened', 'spam');
CREATE TYPE case_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE message_author AS ENUM ('user', 'staff', 'system');
CREATE TYPE receipt_state AS ENUM ('AVAILABLE', 'NOTIFIED', 'READ', 'REPLIED');
CREATE TYPE rating_state AS ENUM ('pending', 'verified', 'withdrawn', 'flagged');
CREATE TYPE snapshot_state AS ENUM ('VERIFIED', 'NOT_ENOUGH_RATINGS', 'STALE', 'UNAVAILABLE');
CREATE TYPE outbox_state AS ENUM ('pending', 'running', 'sent', 'failed');

CREATE TABLE support_principals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,
  token_hash      bytea NOT NULL UNIQUE,
  product         product NOT NULL,
  app_version     text NOT NULL,
  release_channel text NOT NULL DEFAULT 'stable',
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (public_id ~ '^IN-[A-Z2-9]{10,20}$')
);

CREATE TABLE support_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref            text NOT NULL UNIQUE,
  principal_id        uuid NOT NULL REFERENCES support_principals(id) ON DELETE RESTRICT,
  kind                case_kind NOT NULL,
  state               case_state NOT NULL DEFAULT 'new',
  priority            case_priority NOT NULL DEFAULT 'normal',
  product             product NOT NULL,
  app_version         text NOT NULL,
  subject             text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  summary             text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 8000),
  environment         jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics_consent boolean NOT NULL DEFAULT false,
  assigned_discord_user_id text,
  -- Optimistic lock for Discord controls: stale epochs cannot mutate the case.
  control_epoch       integer NOT NULL DEFAULT 1 CHECK (control_epoch > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CHECK (case_ref ~ '^FX-[A-Z2-9]{6,12}$')
);

CREATE INDEX support_cases_principal_updated_idx
  ON support_cases (principal_id, updated_at DESC);
CREATE INDEX support_cases_queue_idx
  ON support_cases (state, priority, updated_at DESC)
  WHERE state NOT IN ('resolved', 'spam');

CREATE TABLE case_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,
  case_id         uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  case_seq        bigint NOT NULL,
  author          message_author NOT NULL,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  staff_discord_user_id text,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, case_seq),
  UNIQUE (case_id, idempotency_key),
  CHECK (public_id ~ '^MS-[A-Z2-9]{8,16}$')
);

-- Staff-only notes live in their OWN table so no user-facing query can ever
-- select them by accident (never returned to users).
CREATE TABLE internal_notes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  staff_discord_user_id text NOT NULL,
  body                  text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- My Messages read/reply state, one receipt per user-visible staff/system message.
CREATE TABLE inbox_receipts (
  message_id   uuid PRIMARY KEY REFERENCES case_messages(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES support_principals(id) ON DELETE CASCADE,
  state        receipt_state NOT NULL DEFAULT 'AVAILABLE',
  notified_at  timestamptz,
  read_at      timestamptz,
  replied_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbox_receipts_principal_state_idx ON inbox_receipts (principal_id, state);

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES case_messages(id) ON DELETE CASCADE,
  object_key      text NOT NULL UNIQUE,
  media_type      text NOT NULL,
  byte_size       bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256          bytea NOT NULL,
  redaction_state text NOT NULL CHECK (redaction_state IN ('pending', 'approved', 'rejected')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ratings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id      uuid NOT NULL REFERENCES support_principals(id) ON DELETE RESTRICT,
  product           product NOT NULL,
  app_version       text NOT NULL,
  -- 0 is a REAL answer; NULL is impossible here because every question is
  -- required (0-5 inclusive, six integer choices).
  ease              smallint NOT NULL CHECK (ease BETWEEN 0 AND 5),
  resolved          smallint NOT NULL CHECK (resolved BETWEEN 0 AND 5),
  recommend         smallint NOT NULL CHECK (recommend BETWEEN 0 AND 5),
  overall           smallint NOT NULL CHECK (overall BETWEEN 0 AND 5),
  comment           text CHECK (comment IS NULL OR char_length(comment) <= 4000),
  state             rating_state NOT NULL DEFAULT 'pending',
  verified_at       timestamptz,
  withdrawn_at      timestamptz,
  moderation_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- One active rating per principal and product: updates replace, never add.
  UNIQUE (principal_id, product),
  CHECK ((state <> 'flagged') OR moderation_reason IS NOT NULL)
);

CREATE INDEX ratings_public_window_idx
  ON ratings (product, updated_at DESC)
  WHERE state = 'verified';

CREATE TABLE rating_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_id  uuid NOT NULL REFERENCES ratings(id) ON DELETE CASCADE,
  revision   integer NOT NULL CHECK (revision > 0),
  "values"   jsonb NOT NULL, -- quoted: VALUES is a reserved word; identifier unchanged
  reason     text NOT NULL CHECK (reason IN ('created', 'user_updated', 'withdrawn', 'moderated', 'restored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rating_id, revision)
);

CREATE TABLE rating_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product      product,
  window_days  integer NOT NULL DEFAULT 90 CHECK (window_days BETWEEN 1 AND 3650),
  average      numeric(3,1), -- one decimal; NULL when rating_count = 0
  rating_count integer NOT NULL CHECK (rating_count >= 0),
  distribution jsonb NOT NULL,
  state        snapshot_state NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rating_snapshots_latest_idx
  ON rating_snapshots (product, window_days, generated_at DESC);

CREATE TABLE case_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff', 'system')),
  actor_ref  text,
  event_type text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX case_events_case_created_idx
  ON case_events (case_id, created_at);

-- Discord thread/control-message mapping, split out of support_cases.
CREATE TABLE discord_case_bindings (
  case_id            uuid PRIMARY KEY REFERENCES support_cases(id) ON DELETE CASCADE,
  forum_thread_id    text NOT NULL UNIQUE,
  control_message_id text NOT NULL,
  alerted_at         timestamptz, -- staff-role mention sent once, on first qualifying post
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discord_interactions (
  interaction_id  text PRIMARY KEY,
  case_id         uuid REFERENCES support_cases(id) ON DELETE SET NULL,
  discord_user_id text NOT NULL,
  action          text NOT NULL,
  response_state  text NOT NULL CHECK (response_state IN ('received', 'applied', 'rejected', 'failed')),
  received_at     timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE TABLE idempotency_requests (
  principal_id    uuid NOT NULL REFERENCES support_principals(id) ON DELETE CASCADE,
  key             text NOT NULL,
  request_digest  bytea NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Scope is the principal: two principals may legitimately choose the same
  -- key. A cross-principal UNIQUE (key, request_digest) would make one
  -- principal's key block another's identical body forever, so it is
  -- deliberately absent; same-key-different-body is enforced in code by
  -- comparing request_digest within the principal's own row.
  PRIMARY KEY (principal_id, key)
);

CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL CHECK (aggregate_type IN ('case', 'message', 'rating_snapshot')),
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  state           outbox_state NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  last_error_code text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX outbox_pending_idx
  ON outbox (available_at, created_at)
  WHERE state IN ('pending', 'failed');

-- The service role owns these tables. Public clients never connect to Postgres.
-- API queries must always scope cases, messages, and ratings to the
-- authenticated principal. internal_notes is never user-facing.
