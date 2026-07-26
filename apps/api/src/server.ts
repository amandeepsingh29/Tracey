import {
  AgentListQuerySchema,
  AgentRegistrationRequestSchema,
  RegisteredAgentRunSearchSchema,
  AgentRunMetricsSearchSchema,
  AgentFeedbackRequestSchema,
  CohortComparisonSearchSchema,
  CodexConversationSearchSchema,
  McpToolCallRequestSchema,
  TraceDetailsSearchSchema,
  TraceSearchSchema,
} from "@tracey/domain";
import { AutonomyPolicySchema, RemediationPlanSchema } from "@tracey/autonomy";
import { buildConnectorRegistry, ConnectorIdSchema } from "@tracey/connectors";
import { recordExternalAgentFeedback } from "@tracey/instrumentation";
import { InvestigationNotFoundError, InvestigationService } from "@tracey/investigation";
import {
  McpToolArgumentsError,
  McpToolDeniedError,
  McpToolResultSizeError,
  ObservedMcpClient,
} from "@tracey/mcp-client";
import { PostgresStore, actionApprovalIsCurrent, type ConnectorConfigRecord } from "@tracey/postgres-store";
import { SigNozAdapter, SigNozAdapterError } from "@tracey/signoz-adapter";
import Fastify from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createApiAuthenticator, requireRoles } from "./auth.js";
import { createTraceyMcpHttpEndpoint } from "./mcp-http.js";
import { AgenticInvestigator } from "./agentic.js";
import { agentUiHtml } from "./agent-ui.js";
import { ApprovedActionExecutor } from "./action-executor.js";
import { AutonomyService } from "./autonomy-service.js";
import { notificationsUiHtml } from "./notifications-ui.js";
import { ConnectorSecretVault } from "./connector-secrets.js";
import { agentRunsToExecutions, codexLogsToExecutions, type ObservedExecution } from "./execution-feed.js";

