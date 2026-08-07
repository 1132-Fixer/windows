-- 1132 Fixer support and verified-rating schema
-- PostgreSQL 16+

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE product_source AS ENUM ('windows', 'chrome', 'macos', 'website');
CREATE TYPE case_kind AS ENUM ('bug', 'feedback', 'rating_feedback');
CREATE TYPE case_state AS ENUM ('new', 'in_review', 'waiting_for_user', 'resolved', 'reopened', 'spam');
CREATE TYPE case_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE message_author AS ENUM ('user', 'staff', 'system');
CREATE TYPE message_visibility AS ENUM ('user', 'internal');
CREATE TYPE delivery_state AS ENUM ('queued', 'available', 'read', 'failed');
CREATE TYPE rating_state AS ENUM ('pending', 'verified', 'withdrawn', 'flagged');
CREATE TYPE outbox_state AS ENUM ('pending', 'running', 'sent', 'failed');

CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  token_hash bytea NOT NULL UNIQUE,
  source product_source NOT NULL,
  app_version text NOT NULL,
  release_channel text NOT NULL DEFAULT 'stable',
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (public_id ~ '^IN-[A-Z2-9]{10,20}$')
);

CREATE TABLE product_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fix_attempted', 'fix_completed', 'fix_failed')),
  app_version text NOT NULL,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, idempotency_key)
);

CREATE TABLE support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text NOT NULL UNIQUE,
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  kind case_kind NOT NULL,
  state case_state NOT NULL DEFAULT 'new',
  priority case_priority NOT NULL DEFAULT 'normal',
  source product_source NOT NULL,
  app_version text NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 8000),
  environment jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics_consent boolean NOT NULL DEFAULT false,
  assigned_discord_user_id text,
  discord_forum_thread_id text UNIQUE,
  discord_starter_message_id text UNIQUE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (public_id ~ '^FX-[A-Z2-9]{6,12}$')
);

CREATE INDEX support_cases_installation_updated_idx
  ON support_cases (installation_id, updated_at DESC);
CREATE INDEX support_cases_queue_idx
  ON support_cases (state, priority, updated_at DESC)
  WHERE state NOT IN ('resolved', 'spam');

CREATE TABLE case_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author message_author NOT NULL,
  visibility message_visibility NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  staff_discord_user_id text,
  delivery delivery_state NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz,
  read_at timestamptz,
  UNIQUE (case_id, idempotency_key),
  CHECK (visibility = 'internal' OR author <> 'system' OR body <> '')
);

CREATE INDEX case_messages_case_created_idx
  ON case_messages (case_id, created_at);

CREATE TABLE case_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  message_id uuid REFERENCES case_messages(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256 bytea NOT NULL,
  redaction_state text NOT NULL CHECK (redaction_state IN ('pending', 'approved', 'rejected')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  eligible_event_id uuid NOT NULL REFERENCES product_events(id) ON DELETE RESTRICT,
  source product_source NOT NULL,
  app_version text NOT NULL,
  ease smallint NOT NULL CHECK (ease BETWEEN 1 AND 5),
  resolved smallint NOT NULL CHECK (resolved BETWEEN 1 AND 5),
  recommend smallint NOT NULL CHECK (recommend BETWEEN 1 AND 5),
  overall smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR char_length(comment) <= 4000),
  state rating_state NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  withdrawn_at timestamptz,
  moderation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, source),
  CHECK ((state <> 'flagged') OR moderation_reason IS NOT NULL)
);

CREATE TABLE positive_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE RESTRICT,
  source product_source NOT NULL,
  app_version text NOT NULL,
  topic text NOT NULL DEFAULT 'compliment' CHECK (topic = 'compliment'),
  body text CHECK (body IS NULL OR char_length(body) <= 4000),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, idempotency_key)
);

CREATE INDEX positive_feedback_source_created_idx
  ON positive_feedback (source, created_at DESC);

CREATE INDEX ratings_public_window_idx
  ON ratings (source, updated_at DESC)
  WHERE state = 'verified';

CREATE VIEW verified_rating_summary_90d AS
SELECT
  source,
  count(*)::integer AS rating_count,
  round(avg(overall)::numeric, 2) AS average,
  count(*) FILTER (WHERE overall = 1)::integer AS star_1,
  count(*) FILTER (WHERE overall = 2)::integer AS star_2,
  count(*) FILTER (WHERE overall = 3)::integer AS star_3,
  count(*) FILTER (WHERE overall = 4)::integer AS star_4,
  count(*) FILTER (WHERE overall = 5)::integer AS star_5,
  max(updated_at) AS updated_at
FROM ratings
WHERE state = 'verified'
  AND updated_at >= now() - interval '90 days'
GROUP BY GROUPING SETS ((source), ());

CREATE TABLE rating_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating_id uuid NOT NULL REFERENCES ratings(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  "values" jsonb NOT NULL, -- quoted: VALUES is a reserved word; identifier unchanged
  reason text NOT NULL CHECK (reason IN ('created', 'user_updated', 'withdrawn', 'moderated', 'restored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rating_id, revision)
);

CREATE TABLE rating_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source product_source,
  window_days integer NOT NULL DEFAULT 90 CHECK (window_days BETWEEN 1 AND 3650),
  score numeric(3,2),
  rating_count integer NOT NULL CHECK (rating_count >= 0),
  distribution jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'collecting', 'stale', 'unavailable')),
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rating_snapshots_latest_idx
  ON rating_snapshots (source, window_days, generated_at DESC);

CREATE TABLE case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'staff', 'system')),
  actor_ref text,
  event_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX case_events_case_created_idx
  ON case_events (case_id, created_at);

CREATE TABLE idempotency_records (
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  key text NOT NULL,
  request_hash bytea NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, key)
);

CREATE TABLE discord_interactions (
  interaction_id text PRIMARY KEY,
  case_id uuid REFERENCES support_cases(id) ON DELETE SET NULL,
  discord_user_id text NOT NULL,
  action text NOT NULL,
  response_state text NOT NULL CHECK (response_state IN ('received', 'applied', 'rejected', 'failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('case', 'message', 'rating_snapshot')),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  state outbox_state NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX outbox_pending_idx
  ON outbox_events (available_at, created_at)
  WHERE state IN ('pending', 'failed');

-- The service role owns these tables. Public clients never connect to Postgres.
-- API queries must always scope cases and ratings to the authenticated installation.
