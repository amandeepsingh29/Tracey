# Tracey self-observability

Tracey exports its own operational telemetry through the same OpenTelemetry Collector used for agent telemetry. This distinguishes failures in the observed agent from failures in Tracey's SigNoz query and analysis path.

## SigNoz adapter

Every call to the real SigNoz v5 Query Range API creates a `signoz.query_range` client span. The span records:

- bounded operation: `search_agent_runs`, `trace_spans`, `trace_logs`, `codex_logs`, `agent_run_metrics`, or `cohort_spans`;
- SigNoz server hostname and HTTP status;
- Query Range server duration, rows scanned, and bytes scanned when returned by SigNoz;
- classified outcome and exception type on failure;
- `tracey.content.capture=none`.

Active W3C trace context is injected into the outbound request. The following metrics use only enumerated operation/outcome attributes:

- `tracey.signoz.adapter.requests`
- `tracey.signoz.adapter.errors`
- `tracey.signoz.adapter.duration`

Failure outcomes are `invalid_request`, `timeout`, `network_error`, `http_error`, `invalid_response`, or `internal_error`. Operational error logs contain the operation, outcome, HTTP status when available, and exception type.

The API key, Query Range payload, response body, error message, and trace/run identifiers are never metric attributes or operational-log fields.

## Investigation and diagnosis

Trace-detail processing creates a `tracey.investigate_trace` internal span. Codex normalization creates `tracey.investigate_codex_conversation`, and cohort comparison creates `tracey.compare_cohorts`. They export:

- `tracey.investigation.requests`
- `tracey.investigation.duration`
- `tracey.investigation.diagnosis.duration`
- `tracey.investigation.evidence.completeness`

Metric outcomes are bounded to `complete`, `incomplete`, `not_found`, `error`, `success`, or `invalid_graph`, depending on the instrument. The investigated trace ID is recorded only on the investigation span, where it is needed for debugging; it is not a metric dimension.

If the correlated-log query fails but span analysis can continue, Tracey emits a warning and marks the returned evidence incomplete. It does not silently claim that logs were absent.

## Live verification

Run the API and collector with real SigNoz credentials, set `TRACEY_VERIFY_SERVICE_NAME` to an onboarded production agent, execute `pnpm verify:live`, and inspect the `tracey-api` and `tracey-mcp-server` services in SigNoz. The verification queries existing agent telemetry; it never launches an agent inside Tracey.

TODO: Record production screenshots/query links after a native `agent.run` producer passes the live verifier. Repository fixtures are intentionally not substituted for exported telemetry.
