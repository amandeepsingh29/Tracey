CREATE TABLE IF NOT EXISTS tracey.investigation_sessions (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE IF NOT EXISTS tracey.investigation_messages (
  tenant_id text NOT NULL,
  message_id uuid NOT NULL,
  session_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS investigation_messages_session_idx
  ON tracey.investigation_messages (tenant_id, session_id, created_at, message_id);

CREATE TABLE IF NOT EXISTS tracey.agent_tool_audit (
  tenant_id text NOT NULL,
  audit_id uuid NOT NULL,
  session_id uuid NOT NULL,
  tool_name text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'error', 'denied')),
  argument_hash text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, audit_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tracey.investigation_triggers (
  tenant_id text NOT NULL,
  trigger_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('trace_webhook', 'error_run', 'latency')),
  threshold double precision,
  lookback_minutes integer NOT NULL DEFAULT 15 CHECK (lookback_minutes BETWEEN 1 AND 10080),
  cooldown_minutes integer NOT NULL DEFAULT 15 CHECK (cooldown_minutes BETWEEN 1 AND 10080),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, trigger_id),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES tracey.agent_integrations (tenant_id, agent_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tracey.trigger_executions (
  tenant_id text NOT NULL,
  execution_id uuid NOT NULL,
  trigger_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (trace_id ~ '^[a-fA-F0-9]{32}$'),
  session_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('started', 'completed', 'failed', 'suppressed')),
  error_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, execution_id),
  FOREIGN KEY (tenant_id, trigger_id)
    REFERENCES tracey.investigation_triggers (tenant_id, trigger_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES tracey.investigation_sessions (tenant_id, session_id) ON DELETE SET NULL
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'investigation_sessions', 'investigation_messages', 'agent_tool_audit',
    'investigation_triggers', 'trigger_executions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE tracey.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE tracey.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON tracey.%I USING (tenant_id = current_setting(''tracey.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''tracey.tenant_id'', true))',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $$;
