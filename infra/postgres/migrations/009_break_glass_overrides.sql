CREATE TABLE IF NOT EXISTS tracey.break_glass_overrides (
  tenant_id text NOT NULL,
  override_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'agent', 'service')),
  scope_id text NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 255),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object' AND pg_column_size(policy) <= 32768),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 20 AND 2000),
  activated_by text NOT NULL CHECK (char_length(activated_by) BETWEEN 1 AND 300),
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  PRIMARY KEY (tenant_id, override_id),
  CHECK (expires_at > activated_at AND expires_at <= activated_at + interval '60 minutes'),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR
         (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND char_length(revocation_reason) BETWEEN 10 AND 2000))
);

CREATE UNIQUE INDEX IF NOT EXISTS break_glass_one_active_scope_idx
  ON tracey.break_glass_overrides (tenant_id, scope_type, scope_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS break_glass_expiry_idx
  ON tracey.break_glass_overrides (tenant_id, expires_at DESC);

ALTER TABLE tracey.break_glass_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.break_glass_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS break_glass_tenant_isolation ON tracey.break_glass_overrides;
CREATE POLICY break_glass_tenant_isolation ON tracey.break_glass_overrides
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
