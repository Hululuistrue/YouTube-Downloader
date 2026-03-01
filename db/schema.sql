-- VideoDownloader Web - PostgreSQL schema
-- Target: PostgreSQL 14+

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('anonymous', 'registered', 'admin', 'compliance');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'suspended', 'disabled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE output_type AS ENUM ('mp4', 'mp3');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE task_status AS ENUM (
    'queued',
    'downloading',
    'transcoding',
    'uploading',
    'success',
    'failed',
    'canceled',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE subject_type AS ENUM ('ip', 'user', 'ua');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE complaint_status AS ENUM ('open', 'in_review', 'resolved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  role user_role NOT NULL DEFAULT 'registered',
  status user_status NOT NULL DEFAULT 'active',
  quota_daily integer NOT NULL DEFAULT 30 CHECK (quota_daily >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_not_null
  ON users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_cookie_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_file_name text,
  file_path text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS ix_user_cookie_files_user_created_at
  ON user_cookie_files (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS download_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source_url text NOT NULL,
  source_hash char(64) NOT NULL,
  platform text NOT NULL DEFAULT 'youtube',
  output_type output_type NOT NULL,
  quality text,
  audio_bitrate text,
  status task_status NOT NULL DEFAULT 'queued',
  progress smallint NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  error_code text,
  error_message text,
  retry_count smallint NOT NULL DEFAULT 0 CHECK (retry_count >= 0 AND retry_count <= 2),
  idempotency_key text,
  output_object_key text,
  file_size bigint CHECK (file_size IS NULL OR file_size >= 0),
  expires_at timestamptz,
  rights_confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT chk_download_tasks_platform CHECK (platform = 'youtube'),
  CONSTRAINT chk_download_tasks_variant CHECK (
    (output_type = 'mp4' AND quality IS NOT NULL)
    OR (output_type = 'mp3' AND audio_bitrate IS NOT NULL)
  )
);

ALTER TABLE download_tasks
  ADD COLUMN IF NOT EXISTS cookie_file_id uuid REFERENCES user_cookie_files(id) ON DELETE SET NULL;

ALTER TABLE download_tasks
  ADD COLUMN IF NOT EXISTS format_id text;

CREATE INDEX IF NOT EXISTS ix_download_tasks_user_created_at
  ON download_tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_download_tasks_status_created_at
  ON download_tasks (status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_download_tasks_source_hash
  ON download_tasks (source_hash);

CREATE INDEX IF NOT EXISTS ix_download_tasks_format_id
  ON download_tasks (format_id);

CREATE INDEX IF NOT EXISTS ix_download_tasks_cookie_file_id
  ON download_tasks (cookie_file_id);

CREATE INDEX IF NOT EXISTS ix_download_tasks_expires_at
  ON download_tasks (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_download_tasks_user_idempotency
  ON download_tasks (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES download_tasks(id) ON DELETE CASCADE,
  from_status task_status,
  to_status task_status NOT NULL,
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_task_events_status_changed CHECK (from_status IS NULL OR from_status <> to_status)
);

CREATE INDEX IF NOT EXISTS ix_task_events_task_id_created_at
  ON task_events (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS abuse_blocks (
  id bigserial PRIMARY KEY,
  subject_type subject_type NOT NULL,
  subject_value text NOT NULL,
  reason text NOT NULL,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_abuse_blocks_subject
  ON abuse_blocks (subject_type, subject_value);

CREATE INDEX IF NOT EXISTS ix_abuse_blocks_expired_at
  ON abuse_blocks (expired_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_abuse_blocks_active_subject
  ON abuse_blocks (subject_type, subject_value)
  WHERE expired_at IS NULL;

CREATE TABLE IF NOT EXISTS complaint_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES download_tasks(id) ON DELETE SET NULL,
  source_url text NOT NULL,
  reason text NOT NULL,
  contact text NOT NULL,
  status complaint_status NOT NULL DEFAULT 'open',
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_complaint_tickets_status_created_at
  ON complaint_tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_complaint_tickets_task_id
  ON complaint_tickets (task_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_task_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'queued' AND NEW.status IN ('downloading', 'failed', 'canceled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'downloading' AND NEW.status IN ('transcoding', 'failed', 'canceled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'transcoding' AND NEW.status IN ('uploading', 'failed', 'canceled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'uploading' AND NEW.status IN ('success', 'failed') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'failed' AND NEW.status = 'queued' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'success' AND NEW.status = 'expired' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid task status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_download_tasks_set_updated_at ON download_tasks;
CREATE TRIGGER trg_download_tasks_set_updated_at
BEFORE UPDATE ON download_tasks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_user_cookie_files_set_updated_at ON user_cookie_files;
CREATE TRIGGER trg_user_cookie_files_set_updated_at
BEFORE UPDATE ON user_cookie_files
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_download_tasks_status_transition ON download_tasks;
CREATE TRIGGER trg_download_tasks_status_transition
BEFORE UPDATE OF status ON download_tasks
FOR EACH ROW
EXECUTE FUNCTION enforce_task_status_transition();

DROP TRIGGER IF EXISTS trg_complaint_tickets_set_updated_at ON complaint_tickets;
CREATE TRIGGER trg_complaint_tickets_set_updated_at
BEFORE UPDATE ON complaint_tickets
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
