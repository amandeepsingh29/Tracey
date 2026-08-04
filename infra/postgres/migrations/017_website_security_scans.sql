CREATE TABLE IF NOT EXISTS tracey.website_targets (
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 128),
  target_id uuid NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 2048),
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'verified', 'disabled')),
  verification_token_hash text NOT NULL CHECK (verification_token_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  verified_by text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, target_id),
  UNIQUE (tenant_id, origin)
);

CREATE TABLE IF NOT EXISTS tracey.website_scans (
  tenant_id text NOT NULL,
  scan_id uuid NOT NULL,
  target_id uuid NOT NULL,
  job_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_by text NOT NULL,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 1048576)),
  error_type text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scan_id),
  FOREIGN KEY (tenant_id, target_id) REFERENCES tracey.website_targets (tenant_id, target_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES tracey.durable_jobs (tenant_id, job_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS website_scans_target_idx
  ON tracey.website_scans (tenant_id, target_id, created_at DESC);

ALTER TABLE tracey.website_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.website_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_targets_tenant_isolation ON tracey.website_targets;
CREATE POLICY website_targets_tenant_isolation ON tracey.website_targets
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

ALTER TABLE tracey.website_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.website_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_scans_tenant_isolation ON tracey.website_scans;
CREATE POLICY website_scans_tenant_isolation ON tracey.website_scans
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DO $$
DECLARE app_role text := current_setting('tracey.application_role', true);
BEGIN
  IF app_role IS NOT NULL AND app_role <> '' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.website_targets TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.website_scans TO %I', app_role);
  END IF;
END
$$;
