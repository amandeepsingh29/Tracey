import type {
  ActionEvent, ActionProposal, Agent, AgentConnectionRequest, AgentDeployment, Connector, ConnectorCatalog, Health, InvestigationMessage,
  InvestigationSession, Notification, PolicyRecord, RunSearchResult, TraceDetails,
  Incident, IncidentEvent, IncidentStatus, ExecutionFeed, KubernetesDeploymentSummary,
  CodexExecutionGraph, RecentCodexConversations,
} from "../types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/tracey${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; retryable?: boolean };
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed with HTTP ${response.status}`, response.status, payload.retryable ?? response.status >= 500);
  return payload as T;
}

const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};

export const api = {
  health: () => request<Health>("/health"),
  connectors: () => request<ConnectorCatalog>("/v1/connectors"),
  testConnector: (connectorId: Connector["id"], configuration: Record<string, unknown>) => request<{ ok: true; effectiveIdentity: string; checkedAt: string }>(`/v1/connectors/${connectorId}/test`, { method: "POST", body: JSON.stringify(configuration) }),
  configureConnector: (connectorId: Connector["id"], configuration: Record<string, unknown>) => request<Record<string, unknown>>(`/v1/connectors/${connectorId}/configuration`, { method: "PUT", body: JSON.stringify(configuration) }),
  setConnectorEnabled: (connectorId: Connector["id"], enabled: boolean) => request<Record<string, unknown>>(`/v1/connectors/${connectorId}/state`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteConnector: (connectorId: Connector["id"]) => request<void>(`/v1/connectors/${connectorId}/configuration`, { method: "DELETE" }),
  agents: (limit = 100) => request<{ agents: Agent[] }>(`/v1/agents?${query({ limit })}`),
  createAgent: (input: AgentConnectionRequest) => request<Agent>("/v1/agents", { method: "POST", body: JSON.stringify(input) }),
  kubernetesNamespaces: () => request<{ namespaces: string[] }>("/v1/kubernetes/namespaces"),
  kubernetesDeployments: (namespace: string) => request<{ deployments: KubernetesDeploymentSummary[] }>(`/v1/kubernetes/deployments?${query({ namespace })}`),
  agentDeployment: (agentId: string) => request<AgentDeployment>(`/v1/agents/${agentId}/deployment`),
  saveAgentDeployment: (agentId: string, input: { namespace: string; workloadName: string; containerName?: string }) =>
    request<AgentDeployment>(`/v1/agents/${agentId}/deployment`, { method: "PUT", body: JSON.stringify(input) }),
  deleteAgentDeployment: (agentId: string) => request<void>(`/v1/agents/${agentId}/deployment`, { method: "DELETE" }),
  agentRuns: (agentId: string, input: { start: number; end: number; runId?: string; limit?: number; offset?: number }) => request<RunSearchResult>(`/v1/agents/${agentId}/runs?${query(input)}`),
  executions: (start: number, end: number, limit = 200) => request<ExecutionFeed>(`/v1/executions?${query({ start, end, limit })}`),
  recentCodexConversations: (hours = 168, limit = 40) =>
    request<RecentCodexConversations>(`/v1/executions/codex/recent?${query({ hours, limit })}`),
  codexExecutionGraph: (conversationId: string, input: { start: number; end: number; serviceName: string; at?: number; turnIndex?: number; includeSensitive?: boolean }) =>
    request<CodexExecutionGraph>(`/v1/executions/codex/${encodeURIComponent(conversationId)}/graph?${query(input)}`),
  trace: (traceId: string, start: number, end: number) => request<TraceDetails>(`/v1/signoz/traces/${traceId}?${query({ start, end })}`),
  metrics: (serviceName: string, start: number, end: number) => request<Record<string, unknown>>(`/v1/signoz/metrics/agent-runs?${query({ serviceName, start, end, stepInterval: 300 })}`),
  investigations: () => request<{ investigations: InvestigationSession[] }>("/v1/investigations"),
  createInvestigation: (title: string) => request<InvestigationSession>("/v1/investigations", { method: "POST", body: JSON.stringify({ title }) }),
  clearInvestigations: () => request<{ sessionsDeleted: number; messagesDeleted: number; toolAuditsDeleted: number; actionProposalsDeleted: number }>("/v1/investigations", { method: "DELETE" }),
  messages: (sessionId: string) => request<{ messages: InvestigationMessage[] }>(`/v1/investigations/${sessionId}/messages`),
  chat: (sessionId: string, content: string) => request<InvestigationMessage>(`/v1/investigations/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  actions: (limit = 200) => request<{ actions: ActionProposal[] }>(`/v1/actions?${query({ limit })}`),
  action: (proposalId: string) => request<{ action: ActionProposal; events: ActionEvent[] }>(`/v1/actions/${proposalId}`),
  decideAction: (proposalId: string, decision: "approved" | "rejected") => request<ActionProposal>(`/v1/actions/${proposalId}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  executeAction: (proposalId: string) => request<ActionProposal>(`/v1/actions/${proposalId}/execute`, { method: "POST", body: "{}" }),
  previewAction: (proposalId: string) => request<{ before: Record<string, unknown>; proposed: Record<string, unknown>; capturedAt: string }>(`/v1/actions/${proposalId}/preview`),
  requestActionRevision: (proposalId: string, reason: string) => request<ActionEvent>(`/v1/actions/${proposalId}/revision-request`, { method: "POST", body: JSON.stringify({ reason }) }),
  scheduleAction: (proposalId: string, scheduledFor: string) => request<ActionProposal>(`/v1/actions/${proposalId}/schedule`, { method: "POST", body: JSON.stringify({ scheduledFor }) }),
  notifications: (unreadOnly = false) => request<{ notifications: Notification[] }>(`/v1/notifications?${query({ limit: 200, unreadOnly })}`),
  markNotificationRead: (notificationId: string) => request<Notification>(`/v1/notifications/${notificationId}/read`, { method: "POST", body: "{}" }),
  markAllNotificationsRead: () => request<{ updated: number }>("/v1/notifications/read-all", { method: "POST", body: "{}" }),
  archiveNotification: (notificationId: string, operation: "archive" | "dismiss") => request<Notification>(`/v1/notifications/${notificationId}/${operation}`, { method: "POST", body: "{}" }),
  notificationPreferences: () => request<{ preferences: Record<string, boolean | string | number> }>("/v1/notification-preferences"),
  saveNotificationPreferences: (preferences: Record<string, boolean | string | number>) => request<{ preferences: Record<string, boolean | string | number> }>("/v1/notification-preferences", { method: "PUT", body: JSON.stringify(preferences) }),
  policies: () => request<{ policies: PolicyRecord[] }>("/v1/autonomy/policies"),
  policyHistory: (scopeType: string, scopeId: string) => request<{ versions: Array<PolicyRecord & { actor: string }> }>(`/v1/autonomy/policies/${scopeType}/${scopeId}/history`),
  savePolicy: (scopeType: string, scopeId: string, policy: PolicyRecord["policy"]) => request<PolicyRecord>(`/v1/autonomy/policies/${scopeType}/${scopeId}`, { method: "PUT", body: JSON.stringify({ policy, enabled: true }) }),
  incidents: (status?: IncidentStatus) => request<{ incidents: Incident[] }>(`/v1/incidents?${query({ limit: 200, status })}`),
  incident: (incidentId: string) => request<{ incident: Incident; events: IncidentEvent[] }>(`/v1/incidents/${incidentId}`),
  createIncident: (input: Pick<Incident, "title" | "summary" | "severity" | "environment" | "affectedAgentIds">) => request<Incident>("/v1/incidents", { method: "POST", body: JSON.stringify(input) }),
  updateIncident: (incidentId: string, input: { status?: IncidentStatus; owner?: string | null; note?: string; investigationSessionId?: string }) => request<Incident>(`/v1/incidents/${incidentId}`, { method: "PATCH", body: JSON.stringify(input) }),
};
