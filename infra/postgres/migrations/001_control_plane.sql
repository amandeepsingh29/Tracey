CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS tracey;

CREATE TABLE IF NOT EXISTS tracey.agent_integrations (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  agent_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  service_name text NOT NULL CHECK (length(service_name) BETWEEN 1 AND 255),
  producer_type text NOT NULL CHECK (producer_type IN ('codex_desktop', 'codex_cli', 'claude_code', 'custom_otel')),
  environment text NOT NULL CHECK (length(environment) BETWEEN 1 AND 128),
  normalization_profile text NOT NULL CHECK (length(normalization_profile) BETWEEN 1 AND 64),
  telemetry_contract_version text NOT NULL CHECK (length(telemetry_contract_version) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id),
  UNIQUE (tenant_id, service_name, environment)
);

CREATE TABLE IF NOT EXISTS tracey.diagnosis_snapshots (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  snapshot_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 64),
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 255),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 20000),
  diagnosis jsonb NOT NULL,
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, snapshot_id),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES tracey.agent_integrations (tenant_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_integrations_tenant_created_idx
  ON tracey.agent_integrations (tenant_id, created_at DESC, agent_id DESC);
CREATE INDEX IF NOT EXISTS diagnosis_snapshots_tenant_created_idx
  ON tracey.diagnosis_snapshots (tenant_id, created_at DESC, snapshot_id DESC);

ALTER TABLE tracey.agent_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.agent_integrations FORCE ROW LEVEL SECURITY;
ALTER TABLE tracey.diagnosis_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracey.diagnosis_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_integrations_tenant_policy ON tracey.agent_integrations;
CREATE POLICY agent_integrations_tenant_policy ON tracey.agent_integrations
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));

DROP POLICY IF EXISTS diagnosis_snapshots_tenant_policy ON tracey.diagnosis_snapshots;
CREATE POLICY diagnosis_snapshots_tenant_policy ON tracey.diagnosis_snapshots
  USING (tenant_id = current_setting('tracey.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('tracey.tenant_id', true));
