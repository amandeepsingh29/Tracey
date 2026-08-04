CREATE TABLE IF NOT EXISTS tracey.website_scan_investigations (
  tenant_id text NOT NULL,
  scan_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scan_id),
  UNIQUE (tenant_id, session_id),
  FOREIGN KEY (tenant_id, scan_id) REFERENCES tracey.website_scans (tenant_id, scan_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id) REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE CASCADE
);

ALTER TABLE tracey.website_scan_investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.website_scan_investigations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_scan_investigations_tenant_isolation ON tracey.website_scan_investigations;
CREATE POLICY website_scan_investigations_tenant_isolation ON tracey.website_scan_investigations
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DO $$
DECLARE app_role text := current_setting('tracey.application_role', true);
BEGIN
  IF app_role IS NOT NULL AND app_role <> '' THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tracey.website_scan_investigations TO %I', app_role);
  END IF;
END
$$;
