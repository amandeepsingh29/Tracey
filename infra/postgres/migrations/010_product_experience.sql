CREATE TABLE IF NOT EXISTS tracey.incidents (
  tenant_id text NOT NULL,
  incident_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status text NOT NULL CHECK (status IN ('open', 'investigating', 'monitoring', 'resolved', 'dismissed')),
  environment text NOT NULL CHECK (char_length(environment) BETWEEN 1 AND 100),
  affected_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(affected_agent_ids) = 'array'),
  owner text,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  investigation_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, incident_id),
  FOREIGN KEY (tenant_id, investigation_session_id) REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tracey.incident_events (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 300),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES tracey.incidents (tenant_id, incident_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incidents_inbox_idx ON tracey.incidents (tenant_id, status, severity, started_at DESC);
CREATE INDEX IF NOT EXISTS incident_events_timeline_idx ON tracey.incident_events (tenant_id, incident_id, created_at, event_id);

ALTER TABLE tracey.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE tracey.incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.incident_events FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant_isolation ON tracey.incidents
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
CREATE POLICY incident_events_tenant_isolation ON tracey.incident_events
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

CREATE TABLE IF NOT EXISTS tracey.notification_preferences (
  tenant_id text NOT NULL,
  subject text NOT NULL,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject)
);
ALTER TABLE tracey.notifications ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE tracey.notifications ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE tracey.notifications ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'system'
  CHECK (category IN ('incident','approval','failure','recovery','connector','system'));
ALTER TABLE tracey.notifications ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE tracey.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_tenant_isolation ON tracey.notification_preferences
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

CREATE TABLE IF NOT EXISTS tracey.connector_configs (
  tenant_id text NOT NULL,
  connector_id text NOT NULL CHECK (connector_id IN ('signoz','kubernetes','codex','claude-code','generic-otel','mcp')),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(public_config) = 'object' AND pg_column_size(public_config) <= 32768),
  encrypted_secrets text,
  secret_names jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(secret_names) = 'array'),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'needs_configuration' CHECK (status IN ('ready','unhealthy','needs_configuration','disabled')),
  effective_identity text,
  last_checked_at timestamptz,
  latest_error text,
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id)
);
ALTER TABLE tracey.connector_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.connector_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_configs_tenant_isolation ON tracey.connector_configs
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

CREATE TABLE IF NOT EXISTS tracey.connector_events (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  connector_id text NOT NULL,
  operation text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_id)
);
CREATE INDEX IF NOT EXISTS connector_events_audit_idx ON tracey.connector_events (tenant_id,connector_id,created_at DESC);
ALTER TABLE tracey.connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.connector_events FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_events_tenant_isolation ON tracey.connector_events
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

CREATE TABLE IF NOT EXISTS tracey.autonomy_policy_versions (
  tenant_id text NOT NULL,
  policy_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('global','agent','service')),
  scope_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  enabled boolean NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id, version)
);
ALTER TABLE tracey.autonomy_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.autonomy_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY autonomy_policy_versions_tenant_isolation ON tracey.autonomy_policy_versions
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

ALTER TABLE tracey.action_proposals ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE tracey.action_proposals ADD COLUMN IF NOT EXISTS scheduled_by text;
CREATE INDEX IF NOT EXISTS action_proposals_schedule_idx ON tracey.action_proposals (tenant_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL AND status IN ('approved','approved_for_auto_execution');
