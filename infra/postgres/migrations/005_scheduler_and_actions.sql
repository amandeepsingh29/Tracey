ALTER TABLE tracey.investigation_triggers
  ADD COLUMN IF NOT EXISTS next_poll_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz;

CREATE INDEX IF NOT EXISTS investigation_triggers_due_idx
  ON tracey.investigation_triggers (tenant_id, next_poll_at)
  WHERE enabled AND kind IN ('error_run', 'latency');

CREATE UNIQUE INDEX IF NOT EXISTS trigger_execution_once_idx
  ON tracey.trigger_executions (tenant_id, trigger_id, correlation_type, correlation_id);

CREATE TABLE IF NOT EXISTS tracey.action_proposals (
  tenant_id text NOT NULL,
  proposal_id uuid NOT NULL,
  session_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('notification', 'ticket', 'restart', 'rollback', 'config_change')),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(parameters) <= 16384),
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed')),
  proposed_by text NOT NULL,
  approved_by text,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  executed_at timestamptz,
  PRIMARY KEY (tenant_id, proposal_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, session_id) REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE CASCADE
);

ALTER TABLE tracey.action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.action_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY action_proposals_tenant_isolation ON tracey.action_proposals
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
