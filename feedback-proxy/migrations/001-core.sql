-- Support framework core schema (plan §7).
-- Postgres 13+ (gen_random_uuid is built in).

CREATE TABLE installations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,
  credential_hash text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);

-- Case refs: 'F-' + zero-padded sequence value, assigned in application code
-- (lpad would truncate past 9999).
CREATE SEQUENCE ticket_case_seq;

CREATE TABLE tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref           text NOT NULL UNIQUE,
  installation_id    uuid NOT NULL REFERENCES installations(id),
  type               text NOT NULL CHECK (type IN ('bug', 'rating', 'message')),
  subject            text NOT NULL,
  status             text NOT NULL DEFAULT 'NEW' CHECK (status IN
                       ('NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_FOR_USER',
                        'USER_REPLIED', 'RESOLVED', 'CLOSED')),
  close_reason       text CHECK (close_reason IN ('DUPLICATE', 'SPAM')),
  priority           text,
  app_version        text,
  os_info            text,
  discord_channel_id text,
  discord_thread_id  text,
  discord_message_id text,
  assignee           text,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- One retry can never create two cases (plan §14). NULL keys are distinct.
  UNIQUE (installation_id, idempotency_key)
);

CREATE TABLE ticket_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           uuid NOT NULL REFERENCES tickets(id),
  sequence            bigint NOT NULL,
  author              text NOT NULL CHECK (author IN ('user', 'staff')),
  body                text NOT NULL,
  delivered_to_client boolean NOT NULL DEFAULT false,
  idempotency_key     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Also serves as the (ticket_id, sequence) index the message reader needs.
  UNIQUE (ticket_id, sequence),
  UNIQUE (ticket_id, idempotency_key)
);

CREATE TABLE ratings (
  installation_id uuid NOT NULL REFERENCES installations(id),
  app_version     text NOT NULL,
  score           int NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, app_version)
);

CREATE TABLE ticket_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id),
  event      text NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);

CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_due_idx ON outbox (delivered_at, next_attempt_at);

CREATE TABLE dashboard_messages (
  key        text PRIMARY KEY,
  channel_id text NOT NULL,
  message_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
