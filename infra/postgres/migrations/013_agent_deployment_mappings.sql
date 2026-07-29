CREATE TABLE IF NOT EXISTS tracey.agent_deployment_mappings (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  agent_id uuid NOT NULL,
  connector_id text NOT NULL DEFAULT 'kubernetes' CHECK (connector_id = 'kubernetes'),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 253),
  workload_kind text NOT NULL DEFAULT 'Deployment' CHECK (workload_kind = 'Deployment'),
  workload_name text NOT NULL CHECK (length(workload_name) BETWEEN 1 AND 253),
  container_name text CHECK (container_name IS NULL OR length(container_name) BETWEEN 1 AND 253),
  validated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES tracey.agent_integrations (tenant_id, agent_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_deployment_mappings_target_idx
  ON tracey.agent_deployment_mappings (tenant_id, namespace, workload_name);

ALTER TABLE tracey.agent_deployment_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.agent_deployment_mappings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_deployment_mappings_tenant_policy ON tracey.agent_deployment_mappings;
CREATE POLICY agent_deployment_mappings_tenant_policy ON tracey.agent_deployment_mappings
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
