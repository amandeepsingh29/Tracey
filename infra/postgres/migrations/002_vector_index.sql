-- Run outside a transaction after the base migration. CONCURRENTLY avoids blocking production writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS diagnosis_snapshots_embedding_hnsw_idx
  ON tracey.diagnosis_snapshots USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
