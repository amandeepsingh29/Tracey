ALTER TABLE tracey.executor_receipts
  DROP CONSTRAINT IF EXISTS executor_receipts_proposal_fk;

ALTER TABLE tracey.executor_receipts
  ADD CONSTRAINT executor_receipts_proposal_fk
  FOREIGN KEY (tenant_id, proposal_id)
  REFERENCES tracey.action_proposals (tenant_id, proposal_id)
  ON DELETE CASCADE
  NOT VALID;
