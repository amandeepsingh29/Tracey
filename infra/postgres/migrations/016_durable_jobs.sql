CREATE TABLE IF NOT EXISTS tracey.durable_jobs (
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 128),
  job_id uuid NOT NULL,
  job_type text NOT NULL CHECK (char_length(job_type) BETWEEN 1 AND 100),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 500),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 32768),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, job_type, dedupe_key),
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS durable_jobs_claim_idx
  ON tracey.durable_jobs (tenant_id, available_at, created_at)
  WHERE status IN ('queued', 'leased');

CREATE INDEX IF NOT EXISTS durable_jobs_dead_letter_idx
  ON tracey.durable_jobs (tenant_id, updated_at DESC)
  WHERE status = 'dead_letter';

ALTER TABLE tracey.durable_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.durable_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS durable_jobs_tenant_isolation ON tracey.durable_jobs;
CREATE POLICY durable_jobs_tenant_isolation ON tracey.durable_jobs
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DO $$
DECLARE app_role text := current_setting('tracey.application_role', true);
BEGIN
  IF app_role IS NOT NULL AND app_role <> '' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.durable_jobs TO %I', app_role);
  END IF;
END
$$;
