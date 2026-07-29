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

export type AgentProducerType = "codex_desktop" | "codex_cli" | "claude_code" | "custom_otel";
export type AgentSetupLanguage = "python" | "node" | "otlp";

export interface AgentOnboardingSource {
  sourceId: string;
  connectorId: Extract<ConnectorId, "codex" | "claude-code" | "generic-otel">;
  producerType: AgentProducerType;
  displayName: string;
  description: string;
  serviceNameSuggestion: string;
  displayNameSuggestion: string;
  normalizationProfile: string;
  telemetryContractVersion: string;
  instructions: string[];
  configurationTemplate: string;
  setupLanguages?: AgentSetupLanguage[];
  isDefault: boolean;
}

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
  agentOnboardingSources?: AgentOnboardingSource[];
}

export interface ConnectorRuntimeConfig {
  signozConfigured: boolean;
  kubernetesInvestigatorEnabled: boolean;
  kubernetesExecutorConfigured: boolean;
  otlpConfigured: boolean;
  mcpClientConfigured: boolean;
  mcpServerConfigured: boolean;
}

function genericProducerState(config: ConnectorRuntimeConfig): ConnectorState {
  return config.signozConfigured && config.otlpConfigured ? "ready" : "needs_configuration";
}

export function buildConnectorRegistry(config: ConnectorRuntimeConfig): ConnectorDescriptor[] {
  const genericStatus = genericProducerState(config);
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
      state: "needs_configuration",
      externalSystem: true,
      capabilities: ["native_otel_logs", "conversation_normalization", "tool_analysis", "token_analysis"],
      configurationKeys: ["service.name", "conversation.id", "normalizationProfile"],
      documentationPath: "docs/codex-integration.md",
      statusReason: "Enable the Codex connector before registering a Codex producer.",
      agentOnboardingSources: [
        {
          sourceId: "codex-app",
          connectorId: "codex",
          producerType: "codex_desktop",
          displayName: "Codex app",
          description: "Observe the Codex desktop app through its native OpenTelemetry events.",
          serviceNameSuggestion: "codex-app-server",
          displayNameSuggestion: "Codex App Server",
          normalizationProfile: "codex-otel-0.144@1",
          telemetryContractVersion: "codex-native-otel@1",
          instructions: [
            "Add the OpenTelemetry exporter to ~/.codex/config.toml.",
            "Restart Codex after saving the configuration.",
            "Complete one normal prompt before verifying telemetry.",
          ],
          configurationTemplate: `[otel]
environment = "development"
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "binary"

[otel.trace_exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/traces"
protocol = "binary"`,
          isDefault: false,
        },
        {
          sourceId: "codex-cli",
          connectorId: "codex",
          producerType: "codex_cli",
          displayName: "Codex CLI",
          description: "Observe standalone Codex CLI executions and tool activity.",
          serviceNameSuggestion: "Codex Desktop",
          displayNameSuggestion: "Codex CLI",
          normalizationProfile: "codex-otel-0.144@1",
          telemetryContractVersion: "codex-native-otel@1",
          instructions: [
            "Add the OpenTelemetry exporter to ~/.codex/config.toml.",
            "Start a new Codex CLI process after saving the configuration.",
            "Run one prompt that performs a normal tool call.",
          ],
          configurationTemplate: `[otel]
environment = "development"
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "binary"

[otel.trace_exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/traces"
protocol = "binary"`,
          isDefault: false,
        },
      ],
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      category: "agent_producer",
      state: "needs_configuration",
      externalSystem: true,
      capabilities: ["native_otel_traces", "interaction_normalization", "tool_analysis"],
      configurationKeys: ["service.name", "normalizationProfile"],
      documentationPath: "docs/claude-code-integration.md",
      statusReason: "Enable the Claude Code connector before registering a Claude Code producer.",
      agentOnboardingSources: [{
        sourceId: "claude-code",
        connectorId: "claude-code",
        producerType: "claude_code",
        displayName: "Claude Code",
        description: "Observe Claude Code interactions through its native OpenTelemetry hierarchy.",
        serviceNameSuggestion: "claude-code",
        displayNameSuggestion: "Claude Code",
        normalizationProfile: "claude-code-native-beta@1",
        telemetryContractVersion: "claude-code-otel@1",
        instructions: [
          "Export the OpenTelemetry variables in the shell that launches Claude Code.",
          "Restart Claude Code from that shell.",
          "Complete one interaction containing a model request and tool execution.",
        ],
        configurationTemplate: `export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`,
        isDefault: false,
      }],
    },
    {
      id: "generic-otel",
      displayName: "Generic OpenTelemetry agent",
      category: "agent_producer",
      state: genericStatus,
      externalSystem: true,
      capabilities: ["agent_run_contract", "framework_neutral_tracing", "metrics", "feedback"],
      configurationKeys: ["OTEL_EXPORTER_OTLP_ENDPOINT", "service.name", "tracey.agent.name", "tracey.agent.version"],
      documentationPath: "docs/custom-agent-instrumentation.md",
      statusReason: genericStatus === "ready" ? "Custom agents can export the Tracey telemetry contract." : "Configure OTLP ingestion and SigNoz before registering custom agents.",
      agentOnboardingSources: [{
        sourceId: "generic-otel",
        connectorId: "generic-otel",
        producerType: "custom_otel",
        displayName: "OpenTelemetry agent",
        description: "Connect any independently deployed agent that emits Tracey's agent.run contract.",
        serviceNameSuggestion: "",
        displayNameSuggestion: "",
        normalizationProfile: "tracey.agent.v1",
        telemetryContractVersion: "1.0.0",
        instructions: [
          "Set a stable OpenTelemetry service.name for the agent.",
          "Export OTLP traces to Tracey's collector.",
          "Emit an agent.run root span, then execute one real agent request.",
        ],
        configurationTemplate: `export OTEL_SERVICE_NAME=your-agent-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Root span contract
# name: agent.run
# attributes: tracey.run.id, tracey.agent.name,
# tracey.agent.version, deployment.environment.name`,
        setupLanguages: ["python", "node", "otlp"],
        isDefault: true,
      }],
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

export function buildAgentOnboardingSources(connectors: ConnectorDescriptor[]): AgentOnboardingSource[] {
  return connectors
    .filter((connector) => connector.category === "agent_producer" && connector.state === "ready")
    .flatMap((connector) => connector.agentOnboardingSources ?? [])
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.displayName.localeCompare(right.displayName));
}
