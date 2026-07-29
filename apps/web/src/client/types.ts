export type Health = {
  status: string;
  integrations: Record<string, string>;
};

export type Connector = {
  id: "signoz" | "kubernetes" | "codex" | "claude-code" | "generic-otel" | "mcp";
  displayName: string;
  category: "telemetry_backend" | "infrastructure" | "agent_producer" | "protocol";
  state: "ready" | "needs_configuration" | "disabled";
  capabilities: string[];
  configurationKeys: string[];
  documentationPath: string;
  statusReason: string;
  configuration?: {
    configured: boolean; enabled: boolean; status: "ready" | "unhealthy" | "needs_configuration" | "disabled";
    secretNames: string[]; effectiveIdentity?: string; lastCheckedAt?: string; latestError?: string;
    publicConfig: Record<string, unknown>; updatedAt: string;
  };
};

export type Agent = {
  agentId: string;
  displayName: string;
  serviceName: string;
  producerType: "codex_desktop" | "codex_cli" | "claude_code" | "custom_otel";
  environment: string;
  normalizationProfile: string;
  telemetryContractVersion: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type KubernetesDeploymentSummary = {
  name: string;
  namespace: string;
  containers: Array<{ name: string; image?: string }>;
  desiredReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  updatedReplicas: number;
};

export type AgentDeploymentMapping = {
  agentId: string;
  connectorId: "kubernetes";
  namespace: string;
  workloadKind: "Deployment";
  workloadName: string;
  containerName?: string;
  validatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentDeploymentHealth = KubernetesDeploymentSummary & {
  ready: boolean;
  unavailableReplicas: number;
  pods: Array<{
    name: string;
    namespace: string;
    phase: string;
    reason?: string;
    containers: Array<{ name: string; ready: boolean; restartCount: number; state: string }>;
  }>;
  totalRestarts: number;
  conditions: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
};

export type AgentDeployment = {
  mapping: AgentDeploymentMapping;
  health: AgentDeploymentHealth;
  observedAt: string;
};

export type AgentRun = {
  runId: string;
  traceId: string;
  startedAt?: string;
  startTime?: string;
  durationMs?: number;
  status?: string;
  outcome?: string;
  serviceName?: string;
  model?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
  costNanoUsd?: number;
  evidenceCompleteness?: string;
  [key: string]: unknown;
};

export type RunSearchResult = {
  runs: AgentRun[];
  rejectedRows?: number;
  nextOffset?: number;
  query?: Record<string, unknown>;
};

export type InvestigationSession = {
  sessionId: string;
  title: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
};

export type EvidenceRef = {
  traceId?: string;
  spanId?: string;
  sourceType?: "kubernetes" | "signoz" | "tracey";
  sourceId?: string;
  observation?: string;
  signal?: string;
};

export type InvestigationMessage = {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  evidenceRefs: EvidenceRef[];
  model?: string;
  grounding?: "evidence_bound" | "tool_grounded" | "model_only";
  toolCallCount?: number;
  createdAt: string;
};

export type ActionStatus = "proposed" | "policy_evaluated" | "awaiting_approval" | "approved_for_auto_execution" | "approved" | "rejected" | "executing" | "verifying" | "succeeded" | "failed" | "reverting" | "reverted" | "revert_failed" | "executed";

export type RemediationPlan = {
  action: Record<string, unknown> & { type: string; namespace?: string; workload?: string };
  summary: string;
  reason: string;
  confidence: number;
  risk: "low" | "medium" | "high" | "critical";
  reversible: boolean;
  expectedImpact: string;
  blastRadius: { workloads: number; estimatedUnavailableReplicas: number };
  evidenceRefs: EvidenceRef[];
  verification: Record<string, unknown>;
  rollback?: { action: Record<string, unknown>; automatic: boolean };
};

export type ActionProposal = {
  proposalId: string;
  sessionId: string;
  actionType: string;
  target: string;
  reason: string;
  parameters: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  status: ActionStatus;
  proposedBy: string;
  approvedBy?: string;
  createdAt: string;
  remediationPlan?: RemediationPlan;
  policyDecision?: { decision: string; reasons: string[]; evaluatedAt: string };
  preActionSnapshot?: Record<string, unknown>;
  executionResult?: Record<string, unknown>;
  verificationResult?: Record<string, unknown>;
  rollbackResult?: Record<string, unknown>;
  scheduledFor?: string;
  scheduledBy?: string;
};

export type ActionEvent = {
  eventId: string;
  fromStatus?: ActionStatus;
  toStatus: ActionStatus;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type ObservedExecution = {
  executionId: string;
  producerType: "codex_desktop" | "codex_cli" | "claude_code" | "custom_otel";
  producerName: string;
  serviceName: string;
  environment: string;
  runId: string;
  traceId?: string;
  conversationId?: string;
  status: "succeeded" | "failed" | "observed";
  startedAt: string;
  durationMs?: number;
  model?: string;
  tools: string[];
  inputTokens?: number;
  outputTokens?: number;
  eventCount: number;
};

export type ExecutionSource = {
  sourceId: string;
  displayName: string;
  serviceName?: string;
  producerType: string;
  status: "complete" | "empty" | "unavailable" | "not_registered";
  observedExecutions: number;
  limitation?: string;
};

export type ExecutionFeed = {
  executions: ObservedExecution[];
  sources: ExecutionSource[];
  window: { start: number; end: number };
  registeredAgentCount: number;
  truncated: boolean;
};

export type CodexConversationTurn = {
  conversationId: string;
  turnIndex: number;
  turnId?: string;
  prompt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  toolNames: string[];
  status: "complete" | "incomplete";
};

export type RecentCodexConversations = {
  conversations: CodexConversationTurn[];
  windowHours: number;
  source: "local_codex_session";
};

export type ExecutionGraphNode = {
  nodeId: string;
  kind: "prompt" | "model" | "reasoning" | "decision" | "tool" | "result" | "final";
  label: string;
  summary: string;
  timestamp: string;
  durationMs?: number;
  status: "succeeded" | "failed" | "observed";
  content?: string;
  sensitive: boolean;
  source: "codex_session" | "signoz";
  attributes: Record<string, unknown>;
};

export type ExecutionGraphEdge = {
  edgeId: string;
  from: string;
  to: string;
  relationship: "sequence" | "tool_result" | "approval";
  certainty: "observed" | "inferred";
};

export type CodexExecutionGraph = {
  executionId: string;
  runId: string;
  conversationId: string;
  turnIndex: number;
  status: "complete" | "incomplete" | "failed";
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  contentSource: "local_session" | "telemetry_only";
  forensicModeAvailable: boolean;
  sensitiveValuesIncluded: boolean;
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
  evidence: Array<{ eventName: string; timestamp: string; sourceTraceId: string; sourceSpanId?: string }>;
  evidenceCompleteness: number;
  limitations: string[];
  analysis: Record<string, unknown>;
  diagnosis: Record<string, unknown>;
  rawEvents: Array<Record<string, unknown>>;
};

export type Notification = {
  notificationId: string;
  sessionId?: string;
  triggerId?: string;
  title: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  correlationType: "trace" | "codex_conversation" | "system";
  correlationId: string;
  readAt?: string;
  archivedAt?: string;
  dismissedAt?: string;
  category?: "incident" | "approval" | "failure" | "recovery" | "connector" | "system";
  environment?: string;
  createdAt: string;
};

export type AutonomyPolicy = {
  mode: "observe" | "recommend" | "approval" | "guarded_autopilot" | "full_autopilot";
  environments: string[];
  namespaces: string[];
  workloads: string[];
  allowedActions: string[];
  automaticActions: string[];
  prohibitedActions: string[];
  minimumConfidence: number;
  maximumAutomaticRisk: "low" | "medium" | "high" | "critical";
  maxReplicas: number;
  maxAffectedWorkloads: number;
  maxUnavailableReplicas: number;
  maxConcurrentActions: number;
  cooldownMinutes: number;
};

export type PolicyRecord = {
  policyId: string;
  scopeType: "global" | "agent" | "service";
  scopeId: string;
  policy: AutonomyPolicy;
  version: number;
  enabled: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type TraceDetails = {
  traceId: string;
  spans?: Array<Record<string, unknown> & { spanId?: string; parentSpanId?: string; name?: string; serviceName?: string; durationMs?: number; hasError?: boolean }>;
  analysis?: Record<string, unknown>;
  diagnosis?: Record<string, unknown>;
  evidence?: EvidenceRef[];
  query?: Record<string, unknown>;
};

export type IncidentStatus = "open" | "investigating" | "monitoring" | "resolved" | "dismissed";
export type Incident = {
  incidentId: string;
  title: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  status: IncidentStatus;
  environment: string;
  affectedAgentIds: string[];
  owner?: string;
  startedAt: string;
  resolvedAt?: string;
  investigationSessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type IncidentEvent = {
  eventId: string;
  incidentId: string;
  eventType: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
};
