ALTER TABLE tracey.investigation_messages
  ADD COLUMN IF NOT EXISTS grounding text,
  ADD COLUMN IF NOT EXISTS tool_call_count integer;

ALTER TABLE tracey.investigation_messages
  DROP CONSTRAINT IF EXISTS investigation_messages_grounding_values;

ALTER TABLE tracey.investigation_messages
  ADD CONSTRAINT investigation_messages_grounding_values
  CHECK (grounding IS NULL OR grounding IN ('evidence_bound', 'tool_grounded', 'model_only'));

ALTER TABLE tracey.investigation_messages
  DROP CONSTRAINT IF EXISTS investigation_messages_tool_call_count_bounds;

ALTER TABLE tracey.investigation_messages
  ADD CONSTRAINT investigation_messages_tool_call_count_bounds
  CHECK (tool_call_count IS NULL OR tool_call_count BETWEEN 0 AND 100);
