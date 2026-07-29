import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AppConfig } from "./config.js";
import { buildServer } from "./server.js";

const config: AppConfig = {
  PORT: 3_000,
  LOG_LEVEL: "fatal",
  DEPLOYMENT_ENVIRONMENT: "test",
  TRACEY_TENANT_ID: "tenant-test",
  TRACEY_API_BEARER_TOKEN: "test-api-secret",
  TRACEY_API_TOKEN_ID: "test-key",
  OIDC_TENANT_CLAIM: "tenant_id",
  OIDC_ROLES_CLAIM: "roles",
  TRACEY_AGENT_VERSION: "0.1.0",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  SIGNOZ_QUERY_TIMEOUT_MS: 1_000,
  SIGNOZ_COHORT_TIMEOUT_MS: 2_000,
  POSTGRES_POOL_MAX: 10,
  POSTGRES_IDLE_TIMEOUT_MS: 30_000,
  POSTGRES_STATEMENT_TIMEOUT_MS: 1_000,
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  TRACEY_AGENT_MODEL: "tencent/hy3:free",
  TRACEY_AGENT_TIMEOUT_MS: 60_000,
  TRACEY_KUBERNETES_EXECUTOR_ENABLED: false,
  TRACEY_KUBERNETES_INVESTIGATOR_ENABLED: false,
  TRACEY_KUBERNETES_ALLOWED_NAMESPACES: "",
  TRACEY_KUBERNETES_ALLOWED_WORKLOADS: "",
  MCP_SERVER_NAME: "test-mcp",
  MCP_ALLOWED_READ_TOOLS: "",
  MCP_CONNECT_TIMEOUT_MS: 1_000,
  MCP_TOOL_TIMEOUT_MS: 1_000,
  TRACEY_MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
};
const apiHeaders = { authorization: "Bearer test-api-secret" };

