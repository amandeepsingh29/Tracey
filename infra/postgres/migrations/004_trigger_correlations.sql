ALTER TABLE tracey.trigger_executions
  ALTER COLUMN trace_id DROP NOT NULL;

ALTER TABLE tracey.trigger_executions
  ADD COLUMN IF NOT EXISTS correlation_type text,
  ADD COLUMN IF NOT EXISTS correlation_id text;

UPDATE tracey.trigger_executions
   SET correlation_type = 'trace', correlation_id = trace_id
 WHERE correlation_type IS NULL;

ALTER TABLE tracey.trigger_executions
  ALTER COLUMN correlation_type SET NOT NULL,
  ALTER COLUMN correlation_id SET NOT NULL;

ALTER TABLE tracey.trigger_executions
  ADD CONSTRAINT trigger_execution_correlation_type_check
  CHECK (correlation_type IN ('trace', 'codex_conversation')),
  ADD CONSTRAINT trigger_execution_correlation_id_check
  CHECK (
    (correlation_type = 'trace' AND correlation_id ~ '^[a-fA-F0-9]{32}$') OR
    (correlation_type = 'codex_conversation' AND correlation_id ~ '^[a-fA-F0-9-]{36}$')
  );
