CREATE TABLE IF NOT EXISTS tracey.investigation_runs (
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  session_id uuid NOT NULL,
  user_message_id uuid NOT NULL,
  result_message_id uuid,
  job_id uuid NOT NULL,
  actor_subject text NOT NULL CHECK (char_length(actor_subject) BETWEEN 1 AND 300),
  actor_roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actor_roles) = 'array'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage text NOT NULL DEFAULT 'queued' CHECK (char_length(stage) BETWEEN 1 AND 100),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_message_id) REFERENCES tracey.investigation_messages (tenant_id, message_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, result_message_id) REFERENCES tracey.investigation_messages (tenant_id, message_id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, job_id) REFERENCES tracey.durable_jobs (tenant_id, job_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS investigation_runs_one_active_per_session_idx
  ON tracey.investigation_runs (tenant_id, session_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS investigation_runs_session_idx
  ON tracey.investigation_runs (tenant_id, session_id, created_at DESC, run_id DESC);

CREATE TABLE IF NOT EXISTS tracey.investigation_run_steps (
  tenant_id text NOT NULL,
  step_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('queued','model','tool','synthesis','complete','retry')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('started','completed','failed','skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, step_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES tracey.investigation_runs (tenant_id, run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS investigation_run_steps_run_idx
  ON tracey.investigation_run_steps (tenant_id, run_id, created_at, step_id);

ALTER TABLE tracey.investigation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.investigation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS investigation_runs_tenant_isolation ON tracey.investigation_runs;
CREATE POLICY investigation_runs_tenant_isolation ON tracey.investigation_runs
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

ALTER TABLE tracey.investigation_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.investigation_run_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS investigation_run_steps_tenant_isolation ON tracey.investigation_run_steps;
CREATE POLICY investigation_run_steps_tenant_isolation ON tracey.investigation_run_steps
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DO $$
DECLARE app_role text := current_setting('tracey.application_role', true);
BEGIN
  IF app_role IS NOT NULL AND app_role <> '' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.investigation_runs TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.investigation_run_steps TO %I', app_role);
  END IF;
END
$$;
