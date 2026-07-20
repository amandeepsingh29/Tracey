CREATE TABLE IF NOT EXISTS tracey.autonomy_policies (
  tenant_id text NOT NULL,
  policy_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'agent', 'service')),
  scope_id text NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 255),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object' AND pg_column_size(policy) <= 32768),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 300),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id),
  UNIQUE (tenant_id, scope_type, scope_id)
);

ALTER TABLE tracey.action_proposals DROP CONSTRAINT IF EXISTS action_proposals_action_type_check;
ALTER TABLE tracey.action_proposals ADD CONSTRAINT action_proposals_action_type_check CHECK (
  action_type IN ('notification', 'ticket', 'restart', 'rollback', 'scale', 'resource_change', 'config_change')
);

ALTER TABLE tracey.action_proposals DROP CONSTRAINT IF EXISTS action_proposals_status_check;
ALTER TABLE tracey.action_proposals ADD CONSTRAINT action_proposals_status_check CHECK (
  status IN (
    'proposed', 'policy_evaluated', 'awaiting_approval', 'approved_for_auto_execution',
    'approved', 'rejected', 'executing', 'verifying', 'succeeded', 'failed',
    'reverting', 'reverted', 'revert_failed', 'executed'
  )
);

ALTER TABLE tracey.action_proposals
  ADD COLUMN IF NOT EXISTS remediation_plan jsonb,
  ADD COLUMN IF NOT EXISTS policy_id uuid,
  ADD COLUMN IF NOT EXISTS policy_decision jsonb,
  ADD COLUMN IF NOT EXISTS requester_identity text,
  ADD COLUMN IF NOT EXISTS model_identity text,
  ADD COLUMN IF NOT EXISTS pre_action_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS execution_result jsonb,
  ADD COLUMN IF NOT EXISTS verification_result jsonb,
  ADD COLUMN IF NOT EXISTS rollback_result jsonb,
  ADD COLUMN IF NOT EXISTS state_updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS tracey.action_events (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 300),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES tracey.action_proposals (tenant_id, proposal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS action_proposals_active_idx ON tracey.action_proposals (tenant_id, state_updated_at)
  WHERE status IN ('approved_for_auto_execution', 'approved', 'executing', 'verifying', 'reverting');
CREATE INDEX IF NOT EXISTS action_events_proposal_idx ON tracey.action_events (tenant_id, proposal_id, created_at, event_id);

ALTER TABLE tracey.autonomy_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.autonomy_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE tracey.action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.action_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autonomy_policies_tenant_isolation ON tracey.autonomy_policies;
CREATE POLICY autonomy_policies_tenant_isolation ON tracey.autonomy_policies
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DROP POLICY IF EXISTS action_events_tenant_isolation ON tracey.action_events;
CREATE POLICY action_events_tenant_isolation ON tracey.action_events
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
