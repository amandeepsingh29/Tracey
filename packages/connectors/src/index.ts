import { z } from "zod";

export const ConnectorIdSchema = z.enum([
  "signoz",
  "kubernetes",
  "codex",
  "claude-code",
  "generic-otel",
  "mcp",
]);
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

export const ConnectorStateSchema = z.enum(["ready", "needs_configuration", "disabled"]);
export type ConnectorState = z.infer<typeof ConnectorStateSchema>;

export interface ConnectorDescriptor {
  id: ConnectorId;
  displayName: string;
  category: "telemetry_backend" | "infrastructure" | "agent_producer" | "protocol";
  state: ConnectorState;
  externalSystem: true;
  capabilities: string[];
  configurationKeys: string[];
  documentationPath: string;
  statusReason: string;
}

export interface ConnectorRuntimeConfig {
  signozConfigured: boolean;
  kubernetesInvestigatorEnabled: boolean;
  kubernetesExecutorConfigured: boolean;
  otlpConfigured: boolean;
  mcpClientConfigured: boolean;
  mcpServerConfigured: boolean;
}

function producerState(config: ConnectorRuntimeConfig): ConnectorState {
  return config.signozConfigured && config.otlpConfigured ? "ready" : "needs_configuration";
}

export function buildConnectorRegistry(config: ConnectorRuntimeConfig): ConnectorDescriptor[] {
  const producerStatus = producerState(config);
  return [
    {
      id: "signoz",
      displayName: "SigNoz",
      category: "telemetry_backend",
      state: config.signozConfigured ? "ready" : "needs_configuration",
      externalSystem: true,
      capabilities: ["query_traces", "query_logs", "query_metrics", "compare_health", "verify_recovery"],
      configurationKeys: ["SIGNOZ_API_URL", "SIGNOZ_API_KEY", "SIGNOZ_OTLP_ENDPOINT", "SIGNOZ_INGESTION_KEY"],
      documentationPath: "docs/signoz-api-contract.md",
      statusReason: config.signozConfigured ? "Query API credentials are configured." : "Configure a SigNoz query endpoint and service-account key.",
    },
    {
      id: "kubernetes",
      displayName: "Kubernetes",
      category: "infrastructure",
      state: config.kubernetesInvestigatorEnabled || config.kubernetesExecutorConfigured ? "ready" : "needs_configuration",
      externalSystem: true,
      capabilities: ["investigate_workloads", "typed_remediation", "rollout_verification", "automatic_recovery"],
      configurationKeys: ["TRACEY_KUBERNETES_INVESTIGATOR_ENABLED", "TRACEY_EXECUTOR_URL", "TRACEY_KUBERNETES_ALLOWED_NAMESPACES", "TRACEY_KUBERNETES_ALLOWED_WORKLOADS"],
      documentationPath: "docs/connectors/kubernetes.md",
      statusReason: config.kubernetesInvestigatorEnabled || config.kubernetesExecutorConfigured
        ? "At least one least-privilege Kubernetes adapter is configured."
        : "Configure scoped investigator and executor identities.",
    },
    {
      id: "codex",
      displayName: "Codex",
      category: "agent_producer",
      state: producerStatus,
      externalSystem: true,
      capabilities: ["native_otel_logs", "conversation_normalization", "tool_analysis", "token_analysis"],
      configurationKeys: ["service.name", "conversation.id", "normalizationProfile"],
      documentationPath: "docs/codex-integration.md",
      statusReason: producerStatus === "ready" ? "Codex telemetry can be normalized from SigNoz." : "Configure OTLP ingestion and SigNoz before registering Codex.",
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      category: "agent_producer",
      state: producerStatus,
      externalSystem: true,
      capabilities: ["native_otel_traces", "interaction_normalization", "tool_analysis"],
      configurationKeys: ["service.name", "normalizationProfile"],
      documentationPath: "docs/claude-code-integration.md",
      statusReason: producerStatus === "ready" ? "Claude Code telemetry can be normalized from SigNoz." : "Configure OTLP ingestion and SigNoz before registering Claude Code.",
    },
    {
      id: "generic-otel",
      displayName: "Generic OpenTelemetry agent",
      category: "agent_producer",
      state: producerStatus,
      externalSystem: true,
      capabilities: ["agent_run_contract", "framework_neutral_tracing", "metrics", "feedback"],
      configurationKeys: ["OTEL_EXPORTER_OTLP_ENDPOINT", "service.name", "tracey.agent.name", "tracey.agent.version"],
      documentationPath: "docs/custom-agent-instrumentation.md",
      statusReason: producerStatus === "ready" ? "Custom agents can export the Tracey telemetry contract." : "Configure OTLP ingestion and SigNoz before registering custom agents.",
    },
    {
      id: "mcp",
      displayName: "Model Context Protocol",
      category: "protocol",
      state: config.mcpClientConfigured || config.mcpServerConfigured ? "ready" : "needs_configuration",
      externalSystem: true,
      capabilities: ["expose_investigation_tools", "observe_allowlisted_read_tools"],
      configurationKeys: ["MCP_SERVER_URL", "MCP_ALLOWED_READ_TOOLS", "TRACEY_MCP_BEARER_TOKEN"],
      documentationPath: "docs/mcp-integration.md",
      statusReason: config.mcpClientConfigured || config.mcpServerConfigured ? "At least one MCP direction is configured." : "Configure the Tracey MCP server or an allowlisted external MCP server.",
    },
  ];
}