describe("integration configuration gates", () => {
  it("reports integration readiness without exposing secrets", async () => {
    const server = buildServer(config);
    const response = await server.inject({ method: "GET", url: "/health" });
    await server.close();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().integrations, {
      apiAuthentication: "configured",
      signozQueryApi: "not_configured",
      metadataStore: "not_configured",
      agenticInvestigator: "not_configured",
      mcpClient: "not_configured",
      mcpServer: "not_configured",
      otlp: "configured",
      notifications: "not_configured",
      approvedActionExecutor: "not_configured",
    });
  });

  it("refuses to expose a fabricated Tracey MCP investigation server", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no simulated MCP investigation/);
  });

  it("requires API authentication while leaving health available", async () => {
    const server = buildServer(config);
    const disabledServer = buildServer({ ...config, TRACEY_API_BEARER_TOKEN: undefined });
    const health = await server.inject({ method: "GET", url: "/health" });
    const unauthorized = await server.inject({ method: "GET", url: "/v1/mcp/tools" });
    const disabled = await disabledServer.inject({
      method: "GET",
      url: "/v1/mcp/tools",
    });
    await Promise.all([server.close(), disabledServer.close()]);

    assert.equal(health.statusCode, 200);
    assert.equal(unauthorized.statusCode, 401);
    const authenticateHeader = unauthorized.headers["www-authenticate"];
    assert.match(Array.isArray(authenticateHeader) ? authenticateHeader.join(",") : (authenticateHeader ?? ""), /Bearer/);
    assert.equal(disabled.statusCode, 503);
    assert.match(disabled.json().error, /TRACEY_API_BEARER_TOKEN/);
  });

  it("exposes the standalone product connector catalog without application fixtures", async () => {
    const server = buildServer(config);
    const response = await server.inject({ method: "GET", url: "/v1/connectors", headers: apiHeaders });
    await server.close();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().connectors.map(({ id }: { id: string }) => id),
      ["signoz", "kubernetes", "codex", "claude-code", "generic-otel", "mcp"]);
    assert.deepEqual(response.json().agentOnboardingSources, []);
    assert.equal(JSON.stringify(response.json()).toLowerCase().includes("notes-app"), false);
  });

  it("derives agent onboarding sources from ready connectors and defaults to generic OpenTelemetry", async () => {
    const server = buildServer({
      ...config,
      SIGNOZ_API_URL: "http://127.0.0.1:9",
      SIGNOZ_API_KEY: "catalog-only-key",
    });
    const response = await server.inject({ method: "GET", url: "/v1/connectors", headers: apiHeaders });
    await server.close();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().agentOnboardingSources.map(({ sourceId }: { sourceId: string }) => sourceId), ["generic-otel"]);
    assert.equal(response.json().connectors.find(({ id }: { id: string }) => id === "codex").state, "needs_configuration");
    assert.equal(response.json().connectors.find(({ id }: { id: string }) => id === "claude-code").state, "needs_configuration");
  });

  it("keeps product data contracts authenticated and refuses fabricated incident data", async () => {
    const server = buildServer(config);
    const unauthenticated = await server.inject({ method: "GET", url: "/v1/incidents" });
    const unavailable = await server.inject({ method: "GET", url: "/v1/incidents", headers: apiHeaders });
    const notifications = await server.inject({ method: "GET", url: "/v1/notifications", headers: apiHeaders });
    const clearInvestigations = await server.inject({ method: "DELETE", url: "/v1/investigations", headers: apiHeaders });
    await server.close();

    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unavailable.statusCode, 503);
    assert.match(unavailable.json().error, /DATABASE_URL/);
    assert.equal(notifications.statusCode, 503);
    assert.equal(clearInvestigations.statusCode, 503);
    assert.match(clearInvestigations.json().error, /DATABASE_URL/);
  });

  it("tests SigNoz query permissions and reports credential failures without echoing secrets", async () => {
    const fakeSigNoz = createHttpServer((request, response) => {
      if (request.headers["signoz-api-key"] !== "valid-query-key") { response.writeHead(401).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "success", data: { type: "raw", data: { results: [{ queryName: "A", rows: [] }] } } }));
    });
    await new Promise<void>((resolve) => fakeSigNoz.listen(0, "127.0.0.1", resolve));
    const address = fakeSigNoz.address();
    assert.ok(address && typeof address === "object");
    const server = buildServer(config);
    const good = await server.inject({ method: "POST", url: "/v1/connectors/signoz/test", headers: apiHeaders, payload: { apiUrl: `http://127.0.0.1:${address.port}`, apiKey: "valid-query-key" } });
    const bad = await server.inject({ method: "POST", url: "/v1/connectors/signoz/test", headers: apiHeaders, payload: { apiUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret-invalid-key" } });
    await server.close(); await new Promise<void>((resolve) => fakeSigNoz.close(() => resolve()));
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().ok, true);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.body.includes("secret-invalid-key"), false);
  });

  it("serves authenticated read-only tool discovery over real Streamable HTTP", async () => {
    const server = buildServer({
      ...config,
      SIGNOZ_API_URL: "http://127.0.0.1:9",
      SIGNOZ_API_KEY: "unused-during-tool-discovery",
      TRACEY_MCP_BEARER_TOKEN: "test-only-mcp-secret",
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const unauthorized = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: "Bearer test-only-mcp-secret" } },
    });
    const client = new Client({ name: "tracey-http-test", version: "0.1.0" });
    try {
      await client.connect(transport as Transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 5);
      assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses to fabricate MCP discovery or tool results when no server is configured", async () => {
    const server = buildServer(config);
    const discovery = await server.inject({ method: "GET", url: "/v1/mcp/tools" });
    const call = await server.inject({
      method: "POST",
      url: "/v1/mcp/call",
      headers: apiHeaders,
      payload: { toolName: "orders.lookup", arguments: { orderId: "real-id" } },
    });
    const authorizedDiscovery = await server.inject({
      method: "GET",
      url: "/v1/mcp/tools",
      headers: apiHeaders,
    });
    await server.close();

    assert.equal(discovery.statusCode, 401);
    assert.equal(authorizedDiscovery.statusCode, 503);
    assert.match(authorizedDiscovery.json().error, /does not return simulated MCP tools/);
    assert.equal(call.statusCode, 503);
    assert.match(call.json().error, /does not simulate MCP tool calls/);
  });

  it("refuses to fabricate a production agent registry when PostgreSQL is not configured", async () => {
    const server = buildServer(config);
    const create = await server.inject({
      method: "POST",
      url: "/v1/agents",
      headers: apiHeaders,
      payload: {
        displayName: "Codex Production",
        serviceName: "codex-app-server",
        producerType: "codex_desktop",
        environment: "production",
        normalizationProfile: "codex-otel-0.144@1",
        telemetryContractVersion: "tracey-agent-run@1",
      },
    });
    const list = await server.inject({ method: "GET", url: "/v1/agents", headers: apiHeaders });
    await server.close();

    assert.equal(create.statusCode, 503);
    assert.match(create.json().error, /does not keep an in-memory/);
    assert.equal(list.statusCode, 503);
    assert.match(list.json().error, /does not return a fabricated/);
  });

  it("refuses to fabricate a SigNoz query response when it is not configured", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "GET",
      url: "/v1/signoz/agent-runs?start=1&end=2&serviceName=tracey-api",
      headers: apiHeaders,
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no simulated query result/);
  });

  it("refuses to fabricate trace details when SigNoz is not configured", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "GET",
      url: `/v1/signoz/traces/${"a".repeat(32)}?start=1&end=2`,
      headers: apiHeaders,
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no simulated trace/);
  });

  it("refuses to return placeholder metrics when SigNoz is not configured", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "GET",
      url: "/v1/signoz/metrics/agent-runs?start=1&end=2",
      headers: apiHeaders,
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no placeholder metric/);
  });

  it("refuses to fabricate a cohort comparison when SigNoz is not configured", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "POST",
      url: "/v1/signoz/cohorts/compare",
      headers: apiHeaders,
      payload: {
        start: 1,
        end: 2,
        serviceName: "tracey-api",
        dimension: "model",
        baseline: "model-a",
        candidate: "model-b",
      },
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no fabricated cohort comparison/);
  });

  it("refuses to fabricate normalized Codex runs when SigNoz is not configured", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "GET",
      url: "/v1/signoz/codex/conversations/019f692d-ffde-77d1-a3e0-14b849467fdd?start=1&end=2",
      headers: apiHeaders,
    });
    await server.close();

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /no fabricated Codex run/);
  });

  it("accepts bounded feedback for export with the original trace context", async () => {
    const server = buildServer(config);
    const response = await server.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: apiHeaders,
      payload: {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        runId: "run_real",
        source: "thumbs_down",
        label: "slow",
        score: -1,
      },
    });
    await server.close();

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().accepted, true);
  });
});
