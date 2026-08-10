-- Screenshot bytes for bug-report attachments (#141). This service has no
-- object store, so the attachments.object_key contract is satisfied with a
-- 'db:<uuid>' key pointing at this table. Size is bounded well below the
-- attachments.byte_size CHECK (5 MiB app limit vs 10 MiB schema ceiling).
CREATE TABLE attachment_blobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
