# Codex telemetry integration

Codex exports OpenTelemetry logs and traces to the same collector used by Tracey. For developer workstations, Tracey can additionally join those observed events to the matching local Codex session file. This provides the complete prompt, assistant responses, tool arguments, command output, and final result in the execution graph without exporting that content back to SigNoz.

Add the following to the user-level Codex configuration (`~/.codex/config.toml`). Telemetry keys belong at user level because Codex intentionally ignores project-level provider and telemetry settings.

```toml
[otel]
environment = "development"
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://localhost:4318/v1/logs"
protocol = "binary"

[otel.trace_exporter."otlp-http"]
endpoint = "http://localhost:4318/v1/traces"
protocol = "binary"
```

With the Tracey collector running, Codex emits real run and tool telemetry to SigNoz. Documented event types include:

- `codex.conversation_starts`
- `codex.api_request`
- `codex.sse_event`
- `codex.user_prompt`
- `codex.tool_decision`
- `codex.tool_result`

Keep `log_user_prompt = false`. Codex then exports prompt length and operational metadata without exporting prompt content. Tool inputs, tool-result output snippets, and account identity metadata can still be present in the native stream. Both production collector configurations delete `prompt`, `output`, generic `arguments`/`result`/`command`, standardized GenAI content/tool fields, `user.email`, `user.account_id`, and `host.name` before export.

The execution-detail page restores developer transparency locally by reading the corresponding session under `~/.codex/sessions`. Set `TRACEY_CODEX_SESSIONS_DIR` when Codex uses a different home, and set `TRACEY_LOCAL_FORENSIC_MODE=false` to disable local content access. Detected credential values remain protected until an administrator deliberately selects **Reveal sensitive values** for the current browser session. The reveal response is authenticated, marked `no-store`, and is not supplied to Tracey's investigation model.

## Tracey normalization

Tracey queries events by bounded `conversation.id`, service, tenant, environment, and time range. It segments each `codex.user_prompt` into a turn and projects observed `response.completed`, tool-decision, and tool-result events into an `agent.run` graph. The projection includes model and token usage, tool duration/outcome, source event references, completeness, and deterministic diagnosis.

The desktop app emits its task telemetry as service `codex-app-server`; this is the API and verifier default. Standalone `codex exec`/CLI processes emit service `Codex Desktop`, which can be selected with the `serviceName` query parameter or `TRACEY_CODEX_SERVICE_NAME="Codex Desktop"`.

HTTP:

```text
GET /v1/signoz/codex/conversations/{conversationId}?start={epoch_ms}&end={epoch_ms}
GET /v1/executions/codex/{conversationId}/graph?start={epoch_ms}&end={epoch_ms}&at={epoch_ms}
```

In the web product, open **Runs**, select a Codex execution, and use the default **Graph** tab. The same page also provides **Timeline**, **Evidence**, and **Raw events** views.

MCP: `tracey_get_codex_conversation`.

Live verifier:

```bash
TRACEY_API_TOKEN=... \
TRACEY_CODEX_CONVERSATION_ID=... \
TRACEY_CODEX_SERVICE_NAME=codex-app-server \
TRACEY_CODEX_START=... \
TRACEY_CODEX_END=... \
pnpm verify:codex
```

Codex events within one turn can carry multiple source trace IDs, and some `response.completed` events have no trace context. Tracey therefore creates deterministic projection IDs and marks `tracey.source.derived_trace_id=true`; it preserves the original log trace/span references separately. It never presents a projection ID as a native Codex trace ID. A missing completion, rejected row, or SigNoz cursor lowers evidence completeness.

The mapping version is `codex-otel-0.144@1`. It was derived from a live, ephemeral `codex-cli 0.144.4` execution on 2026-07-16 with prompt logging disabled. That capture observed the documented events and the concrete fields `conversation.id`, `event.timestamp`, `model`, `app.version`, token counts, tool name, decision, success, and duration. The raw capture remains outside the repository because native telemetry included machine/account metadata before collector redaction.

## Let Codex investigate Tracey

Tracey also exposes read-only SigNoz investigation tools through MCP. This is separate from exporting Codex telemetry: telemetry export lets Tracey observe Codex, while the MCP server lets Codex query Tracey.

Use either the authenticated Streamable HTTP endpoint or the local stdio server configuration in [mcp-integration.md](mcp-integration.md). Codex CLI, desktop, and IDE clients share `config.toml` MCP settings, and `/mcp` shows the connected tools.

## Live SigNoz verification

On 2026-07-16, a real Codex 0.144.4 task using ChatGPT authentication and an `exec_command` tool call was exported through `collector-cloud.yaml` to the selected SigNoz Cloud `us2` workspace. The hosted SigNoz MCP server returned service `Codex Desktop` and 21 log rows for CLI conversation `019f697a-67d9-7a20-8956-98b8bb9fe7ed`, including conversation start, prompt-length-only, response completion, tool decision, and tool result events. After restarting the desktop app, SigNoz returned service `codex-app-server` and the current desktop task ID `019f68cf-12e1-7871-9fa6-e3a6325f3a48` with live conversation, model, decision, and tool events.

The first canary exposed Codex's tool input under the generic `arguments` key rather than only the standardized GenAI key. The production and contract collectors now delete `arguments`, `result`, and `command` as well. A second exact-conversation MCP query verified that none of `prompt`, `output`, `arguments`, `result`, `command`, `user.email`, `user.account_id`, `host.name`, or standardized GenAI tool-content keys were present in any of the 21 returned rows.

Tracey's production Query API route was live-verified against this exact desktop task on 2026-07-16. `pnpm verify:codex` authenticated with a SigNoz Service Account key, queried 938 rows / 274,485 bytes in the bounded window, normalized two turns with `codex-otel-0.144@1`, and rejected zero logs. The projected roots were `agent.run` spans and retained `tracey.content.capture=none`; transcript JSONL was not used.

The same live sample exposed a producer-version caveat. Codex Desktop 0.144.2 emitted `success=false` for all 59 sampled `codex.tool_result` rows even though `error.type` was empty and several calls visibly completed. The Codex telemetry contract defines `success` as an emitted tool-result field, so normalization preserves it rather than silently rewriting evidence. Tool-failure diagnoses from this producer version must be interpreted with that limitation until a newer Codex capture establishes corrected semantics.

Official reference: [Codex monitoring and telemetry](https://learn.chatgpt.com/docs/agent-approvals-security#monitoring-and-telemetry).
