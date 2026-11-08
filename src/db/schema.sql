-- Talisman core schema.
-- Tenant tables are protected by row level security. Auth tables (orgs, users,
-- memberships, sessions) are intentionally outside RLS because they are read
-- before an organisation context exists; they are only accessed by the auth
-- service with explicit predicates.

CREATE TABLE IF NOT EXISTS orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_org_user_idx ON conversations (org_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
  title text NOT NULL,
  goal text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','scheduled','running','waiting_approval','paused','succeeded','failed','cancelled')),
  plan jsonb,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error text,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after timestamptz,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_org_user_idx ON tasks (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_poll_idx ON tasks (status, run_after, lease_until);

CREATE TABLE IF NOT EXISTS task_steps (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','waiting_approval','succeeded','failed','skipped','cancelled')),
  input jsonb,
  output jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (task_id, position)
);
CREATE INDEX IF NOT EXISTS task_steps_task_idx ON task_steps (task_id, position);
-- Existing deployments predate step-level attempt counts; keep this statement so
-- applying the schema is always safe and upgrades older databases in place.
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq bigserial NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  detail text,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, seq);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id text,
  kind text NOT NULL,
  summary text NOT NULL,
  payload jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired')),
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals (task_id, created_at);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  task_id text REFERENCES tasks(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);
CREATE INDEX IF NOT EXISTS artifacts_org_idx ON artifacts (org_id, created_at DESC);

-- Artifact bytes for hosts without a persistent disk (serverless). Kept apart
-- from `artifacts` so listing artifacts never reads large values.
-- No foreign key to `artifacts`: bytes are written first, then the row that
-- describes them, inside the same task step. Deletion of a task cascades through
-- `artifacts`; blobs are removed by the retention job (and are org-scoped here).
CREATE TABLE IF NOT EXISTS artifact_blobs (
  artifact_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  bytes bytea NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_blobs_org_idx ON artifact_blobs (org_id);

CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_org_user_idx ON memories (org_id, user_id, updated_at DESC);
-- Semantic recall. Embeddings are stored as JSON arrays so the same schema works
-- on every Postgres, including the embedded test cluster (no pgvector needed).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding jsonb;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model text;

CREATE TABLE IF NOT EXISTS user_profiles (
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  goal text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('interval','daily')),
  interval_minutes integer,
  hour integer,
  minute integer,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_task_id text REFERENCES tasks(id) ON DELETE SET NULL,
  last_skipped_at timestamptz,
  last_skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing deployments predate overlap protection; make the upgrade in place.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_skip_reason text;
CREATE INDEX IF NOT EXISTS schedules_org_user_idx ON schedules (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_org_user_idx
  ON notifications (org_id, user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_user_id text,
  event_type text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_idx ON audit_events (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  label text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, label)
);

-- Phone pairing and devices are read before a tenant context exists: the
-- device proves itself with a bearer token, and only then do we know its org
-- and user. They are therefore outside RLS and are only ever queried with
-- explicit predicates. Commands and frames carry the tenant columns and are
-- protected.
CREATE TABLE IF NOT EXISTS phone_pairing_codes (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android','ios','bridge')),
  name text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_pairing_codes_expiry_idx
  ON phone_pairing_codes (expires_at);

CREATE TABLE IF NOT EXISTS phone_devices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios','bridge')),
  model text,
  os_version text,
  app_version text,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','revoked')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{"allow_all":true,"screenshots":true}'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS phone_devices_user_idx
  ON phone_devices (org_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS phone_approvals (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES phone_devices(id) ON DELETE CASCADE,
  op text NOT NULL CHECK (op IN ('act','flow')),
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_hash text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired')),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_approvals_pending_idx
  ON phone_approvals (org_id, user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS phone_approvals_device_idx
  ON phone_approvals (device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS phone_commands (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES phone_devices(id) ON DELETE CASCADE,
  run_id text REFERENCES tasks(id) ON DELETE SET NULL,
  step_id text REFERENCES task_steps(id) ON DELETE SET NULL,
  approval_id text REFERENCES approvals(id) ON DELETE SET NULL,
  phone_approval_id text REFERENCES phone_approvals(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  op text NOT NULL CHECK (op IN ('observe','act','flow','apps','status')),
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_hash text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','done','error','expired','cancelled')),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS phone_commands_queue_idx
  ON phone_commands (device_id, status, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS phone_commands_run_idx ON phone_commands (run_id);
-- Existing deployments predate the phone-approval queue. The task approval
-- column stays for task-scoped work; phone actions use their own binding.
ALTER TABLE phone_commands
  ADD COLUMN IF NOT EXISTS phone_approval_id text
  REFERENCES phone_approvals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS phone_commands_phone_approval_idx
  ON phone_commands (phone_approval_id);

-- Latest frame per device. Overwritten, never a history.
CREATE TABLE IF NOT EXISTS phone_frames (
  device_id text PRIMARY KEY REFERENCES phone_devices(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT 0,
  jpeg bytea NOT NULL,
  width integer,
  height integer,
  captured_at timestamptz NOT NULL DEFAULT now()
);

-- Row level security for every tenant table. Missing context => no rows.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations','messages','tasks','task_steps','task_events',
    'approvals','artifacts','artifact_blobs','memories','user_profiles',
    'schedules','notifications','audit_events',
    'provider_credentials','phone_approvals','phone_commands','phone_frames'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = current_setting(''talisman.org_id'', true)) WITH CHECK (org_id = current_setting(''talisman.org_id'', true))',
      t
    );
  END LOOP;
END $$;

-- A non-superuser application role. Talisman switches to it inside every tenant
-- transaction (SET LOCAL ROLE), so RLS applies even when the connected role owns
-- the tables. Without this, a table owner bypasses its own policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talisman_app') THEN
    CREATE ROLE talisman_app NOLOGIN;
  END IF;
  -- The connecting role must be allowed to switch into it. On a superuser this is
  -- implicit; on a managed Postgres (Neon, RDS) the owner is not a superuser, so
  -- without this grant every tenant transaction would fail closed.
  EXECUTE format('GRANT talisman_app TO %I', current_user);
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO talisman_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO talisman_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO talisman_app;
