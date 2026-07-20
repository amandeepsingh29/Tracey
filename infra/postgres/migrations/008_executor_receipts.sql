CREATE TABLE IF NOT EXISTS tracey.executor_receipts (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  proposal_id uuid NOT NULL,
  action_hash text NOT NULL CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('executing', 'succeeded', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

ALTER TABLE tracey.executor_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.executor_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS executor_receipts_tenant_isolation ON tracey.executor_receipts;
CREATE POLICY executor_receipts_tenant_isolation ON tracey.executor_receipts
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
