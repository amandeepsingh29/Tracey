# PostgreSQL and pgvector storage

PostgreSQL is Tracey's control-plane store. SigNoz remains the system of record for raw traces, logs, and metrics; Tracey does not copy that telemetry into PostgreSQL.

## Stored data

The initial schema stores:

- tenant-scoped production-agent registrations;
- non-secret producer type, service, environment, normalization profile, and telemetry-contract version;
- bounded diagnosis snapshots with evidence references;
- 1,536-dimensional embeddings of Tracey-owned diagnosis summaries for semantic incident retrieval.

Provider credentials, prompts, tool arguments, tool results, retrieved documents, and chain-of-thought are not stored.

## Isolation

Both tables include `tenant_id`, use composite primary or foreign keys, enable and force PostgreSQL row-level security, and compare each row to transaction-local `tracey.tenant_id`. The application checks out one pool client, starts a transaction, sets the tenant with a parameterized `set_config` call, runs parameterized SQL on the same client, and commits or rolls back before release.

Tenant scope is server-owned. API request bodies cannot select a tenant.

## Vector index

Diagnosis embeddings use cosine distance and a partial HNSW index. The index migration uses `CREATE INDEX CONCURRENTLY` so it must execute outside a transaction. Search enables pgvector iterative HNSW scans for filtered tenant queries and still applies the tenant predicate explicitly.

The first schema pins 1,536 dimensions. Changing embedding dimensions requires a versioned migration and re-index operation; runtime code rejects vectors of any other size instead of silently mixing incompatible embeddings.

## Migrations

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres/migrations/001_control_plane.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres/migrations/002_vector_index.sql
```

Production deployment must use a non-owner application role with only the required schema/table privileges, TLS verification, managed credential rotation, backups, point-in-time recovery, connection pooling, and migration ownership separated from runtime ownership.

## Live contract verification

On 2026-07-16, migrations ran against PostgreSQL 16.14 with pgvector 0.8.5. The Tracey API registered and listed the live `codex-app-server` producer through PostgreSQL. A transaction scoped to tenant `local` saw one agent while the same query under `different-tenant` saw zero. A 1,536-dimensional diagnosis vector was inserted, returned as the top cosine match with similarity 1, and removed after the check.

References: [pgvector](https://github.com/pgvector/pgvector), [node-postgres transactions](https://node-postgres.com/features/transactions), [node-postgres parameterized queries](https://node-postgres.com/features/queries).
