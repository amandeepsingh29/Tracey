# MCP integrations

Tracey supports both sides of MCP:

- It can observe an agent calling one real external Streamable HTTP MCP server. Tracey discovers server-advertised tools, applies a local read-only policy, invokes allowed tools, and exports operation metadata through OpenTelemetry.
- It exposes its own read-only investigation tools over authenticated Streamable HTTP and local stdio, allowing Codex or another MCP client to investigate real SigNoz telemetry.

Both implementations use the stable `@modelcontextprotocol/sdk` v1 client/server package.

## Observe an external MCP server

Set the server URL and an explicit comma-separated allowlist in `.env`:

```dotenv
MCP_SERVER_URL=https://your-mcp-server.example/mcp
MCP_SERVER_NAME=production-knowledge-server
MCP_BEARER_TOKEN=replace-with-a-real-token-if-required
MCP_ALLOWED_READ_TOOLS=knowledge.search,orders.lookup
MCP_CONNECT_TIMEOUT_MS=10000
MCP_TOOL_TIMEOUT_MS=15000
```

An empty allowlist permits discovery but denies every call. A listed tool is still denied when the server marks it destructive, explicitly marks it non-read-only, or requires MCP task support. Tracey does not infer that an unannotated tool is safe; the local allowlist owner is responsible for reviewing its real behavior.

## Discover and call

Discover the configured server's real tools and policy decisions:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  http://localhost:3000/v1/mcp/tools
```

Invoke an advertised and allowed read tool:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"toolName":"knowledge.search","arguments":{"query":"your real query"}}' \
  http://localhost:3000/v1/mcp/call
```

The request is rejected before network execution if its JSON arguments exceed 64 KiB. Tool discovery is bounded to 500 tools and 1 MiB of schema data, and results are bounded to 1 MiB. Timeouts are finite and hidden transport retries are disabled.

## Telemetry and content handling

Every allowed call creates a tool span containing the tool name, schema hash, MCP server name/version, duration, status, and result class. Arguments and results are not attached to spans or operational logs. The API returns the real MCP result to its authenticated caller; deployment-level authentication and authorization must be added before exposing this endpoint outside a trusted network.

## Live verification

With the API running against a real server, discovery can be verified without choosing a workflow:

```bash
pnpm verify:mcp
```

To execute a real allowlisted call, the operator must supply the actual tool and its arguments:

```bash
MCP_VERIFY_TOOL='knowledge.search' \
MCP_VERIFY_ARGUMENTS_JSON='{"query":"your real query"}' \
pnpm verify:mcp
```

TODO: Run this verifier against the selected external MCP deployment. No MCP URL, credentials, or application-specific tool contract is included in this repository.

## Use Tracey as an MCP server

Tracey exposes exactly five tools:

- `tracey_search_agent_runs`
- `tracey_get_trace_investigation`
- `tracey_get_codex_conversation`
- `tracey_query_agent_run_metrics`
- `tracey_compare_agent_cohorts`

All five query the configured live SigNoz API. They are annotated read-only and non-destructive, accept schema-bounded inputs, and cap their serialized result at 1 MiB. The server has no SQL tool, arbitrary query-expression tool, or mutation tool.

### Streamable HTTP

Set `SIGNOZ_API_URL`, `SIGNOZ_API_KEY`, and a separate `TRACEY_MCP_BEARER_TOKEN`, then start the API. The server is available at `http://localhost:3000/mcp`. It remains disabled with an explicit `503` until all three values exist.

The endpoint validates the bearer token using a constant-time comparison and rejects Host headers not listed in `TRACEY_MCP_ALLOWED_HOSTS`. Its JSON-only stateless transport creates an isolated MCP server/transport pair per request, so it can run behind multiple API replicas without in-memory session affinity.

Codex Streamable HTTP configuration:

```toml
[mcp_servers.tracey]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "TRACEY_MCP_BEARER_TOKEN"
enabled_tools = [
  "tracey_search_agent_runs",
  "tracey_get_trace_investigation",
  "tracey_get_codex_conversation",
  "tracey_query_agent_run_metrics",
  "tracey_compare_agent_cohorts",
]
startup_timeout_sec = 10.0
tool_timeout_sec = 20.0
```

### Local stdio

Build the workspace first. The stdio process requires real SigNoz query credentials and starts its own OpenTelemetry service named `tracey-mcp-server`:

```bash
pnpm build
pnpm mcp:stdio
```

Codex stdio configuration, using environment forwarding rather than embedding secrets in TOML:

```toml
[mcp_servers.tracey]
command = "pnpm"
args = ["--dir", "/absolute/path/to/Tracey", "mcp:stdio"]
env_vars = [
  "SIGNOZ_API_URL",
  "SIGNOZ_API_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "DEPLOYMENT_ENVIRONMENT",
  "TRACEY_TENANT_ID",
]
enabled_tools = [
  "tracey_search_agent_runs",
  "tracey_get_trace_investigation",
  "tracey_get_codex_conversation",
  "tracey_query_agent_run_metrics",
  "tracey_compare_agent_cohorts",
]
startup_timeout_sec = 10.0
tool_timeout_sec = 20.0
```

Codex CLI, desktop, and IDE clients share MCP configuration. Restart the client after changing it, then use `/mcp` to inspect the connected tools.

TODO: Execute an investigation tool against the selected live SigNoz deployment. Protocol initialization, authentication rejection, and discovery are tested over a real HTTP socket, but external SigNoz credentials are not configured in this workspace.

Official protocol client reference: [MCP TypeScript SDK client guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md).
