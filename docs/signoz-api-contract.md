# SigNoz API contract

Tracey targets the documented SigNoz v5 Query Range API:

```text
POST /api/v5/query_range
SIGNOZ-API-KEY: <service-account key>
```

The current parser is based on the official SigNoz v0.132.2 OpenAPI contract. The endpoint wraps results as `status` plus `data`. Raw queries return `data.data.results[]`, where each result contains `rows[]`; each row contains an RFC 3339 timestamp and a map of the explicitly selected telemetry fields.

Tracey issues builder queries only. It does not grant clients arbitrary ClickHouse SQL access.

Implemented live queries:

- Root `agent.run` trace search.
- All spans for a bounded trace ID and time range.
- Logs correlated by trace ID.
- `tracey.agent.runs` counter as a time series grouped by agent and outcome.

All queries enforce a seven-day maximum time range. Trace search is capped at 200 roots, trace detail at 10,000 spans, and correlated logs at 1,000 records per request. A returned cursor is exposed as incomplete evidence rather than silently discarded.

The parser rejects a successful HTTP response when it does not match the documented raw or time-series response contract. This prevents a SigNoz upgrade from silently producing incorrect Tracey diagnoses.

The v5 raw-log Query API is live-verified for exact Codex conversation normalization. `pnpm verify:live` remains the production gate for native `agent.run` trace search, full trace/log investigation, and the agent-run metric against an onboarded custom agent service.

References:

- [SigNoz v0.132.2 API reference](https://signoz.io/api-reference/v0.132.2)
- [Trace search API examples](https://signoz.io/docs/traces-management/trace-api/search-traces/)
- [Trace API payload model](https://signoz.io/docs/traces-management/trace-api/payload-model/)
