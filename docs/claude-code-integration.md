# Claude Code telemetry integration

Claude Code can export native OpenTelemetry metrics, logs, and beta traces to Tracey's collector. Tracey preserves the native SigNoz data and adapts it at query time; the collector does not rename Claude spans.

## Export to the local collector

Set these variables in the environment that launches Claude Code:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Do not enable prompt, assistant-response, tool-detail, or raw API-body capture. Those flags are intentionally absent. The production collector also deletes identity, host paths, commands, file paths, tool inputs/parameters, request and response bodies, and standardized GenAI content before forwarding any signal to SigNoz.

Claude Code currently emits service name `claude-code`. Its native trace hierarchy uses:

- `claude_code.interaction` for a user interaction root
- `claude_code.llm_request` for model requests
- `claude_code.tool` for tool calls
- `claude_code.tool.blocked_on_user` and `claude_code.tool.execution` below tool calls

Tracing is documented as beta, so Tracey pins the mapping as `claude-code-native-beta@1`. A new Claude telemetry shape requires a new normalization profile and contract verification; it must not silently change the existing mapping.

## Register the production identity

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "displayName":"Production Claude Code",
    "serviceName":"claude-code",
    "producerType":"claude_code",
    "environment":"production",
    "normalizationProfile":"claude-code-native-beta@1",
    "telemetryContractVersion":"claude-code-otel@1"
  }' \
  http://localhost:3000/v1/agents
```

Query its observed roots through `GET /v1/agents/{agentId}/runs`. Tracey resolves the registered service, environment, and producer type on the server, queries only `claude_code.interaction` roots using fields guaranteed by the native trace schema, and returns stable `claude:<trace-id>` run IDs. Supplying that run ID later becomes an exact `trace_id` filter; arbitrary filter text is rejected. Keeping the discovery selection minimal matters because SigNoz rejects a query that selects a custom attribute which has never appeared in the workspace.

The full trace is available through `GET /v1/signoz/traces/{traceId}` and remains evidence for graph construction and diagnosis.

## Production validation gate

Before this profile is marked verified:

1. Run a real Claude Code interaction with at least one model request and tool execution.
2. Confirm the collector receives all three signals and SigNoz stores the native hierarchy.
3. Query the registered agent through Tracey and fetch the returned trace.
4. Confirm no prompt, response, command, tool input, raw body, user identity, or host-path content crossed the collector boundary.
5. Record the Claude Code version, observed fields, rejected-row count, and known producer caveats in this document.

Official reference: [Claude Code monitoring usage](https://code.claude.com/docs/en/monitoring-usage).
