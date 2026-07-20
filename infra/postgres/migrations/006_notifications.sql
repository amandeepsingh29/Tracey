CREATE TABLE IF NOT EXISTS tracey.notifications (
  tenant_id text NOT NULL,
  notification_id uuid NOT NULL,
  session_id uuid,
  trigger_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  correlation_type text NOT NULL CHECK (correlation_type IN ('trace', 'codex_conversation', 'system')),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notification_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, trigger_id) REFERENCES tracey.investigation_triggers (tenant_id, trigger_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON tracey.notifications (tenant_id, (read_at IS NULL) DESC, created_at DESC, notification_id DESC);

ALTER TABLE tracey.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON tracey.notifications
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
