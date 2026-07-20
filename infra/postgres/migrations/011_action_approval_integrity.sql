ALTER TABLE tracey.action_proposals
  ADD COLUMN IF NOT EXISTS approval_fingerprint text;

ALTER TABLE tracey.action_proposals
  DROP CONSTRAINT IF EXISTS action_proposals_approval_fingerprint_format;

ALTER TABLE tracey.action_proposals
  ADD CONSTRAINT action_proposals_approval_fingerprint_format
  CHECK (approval_fingerprint IS NULL OR approval_fingerprint ~ '^[a-f0-9]{64}$');