export function buildServer(config: AppConfig) {
  const server = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.signoz-api-key",
        "req.body.input",
        "req.body.arguments",
      ],
    },
    bodyLimit: 64 * 1_024,
    requestTimeout: 30_000,
  });
  const apiAuth = createApiAuthenticator({
    ...(config.TRACEY_API_BEARER_TOKEN ? { bearerToken: config.TRACEY_API_BEARER_TOKEN } : {}),
    tokenId: config.TRACEY_API_TOKEN_ID,
    tenantId: config.TRACEY_TENANT_ID,
    ...(config.OIDC_ISSUER_URL && config.OIDC_JWKS_URL && config.OIDC_AUDIENCE ? { oidc: {
      issuer: config.OIDC_ISSUER_URL, jwksUrl: config.OIDC_JWKS_URL, audience: config.OIDC_AUDIENCE,
      tenantClaim: config.OIDC_TENANT_CLAIM, rolesClaim: config.OIDC_ROLES_CLAIM,
    } } : {}),
  });
  const analystAuth = requireRoles(apiAuth, ["analyst", "operator", "admin"]);
  const operatorAuth = requireRoles(apiAuth, ["operator", "admin"]);
  const adminAuth = requireRoles(apiAuth, ["admin"]);
  let signoz =
    config.SIGNOZ_API_URL && config.SIGNOZ_API_KEY
      ? new SigNozAdapter({
          baseUrl: config.SIGNOZ_API_URL,
          apiKey: config.SIGNOZ_API_KEY,
          scope: {
            tenantId: config.TRACEY_TENANT_ID,
            environment: config.DEPLOYMENT_ENVIRONMENT,
          },
          timeoutMs: config.SIGNOZ_QUERY_TIMEOUT_MS,
          cohortTimeoutMs: config.SIGNOZ_COHORT_TIMEOUT_MS,
        })
      : undefined;
  let kubernetesRuntime = {
    executorEnabled: config.TRACEY_KUBERNETES_EXECUTOR_ENABLED,
    investigatorEnabled: config.TRACEY_KUBERNETES_INVESTIGATOR_ENABLED,
    allowedNamespaces: config.TRACEY_KUBERNETES_ALLOWED_NAMESPACES.split(",").map((entry) => entry.trim()).filter(Boolean),
    allowedWorkloads: config.TRACEY_KUBERNETES_ALLOWED_WORKLOADS.split(",").map((entry) => entry.trim()).filter(Boolean),
  };
  const createActionExecutor = () => new ApprovedActionExecutor({
      ...(config.TRACEY_ACTION_WEBHOOK_URL ? { webhookUrl: config.TRACEY_ACTION_WEBHOOK_URL } : {}),
      ...(config.TRACEY_ACTION_WEBHOOK_TOKEN ? { token: config.TRACEY_ACTION_WEBHOOK_TOKEN } : {}),
      ...(config.TRACEY_EXECUTOR_URL ? { executorUrl: config.TRACEY_EXECUTOR_URL } : {}),
      ...(config.TRACEY_EXECUTOR_BEARER_TOKEN ? { executorToken: config.TRACEY_EXECUTOR_BEARER_TOKEN } : {}),
      kubernetesEnabled: kubernetesRuntime.executorEnabled, investigatorEnabled: kubernetesRuntime.investigatorEnabled,
      allowedNamespaces: kubernetesRuntime.allowedNamespaces, allowedWorkloads: kubernetesRuntime.allowedWorkloads,
      ...(signoz ? { observability: signoz } : {}),
    });
  let actionExecutor = createActionExecutor();

  const store = config.DATABASE_URL
    ? new PostgresStore({
        connectionString: config.DATABASE_URL,
        maxConnections: config.POSTGRES_POOL_MAX,
        idleTimeoutMs: config.POSTGRES_IDLE_TIMEOUT_MS,
        statementTimeoutMs: config.POSTGRES_STATEMENT_TIMEOUT_MS,
      })
    : undefined;
  let autonomy = store
    ? new AutonomyService(config.TRACEY_TENANT_ID, config.DEPLOYMENT_ENVIRONMENT, store, actionExecutor)
    : undefined;

  let investigations = signoz ? new InvestigationService(signoz) : undefined;
  let agentic = store && investigations && config.OPENROUTER_API_KEY
    ? new AgenticInvestigator({
        apiKey: config.OPENROUTER_API_KEY,
        baseUrl: config.OPENROUTER_BASE_URL,
        model: config.TRACEY_AGENT_MODEL,
        timeoutMs: config.TRACEY_AGENT_TIMEOUT_MS,
        tenantId: config.TRACEY_TENANT_ID,
        environment: config.DEPLOYMENT_ENVIRONMENT,
        allowedNamespaces: config.TRACEY_KUBERNETES_ALLOWED_NAMESPACES.split(",").map((entry) => entry.trim()).filter(Boolean),
        allowedWorkloads: config.TRACEY_KUBERNETES_ALLOWED_WORKLOADS.split(",").map((entry) => entry.trim()).filter(Boolean),
      }, investigations, store, autonomy)
    : undefined;

  const mcpClient = config.MCP_SERVER_URL
    ? new ObservedMcpClient({
        serverUrl: config.MCP_SERVER_URL,
        serverName: config.MCP_SERVER_NAME,
        allowedReadTools: new Set(
          config.MCP_ALLOWED_READ_TOOLS.split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
        connectTimeoutMs: config.MCP_CONNECT_TIMEOUT_MS,
        toolTimeoutMs: config.MCP_TOOL_TIMEOUT_MS,
        ...(config.MCP_BEARER_TOKEN ? { bearerToken: config.MCP_BEARER_TOKEN } : {}),
      })
    : undefined;
  const traceyMcp =
    investigations && config.TRACEY_MCP_BEARER_TOKEN
      ? createTraceyMcpHttpEndpoint({
          investigations,
          bearerToken: config.TRACEY_MCP_BEARER_TOKEN,
          allowedHosts: new Set(
            config.TRACEY_MCP_ALLOWED_HOSTS.split(",")
              .map((host) => host.trim().toLowerCase())
              .filter(Boolean),
          ),
        })
      : undefined;
  const connectorRegistry = () => buildConnectorRegistry({ signozConfigured: Boolean(signoz),
    kubernetesInvestigatorEnabled: kubernetesRuntime.investigatorEnabled, kubernetesExecutorConfigured: actionExecutor.configured(),
    otlpConfigured: Boolean(config.OTEL_EXPORTER_OTLP_ENDPOINT), mcpClientConfigured: Boolean(mcpClient), mcpServerConfigured: Boolean(traceyMcp) });
  const vaultMaterial = config.TRACEY_CONNECTOR_ENCRYPTION_KEY ?? config.TRACEY_API_BEARER_TOKEN;
  const connectorVault = vaultMaterial && vaultMaterial.length >= 24 ? new ConnectorSecretVault(vaultMaterial) : undefined;
  const rebuildRuntime = () => {
    actionExecutor = createActionExecutor();
    autonomy = store ? new AutonomyService(config.TRACEY_TENANT_ID, config.DEPLOYMENT_ENVIRONMENT, store, actionExecutor) : undefined;
    investigations = signoz ? new InvestigationService(signoz) : undefined;
    agentic = store && investigations && config.OPENROUTER_API_KEY ? new AgenticInvestigator({ apiKey: config.OPENROUTER_API_KEY, baseUrl: config.OPENROUTER_BASE_URL,
      model: config.TRACEY_AGENT_MODEL, timeoutMs: config.TRACEY_AGENT_TIMEOUT_MS, tenantId: config.TRACEY_TENANT_ID, environment: config.DEPLOYMENT_ENVIRONMENT,
      allowedNamespaces: kubernetesRuntime.allowedNamespaces, allowedWorkloads: kubernetesRuntime.allowedWorkloads }, investigations, store, autonomy) : undefined;
  };
  const connectorConfigurationSchema = z.discriminatedUnion("connectorId", [
    z.object({ connectorId: z.literal("signoz"), configuration: z.object({ apiUrl: z.string().url(), apiKey: z.string().min(1).max(4_000), otlpEndpoint: z.string().url().optional(), ingestionKey: z.string().max(4_000).optional() }) }),
    z.object({ connectorId: z.literal("kubernetes"), configuration: z.object({ investigatorEnabled: z.boolean().default(true), executorEnabled: z.boolean().default(false), allowedNamespaces: z.array(z.string().trim().min(1).max(253)).min(1).max(100), allowedWorkloads: z.array(z.string().trim().min(1).max(253)).max(500).default([]) }) }),
    z.object({ connectorId: z.enum(["codex", "claude-code", "generic-otel"]), configuration: z.object({ serviceName: z.string().trim().min(1).max(255), environment: z.string().trim().min(1).max(100).default(config.DEPLOYMENT_ENVIRONMENT) }) }),
    z.object({ connectorId: z.literal("mcp"), configuration: z.object({ serverUrl: z.string().url(), bearerToken: z.string().max(4_000).optional(), allowedReadTools: z.array(z.string().trim().min(1).max(200)).max(200).default([]) }) }),
  ]);
  const applyStoredConnector = (record: ConnectorConfigRecord) => {
    if (!record.enabled || record.status !== "ready") return;
    const secrets = record.encryptedSecrets && connectorVault ? connectorVault.decrypt(record.encryptedSecrets) : {};
    if (record.connectorId === "signoz" && typeof record.publicConfig.apiUrl === "string" && secrets.apiKey) {
      signoz = new SigNozAdapter({ baseUrl: record.publicConfig.apiUrl, apiKey: secrets.apiKey, scope: { tenantId: config.TRACEY_TENANT_ID, environment: config.DEPLOYMENT_ENVIRONMENT }, timeoutMs: config.SIGNOZ_QUERY_TIMEOUT_MS, cohortTimeoutMs: config.SIGNOZ_COHORT_TIMEOUT_MS });
      rebuildRuntime();
    }
    if (record.connectorId === "kubernetes") {
      kubernetesRuntime = { executorEnabled: Boolean(record.publicConfig.executorEnabled), investigatorEnabled: Boolean(record.publicConfig.investigatorEnabled),
        allowedNamespaces: z.array(z.string()).parse(record.publicConfig.allowedNamespaces ?? []), allowedWorkloads: z.array(z.string()).parse(record.publicConfig.allowedWorkloads ?? []) };
      rebuildRuntime();
    }
  };
  const testConnectorConfiguration = async (input: z.infer<typeof connectorConfigurationSchema>) => {
    if (input.connectorId === "signoz") {
      const candidate = new SigNozAdapter({ baseUrl: input.configuration.apiUrl, apiKey: input.configuration.apiKey, scope: { tenantId: config.TRACEY_TENANT_ID, environment: config.DEPLOYMENT_ENVIRONMENT }, timeoutMs: config.SIGNOZ_QUERY_TIMEOUT_MS, cohortTimeoutMs: config.SIGNOZ_COHORT_TIMEOUT_MS });
      await candidate.searchAgentRuns({ start: Date.now() - 300_000, end: Date.now(), serviceName: "tracey-api", limit: 1, offset: 0 });
      return { effectiveIdentity: "SigNoz API key", candidate };
    }
    if (input.connectorId === "kubernetes") {
      const previous = kubernetesRuntime; kubernetesRuntime = { ...input.configuration }; const candidate = createActionExecutor(); kubernetesRuntime = previous;
      if (input.configuration.investigatorEnabled || input.configuration.executorEnabled) await candidate.checkReadiness();
      return { effectiveIdentity: "Kubernetes service account / current kube context", candidate };
    }
    if (input.connectorId === "codex" || input.connectorId === "claude-code" || input.connectorId === "generic-otel") {
      if (!signoz) throw new Error("Connect SigNoz before validating an agent producer");
      return { effectiveIdentity: `OTLP service ${input.configuration.serviceName}` };
    }
    const mcpConfiguration = z.object({ serverUrl: z.string().url(), bearerToken: z.string().optional(), allowedReadTools: z.array(z.string()) }).parse(input.configuration);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), config.MCP_CONNECT_TIMEOUT_MS);
    try { const response = await fetch(mcpConfiguration.serverUrl, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", ...(mcpConfiguration.bearerToken ? { authorization: `Bearer ${mcpConfiguration.bearerToken}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: "tracey-connection-test", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tracey", version: config.TRACEY_AGENT_VERSION } } }) }); if (!response.ok) throw new Error(`MCP server returned HTTP ${response.status}`); return { effectiveIdentity: "Authenticated MCP client" }; } finally { clearTimeout(timeout); }
  };
  const recordConnectorFailure = async (connectorId: ConnectorConfigRecord["connectorId"], error: unknown, actor: string) => {
    if (!store) return;
    const current = await store.getConnectorConfig(config.TRACEY_TENANT_ID, connectorId);
    if (!current) return;
    await store.saveConnectorConfig(config.TRACEY_TENANT_ID, { connectorId, publicConfig: current.publicConfig,
      ...(current.encryptedSecrets ? { encryptedSecrets: current.encryptedSecrets } : {}), secretNames: current.secretNames,
      enabled: current.enabled, status: "unhealthy", ...(current.effectiveIdentity ? { effectiveIdentity: current.effectiveIdentity } : {}),
      latestError: error instanceof Error ? error.message.slice(0, 2_000) : "Connector validation failed", actor });
  };

  server.addHook("onReady", async () => {
    if (!store) return;
    if (connectorVault) {
      const records = await store.listConnectorConfigs(config.TRACEY_TENANT_ID);
      for (const record of records) { try { applyStoredConnector(record); } catch (error) { server.log.error({ err: error, connectorId: record.connectorId }, "Stored connector could not be activated"); } }
    }
    const existingPolicy = await store.getAutonomyPolicy(config.TRACEY_TENANT_ID, "global", "default");
    if (!existingPolicy) {
      await store.upsertAutonomyPolicy(config.TRACEY_TENANT_ID, {
        scopeType: "global",
        scopeId: "default",
        enabled: true,
        actor: "tracey-bootstrap",
        policy: AutonomyPolicySchema.parse({
          mode: "approval",
          environments: [config.DEPLOYMENT_ENVIRONMENT],
          namespaces: kubernetesRuntime.allowedNamespaces.length > 0 ? kubernetesRuntime.allowedNamespaces : ["tracey-unconfigured"],
          workloads: kubernetesRuntime.allowedWorkloads.length > 0 ? kubernetesRuntime.allowedWorkloads : ["tracey-unconfigured"],
          allowedActions: [
            "restart_pod", "restart_workload", "rollback_deployment", "scale_deployment",
            "update_resource_limits", "update_hpa", "retry_job", "suspend_cronjob",
            "resume_cronjob", "apply_config_patch", "restore_previous_config",
            "apply_kubernetes_resource", "patch_kubernetes_resource", "delete_kubernetes_resource",
          ],
          automaticActions: [],
          prohibitedActions: ["read_secrets", "delete_namespace", "delete_database", "arbitrary_shell"],
          minimumConfidence: 0.8,
          maximumAutomaticRisk: "low",
          maxReplicas: 20,
          maxAffectedWorkloads: 5,
          maxUnavailableReplicas: 1,
          maxConcurrentActions: 2,
          cooldownMinutes: 5,
        }),
      });
      server.log.info("Created the default approval-required autonomy policy");
    }
  });

  server.addHook("onClose", async () => {
    await Promise.all([mcpClient?.close(), traceyMcp?.close(), store?.close()]);
  });

  server.get("/health", async () => ({
    status: "ok",
    integrations: {
      apiAuthentication: config.TRACEY_API_BEARER_TOKEN ? "configured" : "not_configured",
      signozQueryApi: signoz ? "configured" : "not_configured",
      metadataStore: store ? "configured" : "not_configured",
      agenticInvestigator: agentic ? "configured" : "not_configured",
      mcpClient: mcpClient ? "configured" : "not_configured",
      mcpServer: traceyMcp ? "configured" : "not_configured",
      notifications: store ? "internal_inbox" : "not_configured",
      approvedActionExecutor: actionExecutor.configured() ? "configured" : "not_configured",
      otlp: "configured",
    },
  }));

  server.get("/agent", async (_request, reply) => reply.type("text/html; charset=utf-8").send(agentUiHtml));
  server.get("/notifs", async (_request, reply) => reply.type("text/html; charset=utf-8").send(notificationsUiHtml));
  server.get("/v1/connectors", { preHandler: apiAuth }, async () => {
    const configurations = store ? await store.listConnectorConfigs(config.TRACEY_TENANT_ID) : [];
    return { connectors: connectorRegistry().map((descriptor) => { const saved = configurations.find((item) => item.connectorId === descriptor.id); return saved ? { ...descriptor, state: saved.enabled ? (saved.status === "ready" ? "ready" : "needs_configuration") : "disabled", statusReason: saved.latestError ?? descriptor.statusReason,
      configuration: { configured: true, enabled: saved.enabled, status: saved.status, secretNames: saved.secretNames, effectiveIdentity: saved.effectiveIdentity, lastCheckedAt: saved.lastCheckedAt, latestError: saved.latestError, publicConfig: saved.publicConfig, updatedAt: saved.updatedAt } } : descriptor; }),
      boundary: "External agents and platforms remain independently deployed; Tracey connects through bounded adapters.", secretStorageAvailable: Boolean(store && connectorVault) };
  });

  server.post("/v1/connectors/:connectorId/test", { preHandler: adminAuth }, async (request, reply) => {
    const parsed = connectorConfigurationSchema.safeParse({ connectorId: (request.params as { connectorId?: string }).connectorId, configuration: request.body });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid connector configuration", issues: parsed.error.issues });
    try { const result = await testConnectorConfiguration(parsed.data); return { ok: true, effectiveIdentity: result.effectiveIdentity, checkedAt: new Date().toISOString() }; }
    catch (error) { request.log.warn({ err: error, connectorId: parsed.data.connectorId }, "Connector test failed"); await recordConnectorFailure(parsed.data.connectorId, error, request.authContext!.subject); return reply.code(422).send({ error: error instanceof Error ? error.message : "Connector validation failed", connectorId: parsed.data.connectorId, retryable: true }); }
  });

  server.put("/v1/connectors/:connectorId/configuration", { preHandler: adminAuth }, async (request, reply) => {
    if (!store || !connectorVault) return reply.code(503).send({ error: "Secure connector storage requires DATABASE_URL and an API bearer token or TRACEY_CONNECTOR_ENCRYPTION_KEY" });
    const parsed = connectorConfigurationSchema.safeParse({ connectorId: (request.params as { connectorId?: string }).connectorId, configuration: request.body });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid connector configuration", issues: parsed.error.issues });
    try {
      const tested = await testConnectorConfiguration(parsed.data);
      let publicConfig: Record<string, unknown> = {}; let secrets: Record<string, string> = {};
      if (parsed.data.connectorId === "signoz") { const { apiKey, ingestionKey, ...visible } = parsed.data.configuration; publicConfig = visible; secrets = { apiKey, ...(ingestionKey ? { ingestionKey } : {}) }; }
      else if (parsed.data.connectorId === "mcp") { const { bearerToken, ...visible } = parsed.data.configuration; publicConfig = visible; secrets = bearerToken ? { bearerToken } : {}; }
      else publicConfig = parsed.data.configuration;
      const saved = await store.saveConnectorConfig(config.TRACEY_TENANT_ID, { connectorId: parsed.data.connectorId, publicConfig,
        ...(Object.keys(secrets).length ? { encryptedSecrets: connectorVault.encrypt(secrets) } : {}), secretNames: Object.keys(secrets), enabled: true, status: "ready", effectiveIdentity: tested.effectiveIdentity, actor: request.authContext!.subject });
      applyStoredConnector(saved);
      return reply.code(201).send({ connectorId: saved.connectorId, enabled: saved.enabled, status: saved.status, publicConfig: saved.publicConfig, secretNames: saved.secretNames,
        effectiveIdentity: saved.effectiveIdentity, lastCheckedAt: saved.lastCheckedAt, updatedAt: saved.updatedAt });
    } catch (error) { request.log.warn({ err: error, connectorId: parsed.data.connectorId }, "Connector configuration failed validation"); await recordConnectorFailure(parsed.data.connectorId, error, request.authContext!.subject); return reply.code(422).send({ error: error instanceof Error ? error.message : "Connector validation failed", retryable: true }); }
  });

  server.patch("/v1/connectors/:connectorId/state", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for connector state" });
    const parsed = z.object({ connectorId: ConnectorIdSchema, enabled: z.boolean() }).safeParse({ ...(request.params as Record<string, unknown>), ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid connector state" });
    const current = await store.getConnectorConfig(config.TRACEY_TENANT_ID, parsed.data.connectorId);
    if (!current) return reply.code(404).send({ error: "Connector configuration not found" });
    const saved = await store.saveConnectorConfig(config.TRACEY_TENANT_ID, { connectorId: current.connectorId, publicConfig: current.publicConfig,
      ...(current.encryptedSecrets ? { encryptedSecrets: current.encryptedSecrets } : {}), secretNames: current.secretNames, enabled: parsed.data.enabled,
      status: parsed.data.enabled ? current.status : "disabled", ...(current.effectiveIdentity ? { effectiveIdentity: current.effectiveIdentity } : {}), actor: request.authContext!.subject });
    if (parsed.data.enabled) applyStoredConnector(saved); else if (saved.connectorId === "signoz") { signoz = undefined; rebuildRuntime(); }
    return { connectorId: saved.connectorId, enabled: saved.enabled, status: saved.status, updatedAt: saved.updatedAt };
  });

  server.delete("/v1/connectors/:connectorId/configuration", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for connector configuration" });
    const id = ConnectorIdSchema.safeParse((request.params as { connectorId?: string }).connectorId);
    if (!id.success) return reply.code(400).send({ error: "Invalid connector ID" });
    const deleted = await store.deleteConnectorConfig(config.TRACEY_TENANT_ID, id.data, request.authContext!.subject);
    if (!deleted) return reply.code(404).send({ error: "Connector configuration not found" });
    if (id.data === "signoz") { signoz = undefined; rebuildRuntime(); }
    return reply.code(204).send();
  });

  server.post("/v1/investigations", { preHandler: analystAuth }, async (request, reply) => {
    if (!agentic) return reply.code(503).send({ error: "Agentic investigation requires PostgreSQL, SigNoz, and OPENROUTER_API_KEY" });
    const parsed = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid investigation session", issues: parsed.error.issues });
    try {
      return reply.code(201).send(await agentic.createSession(parsed.data.title));
    } catch (error) {
      request.log.error({ err: error }, "Investigation session creation failed");
      return reply.code(503).send({ error: "Investigation session could not be created" });
    }
  });

  server.get("/v1/investigations", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for investigation history" });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid investigation query", issues: parsed.error.issues });
    try {
      return { investigations: await store.listInvestigationSessions(config.TRACEY_TENANT_ID, parsed.data.limit) };
    } catch (error) {
      request.log.error({ err: error }, "Investigation session query failed");
      return reply.code(503).send({ error: "Investigation history could not be queried" });
    }
  });

  server.delete("/v1/investigations", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for investigation history" });
    try {
      return await store.clearInvestigationHistory(config.TRACEY_TENANT_ID);
    } catch (error) {
      request.log.error({ err: error }, "Investigation history deletion failed");
      return reply.code(503).send({ error: "Investigation history could not be cleared" });
    }
  });

  server.get("/v1/investigations/:sessionId/messages", { preHandler: apiAuth }, async (request, reply) => {
    if (!agentic) return reply.code(503).send({ error: "Agentic investigation is not configured" });
    const id = z.string().uuid().safeParse((request.params as { sessionId?: string }).sessionId);
    if (!id.success) return reply.code(400).send({ error: "Invalid investigation session ID" });
    try {
      return { messages: await agentic.listMessages(id.data) };
    } catch (error) {
      request.log.error({ err: error }, "Investigation history query failed");
      return reply.code(503).send({ error: "Investigation history could not be queried" });
    }
  });

  server.post("/v1/investigations/:sessionId/messages", { preHandler: analystAuth }, async (request, reply) => {
    if (!agentic) return reply.code(503).send({ error: "Agentic investigation requires PostgreSQL, SigNoz, and OPENROUTER_API_KEY" });
    const parsed = z.object({ sessionId: z.string().uuid(), content: z.string().trim().min(1).max(8_000) }).safeParse({
      sessionId: (request.params as { sessionId?: string }).sessionId,
      ...(request.body as Record<string, unknown>),
    });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid investigation message", issues: parsed.error.issues });
    try {
      return await agentic.chat(parsed.data.sessionId, parsed.data.content, {
        subject: request.authContext!.subject,
        roles: request.authContext!.roles,
      });
    } catch (error) {
      request.log.error({ err: error }, "Agentic investigation failed");
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Agentic investigation failed" });
    }
  });

  server.post("/v1/triggers", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for production triggers" });
    const parsed = z.object({
      agentId: z.string().uuid(), name: z.string().trim().min(1).max(200),
      kind: z.enum(["trace_webhook", "error_run", "latency"]), threshold: z.number().finite().nonnegative().optional(),
      lookbackMinutes: z.number().int().min(1).max(10_080).default(15), cooldownMinutes: z.number().int().min(1).max(10_080).default(15),
      enabled: z.boolean().default(true),
    }).refine(({ kind, threshold }) => kind !== "latency" || threshold !== undefined, "latency triggers require threshold milliseconds").safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid trigger", issues: parsed.error.issues });
    try {
      const agent = await store.getAgent(config.TRACEY_TENANT_ID, parsed.data.agentId);
      if (!agent) return reply.code(404).send({ error: "Registered agent not found" });
      return reply.code(201).send(await store.createTriggerRule(config.TRACEY_TENANT_ID, {
        agentId: parsed.data.agentId,
        name: parsed.data.name,
        kind: parsed.data.kind,
        ...(parsed.data.threshold === undefined ? {} : { threshold: parsed.data.threshold }),
        lookbackMinutes: parsed.data.lookbackMinutes,
        cooldownMinutes: parsed.data.cooldownMinutes,
        enabled: parsed.data.enabled,
      }));
    } catch (error) {
      request.log.error({ err: error }, "Trigger creation failed");
      return reply.code(503).send({ error: "Trigger could not be created" });
    }
  });

  server.get("/v1/triggers", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for production triggers" });
    try {
      return { triggers: await store.listTriggerRules(config.TRACEY_TENANT_ID) };
    } catch (error) {
      request.log.error({ err: error }, "Trigger query failed");
      return reply.code(503).send({ error: "Triggers could not be queried" });
    }
  });

  server.get("/v1/notifications", { preHandler: apiAuth }, async(request,reply)=>{
    if(!store)return reply.code(503).send({error:"DATABASE_URL is required for notifications"});
    const parsed=z.object({limit:z.coerce.number().int().min(1).max(200).default(100),unreadOnly:z.enum(["true","false"]).transform(v=>v==="true").default("false")}).safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:"Invalid notification query",issues:parsed.error.issues});
    const notifications=await store.listNotifications(config.TRACEY_TENANT_ID,parsed.data);
    return {notifications,unreadCount:notifications.filter(({readAt})=>!readAt).length};
  });

  server.post("/v1/notifications/:notificationId/read", { preHandler: apiAuth }, async(request,reply)=>{
    if(!store)return reply.code(503).send({error:"DATABASE_URL is required for notifications"});
    const id=z.string().uuid().safeParse((request.params as {notificationId?:string}).notificationId);
    if(!id.success)return reply.code(400).send({error:"Invalid notification ID"});
    const notification=await store.markNotificationRead(config.TRACEY_TENANT_ID,id.data);
    return notification??reply.code(404).send({error:"Notification not found"});
  });

  server.post("/v1/notifications/read-all", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for notifications" });
    return { updated: await store.markAllNotificationsRead(config.TRACEY_TENANT_ID) };
  });

  server.post("/v1/notifications/:notificationId/:operation", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for notifications" });
    const parsed = z.object({ notificationId: z.string().uuid(), operation: z.enum(["archive", "dismiss"]) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid notification operation" });
    const notification = await store.archiveNotification(config.TRACEY_TENANT_ID, parsed.data.notificationId, parsed.data.operation === "dismiss");
    return notification ?? reply.code(404).send({ error: "Notification not found" });
  });

  server.get("/v1/notification-preferences", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for notification preferences" });
    return { preferences: await store.getNotificationPreferences(config.TRACEY_TENANT_ID, request.authContext!.subject) };
  });

  server.put("/v1/notification-preferences", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for notification preferences" });
    const parsed = z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid notification preferences" });
    return { preferences: await store.saveNotificationPreferences(config.TRACEY_TENANT_ID, request.authContext!.subject, parsed.data) };
  });

  server.get("/v1/incidents", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for incidents" });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), status: z.enum(["open", "investigating", "monitoring", "resolved", "dismissed"]).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid incident query", issues: parsed.error.issues });
    return { incidents: await store.listIncidents(config.TRACEY_TENANT_ID, { limit: parsed.data.limit, ...(parsed.data.status ? { status: parsed.data.status } : {}) }) };
  });

  server.post("/v1/incidents", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for incidents" });
    const parsed = z.object({ title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(4_000),
      severity: z.enum(["info", "warning", "critical"]), environment: z.string().trim().min(1).max(100), affectedAgentIds: z.array(z.string().uuid()).max(100).default([]) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid incident", issues: parsed.error.issues });
    return reply.code(201).send(await store.createIncident(config.TRACEY_TENANT_ID, { ...parsed.data, actor: request.authContext!.subject }));
  });

  server.get("/v1/incidents/:incidentId", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for incidents" });
    const id = z.string().uuid().safeParse((request.params as { incidentId?: string }).incidentId);
    if (!id.success) return reply.code(400).send({ error: "Invalid incident ID" });
    const incident = await store.getIncident(config.TRACEY_TENANT_ID, id.data);
    return incident ?? reply.code(404).send({ error: "Incident not found" });
  });

  server.patch("/v1/incidents/:incidentId", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for incidents" });
    const parsed = z.object({ incidentId: z.string().uuid(), status: z.enum(["open", "investigating", "monitoring", "resolved", "dismissed"]).optional(),
      owner: z.string().trim().min(1).max(300).nullable().optional(), note: z.string().trim().min(1).max(4_000).optional(), investigationSessionId: z.string().uuid().optional() }).safeParse({ ...(request.params as Record<string, unknown>), ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid incident update", issues: parsed.error.issues });
    const { incidentId, ...input } = parsed.data;
    const incident = await store.updateIncident(config.TRACEY_TENANT_ID, incidentId, {
      actor: request.authContext!.subject,
      ...(input.status ? { status: input.status } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.investigationSessionId ? { investigationSessionId: input.investigationSessionId } : {}),
    });
    return incident ?? reply.code(404).send({ error: "Incident not found" });
  });

  server.get("/v1/autonomy/policies", { preHandler: apiAuth }, async (_request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for autonomy policies" });
    return { policies: await store.listAutonomyPolicies(config.TRACEY_TENANT_ID) };
  });

  server.get("/v1/autonomy/policies/:scopeType/:scopeId/history", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for policy history" });
    const parsed = z.object({ scopeType: z.enum(["global", "agent", "service"]), scopeId: z.string().trim().min(1).max(255) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid policy scope" });
    return { versions: await store.listAutonomyPolicyVersions(config.TRACEY_TENANT_ID, parsed.data.scopeType, parsed.data.scopeId) };
  });

  server.put("/v1/autonomy/policies/:scopeType/:scopeId", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for autonomy policies" });
    const parsed = z.object({
      scopeType: z.enum(["global", "agent", "service"]),
      scopeId: z.string().trim().min(1).max(255),
      policy: AutonomyPolicySchema,
      enabled: z.boolean().default(true),
    }).safeParse({ ...(request.params as Record<string, unknown>), ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid autonomy policy", issues: parsed.error.issues });
    const isAdmin = request.authContext!.roles.includes("admin");
    if (!isAdmin) {
      const forbidden = [
        ...(parsed.data.scopeType === "global" ? ["operators cannot change the global policy"] : []),
        ...(parsed.data.policy.mode !== "guarded_autopilot" ? ["operators may configure guarded_autopilot mode only"] : []),
        ...(["high", "critical"].includes(parsed.data.policy.maximumAutomaticRisk) ? ["operators cannot authorize high-risk automatic actions"] : []),
        ...(parsed.data.policy.automaticActions.includes("apply_config_patch") ? ["rollout configuration patches require admin policy authorization"] : []),
      ];
      if (forbidden.length > 0) return reply.code(403).send({ error: forbidden.join("; ") });
    }
    const saved = await store.upsertAutonomyPolicy(config.TRACEY_TENANT_ID, {
      ...parsed.data,
      actor: request.authContext!.subject,
    });
    return reply.code(201).send(saved);
  });

  server.get("/v1/autonomy/break-glass", { preHandler: adminAuth }, async (_request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for break-glass auditing" });
    return { overrides: await store.listBreakGlassOverrides(config.TRACEY_TENANT_ID) };
  });

  server.post("/v1/autonomy/break-glass", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for break-glass auditing" });
    const parsed = z.object({
      scopeType: z.enum(["global", "agent", "service"]),
      scopeId: z.string().trim().min(1).max(255),
      policy: AutonomyPolicySchema,
      reason: z.string().trim().min(20).max(2_000),
      durationMinutes: z.number().int().min(5).max(60),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid break-glass override", issues: parsed.error.issues });
    const mandatoryProhibitions = ["read_secrets", "delete_namespace", "delete_database", "arbitrary_shell"];
    const missing = mandatoryProhibitions.filter((action) => !parsed.data.policy.prohibitedActions.includes(action));
    if (missing.length > 0) return reply.code(400).send({ error: `Break-glass cannot remove mandatory prohibitions: ${missing.join(", ")}` });
    const override = await store.createBreakGlassOverride(config.TRACEY_TENANT_ID, {
      ...parsed.data,
      actor: request.authContext!.subject,
    });
    await store.createNotification(config.TRACEY_TENANT_ID, {
      title: "Break-glass override activated",
      summary: `${override.scopeType}/${override.scopeId} has an audited temporary policy override until ${override.expiresAt}.`,
      severity: "critical",
      correlationType: "system",
      correlationId: override.overrideId,
      category: "system",
      environment: config.DEPLOYMENT_ENVIRONMENT,
    });
    return reply.code(201).send(override);
  });

  server.post("/v1/autonomy/break-glass/:overrideId/revoke", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required for break-glass auditing" });
    const parsed = z.object({
      overrideId: z.string().uuid(),
      reason: z.string().trim().min(10).max(2_000),
    }).safeParse({ overrideId: (request.params as { overrideId?: string }).overrideId, ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid break-glass revocation", issues: parsed.error.issues });
    const override = await store.revokeBreakGlassOverride(
      config.TRACEY_TENANT_ID,
      parsed.data.overrideId,
      request.authContext!.subject,
      parsed.data.reason,
    );
    if (!override) return reply.code(409).send({ error: "Override is missing or already revoked" });
    await store.createNotification(config.TRACEY_TENANT_ID, {
      title: "Break-glass override revoked",
      summary: `${override.scopeType}/${override.scopeId} returned to its persisted autonomy policy.`,
      severity: "warning",
      correlationType: "system",
      correlationId: override.overrideId,
      category: "system",
      environment: config.DEPLOYMENT_ENVIRONMENT,
    });
    return override;
  });

  server.post("/v1/remediations/evaluate", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store || !autonomy) return reply.code(503).send({ error: "DATABASE_URL is required for remediation policies" });
    const parsed = z.object({
      sessionId: z.string().uuid(),
      policyScopeType: z.enum(["global", "agent", "service"]).default("global"),
      policyScopeId: z.string().trim().min(1).max(255).default("default"),
      plan: RemediationPlanSchema,
      modelIdentity: z.string().trim().min(1).max(300).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid remediation plan", issues: parsed.error.issues });
    const persistedPolicy = await store.getAutonomyPolicy(config.TRACEY_TENANT_ID, parsed.data.policyScopeType, parsed.data.policyScopeId);
    if (!persistedPolicy) return reply.code(409).send({ error: "No enabled autonomy policy exists for this scope; Tracey fails closed" });
    const breakGlass = await store.getActiveBreakGlassOverride(config.TRACEY_TENANT_ID, parsed.data.policyScopeType, parsed.data.policyScopeId);
    const policy = breakGlass ? {
      ...persistedPolicy,
      policyId: breakGlass.overrideId,
      policy: breakGlass.policy,
      version: persistedPolicy.version + 1,
      updatedBy: breakGlass.activatedBy,
      updatedAt: breakGlass.activatedAt,
    } : persistedPolicy;
    try {
      return reply.code(201).send(await autonomy.evaluatePlan({
        sessionId: parsed.data.sessionId,
        plan: parsed.data.plan,
        policy,
        actor: request.authContext!.subject,
        actorRoles: request.authContext!.roles,
        ...(parsed.data.modelIdentity ? { modelIdentity: parsed.data.modelIdentity } : {}),
      }));
    } catch (error) {
      request.log.error({ err: error }, "Remediation policy evaluation failed");
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Remediation evaluation failed" });
    }
  });

  server.get("/v1/actions/:proposalId", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required" });
    const id = z.string().uuid().safeParse((request.params as { proposalId?: string }).proposalId);
    if (!id.success) return reply.code(400).send({ error: "Invalid proposal ID" });
    const action = await store.getActionProposal(config.TRACEY_TENANT_ID, id.data);
    if (!action) return reply.code(404).send({ error: "Action not found" });
    return { action, events: await store.listActionEvents(config.TRACEY_TENANT_ID, id.data) };
  });

  server.get("/v1/actions", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required" });
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid action query", issues: parsed.error.issues });
    return { actions: await store.listActionProposals(config.TRACEY_TENANT_ID, parsed.data.limit) };
  });

  server.post("/v1/actions", { preHandler: operatorAuth }, async (request, reply) => {
    if(!store)return reply.code(503).send({error:"DATABASE_URL is required for action proposals"});
    const parsed=z.object({sessionId:z.string().uuid(),actionType:z.enum(["notification","ticket"]),
      target:z.string().trim().min(1).max(500),reason:z.string().trim().min(1).max(4_000),parameters:z.record(z.unknown()).default({}),risk:z.enum(["low","medium","high"])}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"Invalid action proposal",issues:parsed.error.issues});
    try{return reply.code(201).send(await store.createActionProposal(config.TRACEY_TENANT_ID,{...parsed.data,proposedBy:request.authContext!.subject}));}
    catch(error){request.log.error({err:error},"Action proposal failed");return reply.code(503).send({error:"Action proposal could not be persisted"});}
  });

  server.post("/v1/actions/:proposalId/decision", { preHandler: adminAuth }, async(request,reply)=>{
    if(!store)return reply.code(503).send({error:"DATABASE_URL is required"});
    const parsed=z.object({proposalId:z.string().uuid(),decision:z.enum(["approved","rejected"])}).safeParse({proposalId:(request.params as {proposalId?:string}).proposalId,...(request.body as Record<string,unknown>)});
    if(!parsed.success)return reply.code(400).send({error:"Invalid action decision",issues:parsed.error.issues});
    const proposal=await store.decideActionProposal(config.TRACEY_TENANT_ID,parsed.data.proposalId,parsed.data.decision,request.authContext!.subject);
    if (proposal) await store.createNotification(config.TRACEY_TENANT_ID,{sessionId:proposal.sessionId,title:`Action ${parsed.data.decision}`,
      summary:`${proposal.actionType} for ${proposal.target} was ${parsed.data.decision} by an administrator.`,severity:parsed.data.decision==="approved"?"warning":"info",
      correlationType:"system",correlationId:proposal.proposalId,category:"approval",environment:config.DEPLOYMENT_ENVIRONMENT});
    return proposal?proposal:reply.code(409).send({error:"Proposal is missing or already decided"});
  });

  server.post("/v1/actions/:proposalId/execute", { preHandler: adminAuth }, async(request,reply)=>{
    if(!store||!autonomy)return reply.code(503).send({error:"DATABASE_URL is required"});
    const id=z.string().uuid().safeParse((request.params as {proposalId?:string}).proposalId);
    if(!id.success)return reply.code(400).send({error:"Invalid proposal ID"});
    const proposal=await store.getActionProposal(config.TRACEY_TENANT_ID,id.data);
    if(!proposal||!["approved","approved_for_auto_execution"].includes(proposal.status))return reply.code(409).send({error:"Only an approved remediation can be executed"});
    if (!actionApprovalIsCurrent(proposal)) {
      await store.requireActionReapproval(config.TRACEY_TENANT_ID, proposal.proposalId, request.authContext!.subject);
      return reply.code(409).send({ error: "The proposal changed after approval and must be reviewed and approved again" });
    }
    if(!actionExecutor.configured())return reply.code(503).send({error:"No restricted action executor is configured; the approved proposal remains pending"});
    try{
      if (!proposal.remediationPlan) {
        const result = await actionExecutor.execute(proposal);
        await store.completeActionProposal(config.TRACEY_TENANT_ID,id.data,"executed");
        return { proposalId: id.data, status: "executed", result };
      }
      return await autonomy.execute(proposal,request.authContext!.subject);
    }
    catch(error){request.log.error({err:error},"Approved action execution failed");return reply.code(503).send({error:error instanceof Error?error.message:"Action execution failed"});}
  });

  server.get("/v1/actions/:proposalId/preview", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required" });
    const id = z.string().uuid().safeParse((request.params as { proposalId?: string }).proposalId);
    if (!id.success) return reply.code(400).send({ error: "Invalid proposal ID" });
    const proposal = await store.getActionProposal(config.TRACEY_TENANT_ID, id.data);
    if (!proposal?.remediationPlan) return reply.code(404).send({ error: "Remediation plan not found" });
    const action = actionExecutor.actionForProposal(proposal);
    if (!action) return reply.code(422).send({ error: "This action does not have a typed infrastructure preview" });
    try { return { before: await actionExecutor.captureSnapshot(action, proposal.remediationPlan), proposed: action, capturedAt: new Date().toISOString() }; }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : "Live change preview could not be captured", retryable: true }); }
  });

  server.post("/v1/actions/:proposalId/revision-request", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required" });
    const parsed = z.object({ proposalId: z.string().uuid(), reason: z.string().trim().min(10).max(2_000) }).safeParse({ proposalId: (request.params as { proposalId?: string }).proposalId, ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid revision request", issues: parsed.error.issues });
    const event = await store.recordActionEvent(config.TRACEY_TENANT_ID, parsed.data.proposalId, { actor: request.authContext!.subject, details: { type: "revision_requested", reason: parsed.data.reason } });
    return event ?? reply.code(404).send({ error: "Action not found" });
  });

  server.post("/v1/actions/:proposalId/schedule", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) return reply.code(503).send({ error: "DATABASE_URL is required" });
    const parsed = z.object({ proposalId: z.string().uuid(), scheduledFor: z.coerce.date().refine((date) => date.getTime() > Date.now() && date.getTime() <= Date.now() + 30 * 86_400_000, "schedule must be within the next 30 days") }).safeParse({ proposalId: (request.params as { proposalId?: string }).proposalId, ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid action schedule", issues: parsed.error.issues });
    const proposal = await store.scheduleAction(config.TRACEY_TENANT_ID, parsed.data.proposalId, parsed.data.scheduledFor, request.authContext!.subject);
    return proposal ?? reply.code(409).send({ error: "Only an approved action can be scheduled" });
  });

  server.post("/v1/triggers/:triggerId/fire", { preHandler: operatorAuth }, async (request, reply) => {
    if (!store || !agentic || !investigations) return reply.code(503).send({ error: "Agentic triggers require PostgreSQL, SigNoz, and OpenRouter" });
    const correlationSchema = z.discriminatedUnion("correlationType", [
      z.object({ correlationType: z.literal("trace"), correlationId: z.string().regex(/^[a-fA-F0-9]{32}$/) }),
      z.object({ correlationType: z.literal("codex_conversation"), correlationId: z.string().uuid() }),
    ]);
    const parsed = z.object({ triggerId: z.string().uuid(), correlation: correlationSchema,
      start: z.number().int().nonnegative(), end: z.number().int().positive() })
      .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000)
      .safeParse({ triggerId: (request.params as { triggerId?: string }).triggerId,
        correlation: request.body && typeof request.body === "object" ? request.body : {}, ...(request.body as Record<string, unknown>) });
    if (!parsed.success) return reply.code(400).send({ error: "Invalid trigger execution", issues: parsed.error.issues });
    const executionId = await store.startTriggerExecution(config.TRACEY_TENANT_ID, {
      triggerId: parsed.data.triggerId, ...parsed.data.correlation,
    });
    try {
      const trigger = await store.getTriggerRule(config.TRACEY_TENANT_ID, parsed.data.triggerId);
      if (!trigger?.enabled) {
        await store.completeTriggerExecution(config.TRACEY_TENANT_ID, { executionId, outcome: "suppressed", errorType: "TriggerDisabled" });
        return reply.code(202).send({ executionId, outcome: "suppressed" });
      }
      const agent = await store.getAgent(config.TRACEY_TENANT_ID, trigger.agentId);
      if (!agent) throw new Error("Trigger agent is not registered");
      const observed = parsed.data.correlation.correlationType === "trace"
        ? await investigations.investigateTrace({ traceId: parsed.data.correlation.correlationId, start: parsed.data.start, end: parsed.data.end, limit: 1_000 })
        : await investigations.investigateCodexConversation({ conversationId: parsed.data.correlation.correlationId,
            start: parsed.data.start, end: parsed.data.end, serviceName: agent.serviceName, limit: 5_000 });
      const analyses = "runs" in observed ? observed.runs.map(({ analysis }) => analysis) : [observed.analysis];
      const diagnoses = "runs" in observed ? observed.runs.map(({ diagnosis }) => diagnosis) : [observed.diagnosis];
      const shouldRun = trigger.kind === "trace_webhook" ||
        (trigger.kind === "latency" && analyses.some((analysis) => (analysis?.wallClockMs ?? 0) >= (trigger.threshold ?? Number.POSITIVE_INFINITY))) ||
        (trigger.kind === "error_run" && diagnoses.some((diagnosis) => diagnosis?.hypotheses.some(({ category }) => ["tool_failure", "span_error", "schema_mismatch", "retrieval_failure"].includes(category)) ?? false));
      if (!shouldRun) {
        await store.completeTriggerExecution(config.TRACEY_TENANT_ID, { executionId, outcome: "suppressed" });
        return reply.code(202).send({ executionId, outcome: "suppressed" });
      }
      const session = await agentic.createSession(`${trigger.name}: ${parsed.data.correlation.correlationId.slice(0, 12)}`);
      const target = parsed.data.correlation.correlationType === "trace"
        ? `trace ${parsed.data.correlation.correlationId} using investigate_trace`
        : `Codex conversation ${parsed.data.correlation.correlationId} for service ${agent.serviceName} using investigate_codex_conversation`;
      const answer = await agentic.chat(session.sessionId,
        `Autonomously investigate ${target} from ${parsed.data.start} to ${parsed.data.end}. Explain observed facts and hypotheses, cite evidence, and submit any remediation through propose_remediation so the configured autonomy policy is enforced.`, {
          subject: request.authContext!.subject,
          roles: request.authContext!.roles,
        });
      await store.completeTriggerExecution(config.TRACEY_TENANT_ID, { executionId, outcome: "completed", sessionId: session.sessionId });
      const notification = await store.createNotification(config.TRACEY_TENANT_ID,{ title: trigger.name, summary: answer.content.slice(0, 4_000),
        severity: trigger.kind === "error_run" ? "critical" : trigger.kind === "latency" ? "warning" : "info",
        correlationType:parsed.data.correlation.correlationType,correlationId:parsed.data.correlation.correlationId,sessionId:session.sessionId,triggerId:trigger.triggerId,
        category:trigger.kind === "error_run" ? "failure" : "incident",environment:config.DEPLOYMENT_ENVIRONMENT });
      return reply.code(202).send({ executionId, outcome: "completed", session, answer, notification });
    } catch (error) {
      await store.completeTriggerExecution(config.TRACEY_TENANT_ID, { executionId, outcome: "failed", errorType: error instanceof Error ? error.name : "UnknownError" }).catch(() => undefined);
      request.log.error({ err: error }, "Trigger execution failed");
      return reply.code(503).send({ executionId, error: "Trigger investigation failed" });
    }
  });

  server.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      if (!traceyMcp) {
        return reply.code(503).send({
          error:
            "SIGNOZ_API_URL, SIGNOZ_API_KEY, and TRACEY_MCP_BEARER_TOKEN are required; no simulated MCP investigation is returned",
        });
      }
      return traceyMcp.handle(request, reply);
    },
  });

  server.get("/v1/mcp/tools", { preHandler: apiAuth }, async (request, reply) => {
    if (!mcpClient) {
      return reply.code(503).send({
        error: "MCP_SERVER_URL is required; Tracey does not return simulated MCP tools",
      });
    }
    try {
      return await mcpClient.listTools();
    } catch (error) {
      request.log.error({ err: error }, "MCP tool discovery failed");
      return reply.code(503).send({ error: "The configured MCP server could not be queried" });
    }
  });

  server.post("/v1/mcp/call", { preHandler: apiAuth }, async (request, reply) => {
    if (!mcpClient) {
      return reply.code(503).send({
        error: "MCP_SERVER_URL is required; Tracey does not simulate MCP tool calls",
      });
    }
    const body = McpToolCallRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "Invalid MCP tool call",
        issues: body.error.issues,
      });
    }

    try {
      const result = await mcpClient.callReadTool(body.data.toolName, body.data.arguments);
      if (result.isError) {
        return reply.code(502).send(result);
      }
      return result;
    } catch (error) {
      if (error instanceof McpToolDeniedError) {
        return reply.code(403).send({ error: error.message });
      }
      if (error instanceof McpToolArgumentsError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof McpToolResultSizeError) {
        return reply.code(502).send({ error: error.message });
      }
      request.log.error({ err: error }, "MCP tool call failed");
      return reply.code(503).send({ error: "The configured MCP tool call failed" });
    }
  });

  server.post("/v1/agents", { preHandler: adminAuth }, async (request, reply) => {
    if (!store) {
      return reply.code(503).send({
        error: "DATABASE_URL is required; Tracey does not keep an in-memory production agent registry",
      });
    }
    const parsed = AgentRegistrationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid agent registration", issues: parsed.error.issues });
    }
    try {
      const registered = await store.registerAgent(config.TRACEY_TENANT_ID, parsed.data);
      return reply.code(201).send(registered);
    } catch (error) {
      request.log.error({ err: error }, "Agent registration failed");
      return reply.code(503).send({ error: "The production agent registry is unavailable" });
    }
  });

  server.get("/v1/agents", { preHandler: apiAuth }, async (request, reply) => {
    if (!store) {
      return reply.code(503).send({
        error: "DATABASE_URL is required; Tracey does not return a fabricated agent registry",
      });
    }
    const parsed = AgentListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid agent list query", issues: parsed.error.issues });
    }
    try {
      return { agents: await store.listAgents(config.TRACEY_TENANT_ID, parsed.data.limit) };
    } catch (error) {
      request.log.error({ err: error }, "Agent registry query failed");
      return reply.code(503).send({ error: "The production agent registry is unavailable" });
    }
  });

  server.get("/v1/executions", { preHandler: apiAuth }, async (request, reply) => {
    if (!investigations) {
      return reply.code(503).send({
        error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required for the observed execution feed",
      });
    }
    const query = request.query as Record<string, unknown>;
    const parsed = z.object({
      start: z.coerce.number().int().nonnegative(),
      end: z.coerce.number().int().positive(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000, "time range must be between one millisecond and seven days").safeParse(query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid execution feed query", issues: parsed.error.issues });

    const registered = store ? (await store.listAgents(config.TRACEY_TENANT_ID, 100)).filter(({ status }) => status === "active") : [];
    type SourceResult = {
      source: {
        sourceId: string;
        displayName: string;
        serviceName?: string;
        producerType: string;
        status: "complete" | "empty" | "unavailable" | "not_registered";
        observedExecutions: number;
        limitation?: string;
      };
      executions: ObservedExecution[];
    };
    const codexSources = [
      { serviceName: "codex-app-server" as const, displayName: "Codex App Server" },
      { serviceName: "Codex Desktop" as const, displayName: "Codex Desktop" },
    ];
    const codexTasks = codexSources.map(async ({ serviceName, displayName }): Promise<SourceResult> => {
      try {
        const result = await investigations!.getCodexRecentLogs({
          serviceName,
          start: parsed.data.start,
          end: parsed.data.end,
          limit: Math.min(parsed.data.limit * 20, 1_000),
        });
        const executions = codexLogsToExecutions({
          logs: result.logs,
          serviceName,
          producerName: displayName,
          environment: config.DEPLOYMENT_ENVIRONMENT,
        });
        return {
          source: {
            sourceId: `codex:${serviceName}`,
            displayName,
            serviceName,
            producerType: "codex_desktop",
            status: executions.length > 0 ? "complete" : "empty",
            observedExecutions: executions.length,
          },
          executions,
        };
      } catch {
        return {
          source: {
            sourceId: `codex:${serviceName}`,
            displayName,
            serviceName,
            producerType: "codex_desktop",
            status: "unavailable",
            observedExecutions: 0,
            limitation: "The bounded SigNoz query for this Codex source failed.",
          },
          executions: [],
        };
      }
    });
    const agentTasks = registered
      .filter(({ producerType }) => !["codex_desktop", "codex_cli"].includes(producerType))
      .map(async (agent): Promise<SourceResult> => {
        if (agent.environment !== config.DEPLOYMENT_ENVIRONMENT) {
          return {
            source: {
              sourceId: `agent:${agent.agentId}`,
              displayName: agent.displayName,
              serviceName: agent.serviceName,
              producerType: agent.producerType,
              status: "unavailable",
              observedExecutions: 0,
              limitation: "The registered environment is outside the configured SigNoz scope.",
            },
            executions: [],
          };
        }
        try {
          const result = await investigations!.searchAgentRuns({
            start: parsed.data.start,
            end: parsed.data.end,
            serviceName: agent.serviceName,
            limit: parsed.data.limit,
            offset: 0,
          }, agent.producerType);
          const executions = agentRunsToExecutions({
            runs: result.runs,
            producerType: agent.producerType as "claude_code" | "custom_otel",
            producerName: agent.displayName,
            serviceName: agent.serviceName,
            environment: agent.environment,
          });
          return {
            source: {
              sourceId: `agent:${agent.agentId}`,
              displayName: agent.displayName,
              serviceName: agent.serviceName,
              producerType: agent.producerType,
              status: executions.length > 0 ? "complete" : "empty",
              observedExecutions: executions.length,
            },
            executions,
          };
        } catch {
          return {
            source: {
              sourceId: `agent:${agent.agentId}`,
              displayName: agent.displayName,
              serviceName: agent.serviceName,
              producerType: agent.producerType,
              status: "unavailable",
              observedExecutions: 0,
              limitation: "The bounded SigNoz run query for this registered agent failed.",
            },
            executions: [],
          };
        }
      });
    const results = await Promise.all([...codexTasks, ...agentTasks]);
    const sourceStatuses = results.map(({ source }) => source);
    if (!registered.some(({ producerType }) => producerType === "claude_code")) {
      sourceStatuses.push({
        sourceId: "producer:claude_code",
        displayName: "Claude Code",
        producerType: "claude_code",
        status: "not_registered",
        observedExecutions: 0,
        limitation: "Register a Claude Code producer to query its observed interaction roots.",
      });
    }
    if (!registered.some(({ producerType }) => producerType === "custom_otel")) {
      sourceStatuses.push({
        sourceId: "producer:custom_otel",
        displayName: "Custom OpenTelemetry agents",
        producerType: "custom_otel",
        status: "not_registered",
        observedExecutions: 0,
        limitation: "Register a custom agent service to query its observed agent.run roots.",
      });
    }
    const executions = results.flatMap(({ executions: items }) => items)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, parsed.data.limit);
    return {
      executions,
      sources: sourceStatuses,
      window: { start: parsed.data.start, end: parsed.data.end },
      registeredAgentCount: registered.length,
      truncated: results.some(({ executions: items }) => items.length >= parsed.data.limit) || executions.length >= parsed.data.limit,
    };
  });

  server.get("/v1/agents/:agentId/runs", { preHandler: apiAuth }, async (request, reply) => {
    if (!store || !signoz) {
      return reply.code(503).send({
        error: "DATABASE_URL, SIGNOZ_API_URL, and SIGNOZ_API_KEY are required for registered-agent run discovery",
      });
    }
    const params = request.params as { agentId?: string };
    const parsed = RegisteredAgentRunSearchSchema.safeParse({
      ...(request.query as Record<string, unknown>),
      agentId: params.agentId,
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid registered-agent run query", issues: parsed.error.issues });
    }
    try {
      const agent = await store.getAgent(config.TRACEY_TENANT_ID, parsed.data.agentId);
      if (!agent || agent.status !== "active") {
        return reply.code(404).send({ error: "Active registered agent not found" });
      }
      if (agent.environment !== config.DEPLOYMENT_ENVIRONMENT) {
        return reply.code(409).send({ error: "Agent environment does not match the configured SigNoz scope" });
      }
      if (agent.producerType === "codex_desktop" || agent.producerType === "codex_cli") {
        return reply.code(409).send({
          error: "Codex native telemetry is conversation-event based; query /v1/signoz/codex/conversations/{conversationId} with an exact conversation ID",
        });
      }
      const { start, end, runId, limit, offset } = parsed.data;
      return await investigations!.searchAgentRuns(
        { start, end, serviceName: agent.serviceName, ...(runId ? { runId } : {}), limit, offset },
        agent.producerType,
      );
    } catch (error) {
      request.log.error({ err: error }, "Registered-agent run query failed");
      const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
      return reply.code(status).send({ error: "The registered agent could not be queried in SigNoz" });
    }
  });

  server.post("/v1/feedback", { preHandler: apiAuth }, async (request, reply) => {
    const parsed = AgentFeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid feedback", issues: parsed.error.issues });
    }
    recordExternalAgentFeedback({
      traceId: parsed.data.traceId,
      spanId: parsed.data.spanId,
      runId: parsed.data.runId,
      source: parsed.data.source,
      label: parsed.data.label,
      ...(parsed.data.score === undefined ? {} : { score: parsed.data.score }),
      ...(parsed.data.reference === undefined ? {} : { reference: parsed.data.reference }),
    });
    return reply.code(202).send({
      accepted: true,
      correlation: { traceId: parsed.data.traceId, runId: parsed.data.runId },
    });
  });

  server.get("/v1/signoz/agent-runs", { preHandler: apiAuth }, async (request, reply) => {
    if (!signoz) {
      return reply.code(503).send({
        error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required; no simulated query result is returned",
      });
    }
    const query = request.query as Record<string, unknown>;
    const parsed = TraceSearchSchema.safeParse({
      start: Number(query.start),
      end: Number(query.end),
      serviceName: query.serviceName ?? "tracey-api",
      runId: query.runId,
      limit: query.limit === undefined ? 50 : Number(query.limit),
      offset: query.offset === undefined ? 0 : Number(query.offset),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid query", issues: parsed.error.issues });
    }

    try {
      return await investigations!.searchAgentRuns(parsed.data);
    } catch (error) {
      request.log.error({ err: error }, "SigNoz query failed");
      const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
      return reply.code(status).send({ error: "The configured SigNoz query failed" });
    }
  });

  server.get("/v1/signoz/traces/:traceId", { preHandler: apiAuth }, async (request, reply) => {
    if (!signoz) {
      return reply.code(503).send({
        error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required; no simulated trace is returned",
      });
    }
    const params = request.params as { traceId?: string };
    const query = request.query as Record<string, unknown>;
    const parsed = TraceDetailsSearchSchema.safeParse({
      traceId: params.traceId,
      start: Number(query.start),
      end: Number(query.end),
      cursor: query.cursor,
      limit: query.limit === undefined ? 10_000 : Number(query.limit),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid trace query", issues: parsed.error.issues });
    }

    try {
      return await investigations!.investigateTrace(parsed.data);
    } catch (error) {
      if (error instanceof InvestigationNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      request.log.error({ err: error }, "SigNoz trace query failed");
      const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
      return reply.code(status).send({ error: "The configured SigNoz trace query failed" });
    }
  });

  server.get(
    "/v1/signoz/codex/conversations/:conversationId",
    { preHandler: apiAuth },
    async (request, reply) => {
      if (!investigations) {
        return reply.code(503).send({
          error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required; no fabricated Codex run is returned",
        });
      }
      const params = request.params as { conversationId?: string };
      const query = request.query as Record<string, unknown>;
      const parsed = CodexConversationSearchSchema.safeParse({
        conversationId: params.conversationId,
        start: Number(query.start),
        end: Number(query.end),
        serviceName: query.serviceName ?? "codex-app-server",
        cursor: query.cursor,
        limit: query.limit === undefined ? 5_000 : Number(query.limit),
      });
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid Codex conversation query", issues: parsed.error.issues });
      }

      try {
        return await investigations.investigateCodexConversation(parsed.data);
      } catch (error) {
        if (error instanceof InvestigationNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        request.log.error({ err: error }, "SigNoz Codex conversation query failed");
        const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
        return reply.code(status).send({ error: "The configured SigNoz Codex conversation query failed" });
      }
    },
  );

  server.get("/v1/signoz/metrics/agent-runs", { preHandler: apiAuth }, async (request, reply) => {
    if (!signoz) {
      return reply.code(503).send({
        error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required; no placeholder metric is returned",
      });
    }
    const query = request.query as Record<string, unknown>;
    const parsed = AgentRunMetricsSearchSchema.safeParse({
      start: Number(query.start),
      end: Number(query.end),
      serviceName: query.serviceName ?? "tracey-api",
      stepInterval: query.stepInterval === undefined ? 60 : Number(query.stepInterval),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid metric query", issues: parsed.error.issues });
    }

    try {
      return await investigations!.queryAgentRunMetrics(parsed.data);
    } catch (error) {
      request.log.error({ err: error }, "SigNoz metric query failed");
      const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
      return reply.code(status).send({ error: "The configured SigNoz metric query failed" });
    }
  });

  server.post("/v1/signoz/cohorts/compare", { preHandler: apiAuth }, async (request, reply) => {
    if (!investigations) {
      return reply.code(503).send({
        error: "SIGNOZ_API_URL and SIGNOZ_API_KEY are required; no fabricated cohort comparison is returned",
      });
    }
    const parsed = CohortComparisonSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid cohort comparison", issues: parsed.error.issues });
    }

    try {
      return await investigations.compareCohorts(parsed.data);
    } catch (error) {
      request.log.error({ err: error }, "SigNoz cohort comparison failed");
      const status = error instanceof SigNozAdapterError && error.statusCode === 401 ? 502 : 503;
      return reply.code(status).send({ error: "The configured SigNoz cohort comparison failed" });
    }
  });

  return server;
}
