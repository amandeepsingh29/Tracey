import { createHash, randomUUID } from "node:crypto";
import {
  AgentRegistrationSchema,
  type AgentRegistration,
  type AgentRegistrationRequest,
} from "@tracey/domain";
import { AutonomyPolicySchema, type AutonomyPolicy, type PolicyDecision, type RemediationPlan } from "@tracey/autonomy";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";

const AgentRowSchema = z.object({
  agent_id: z.string().uuid(),
  display_name: z.string(),
  service_name: z.string(),
  producer_type: z.string(),
  environment: z.string(),
  normalization_profile: z.string(),
  telemetry_contract_version: z.string(),
  status: z.string(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

const DiagnosisRowSchema = z.object({
  snapshot_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  trace_id: z.string(),
  run_id: z.string(),
  summary: z.string(),
  diagnosis: z.record(z.unknown()),
  evidence_refs: z.array(z.unknown()),
  distance: z.coerce.number().finite(),
  created_at: z.coerce.date(),
});

export interface PostgresStoreConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export interface DiagnosisSnapshotInput {
  agentId: string;
  traceId: string;
  runId: string;
  summary: string;
  diagnosis: Record<string, unknown>;
  evidenceRefs: unknown[];
  embedding: number[];
}

export interface DiagnosisMatch {
  snapshotId: string;
  agentId: string;
  traceId: string;
  runId: string;
  summary: string;
  diagnosis: Record<string, unknown>;
  evidenceRefs: unknown[];
  similarity: number;
  createdAt: string;
}

export interface InvestigationSession {
  sessionId: string;
  title: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationMessage {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  evidenceRefs: unknown[];
  model?: string;
  grounding?: "evidence_bound" | "tool_grounded" | "model_only";
  toolCallCount?: number;
  createdAt: string;
}

export interface TriggerRuleInput {
  agentId: string;
  name: string;
  kind: "trace_webhook" | "error_run" | "latency";
  threshold?: number;
  lookbackMinutes: number;
  cooldownMinutes: number;
  enabled?: boolean;
}

export interface TriggerRule extends TriggerRuleInput {
  triggerId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActionProposal {
  proposalId: string; sessionId: string; actionType: "notification" | "ticket" | "restart" | "rollback" | "scale" | "resource_change" | "config_change";
  target: string; reason: string; parameters: Record<string, unknown>; risk: "low" | "medium" | "high";
  status: "proposed" | "policy_evaluated" | "awaiting_approval" | "approved_for_auto_execution" | "approved" | "rejected" | "executing" | "verifying" | "succeeded" | "failed" | "reverting" | "reverted" | "revert_failed" | "executed"; proposedBy: string; approvedBy?: string;
  idempotencyKey: string; createdAt: string;
  remediationPlan?: RemediationPlan;
  policyId?: string;
  policyDecision?: PolicyDecision;
  requesterIdentity?: string;
  modelIdentity?: string;
  preActionSnapshot?: Record<string, unknown>;
  executionResult?: Record<string, unknown>;
  verificationResult?: Record<string, unknown>;
  rollbackResult?: Record<string, unknown>;
  scheduledFor?: string;
  scheduledBy?: string;
  approvalFingerprint?: string;
}

export function actionApprovalFingerprint(proposal: Pick<ActionProposal, "actionType" | "target" | "reason" | "parameters" | "risk" | "remediationPlan">): string {
  return createHash("sha256").update(JSON.stringify({
    actionType: proposal.actionType,
    target: proposal.target,
    reason: proposal.reason,
    parameters: proposal.parameters,
    risk: proposal.risk,
    remediationPlan: proposal.remediationPlan ?? null,
  })).digest("hex");
}

export function actionApprovalIsCurrent(proposal: ActionProposal): boolean {
  return Boolean(proposal.approvalFingerprint) && proposal.approvalFingerprint === actionApprovalFingerprint(proposal);
}

export interface TraceyNotification {
  notificationId:string; sessionId?:string; triggerId?:string; title:string; summary:string;
  severity:"info"|"warning"|"critical"; correlationType:"trace"|"codex_conversation"|"system";
  correlationId:string; readAt?:string; archivedAt?:string; dismissedAt?:string; createdAt:string;
  category?: "incident" | "approval" | "failure" | "recovery" | "connector" | "system"; environment?: string;
}

export interface Incident {
  incidentId: string; title: string; summary: string; severity: "info" | "warning" | "critical";
  status: "open" | "investigating" | "monitoring" | "resolved" | "dismissed"; environment: string;
  affectedAgentIds: string[]; owner?: string; startedAt: string; resolvedAt?: string;
  investigationSessionId?: string; createdAt: string; updatedAt: string;
}

export interface IncidentEvent {
  eventId: string; incidentId: string; eventType: string; actor: string; details: Record<string, unknown>; createdAt: string;
}

export interface ConnectorConfigRecord {
  connectorId: "signoz" | "kubernetes" | "codex" | "claude-code" | "generic-otel" | "mcp";
  publicConfig: Record<string, unknown>; encryptedSecrets?: string; secretNames: string[]; enabled: boolean;
  status: "ready" | "unhealthy" | "needs_configuration" | "disabled"; effectiveIdentity?: string;
  lastCheckedAt?: string; latestError?: string; updatedBy: string; createdAt: string; updatedAt: string;
}

export interface AutonomyPolicyRecord {
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
}

export interface BreakGlassOverride {
  overrideId: string;
  scopeType: AutonomyPolicyRecord["scopeType"];
  scopeId: string;
  policy: AutonomyPolicy;
  reason: string;
  activatedBy: string;
  activatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
}

export interface ActionEvent {
  eventId: string;
  proposalId: string;
  fromStatus?: ActionProposal["status"];
  toStatus: ActionProposal["status"];
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export class PostgresStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresStoreError";
  }
}

const EMBEDDING_DIMENSIONS = 1_536;

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new PostgresStoreError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new PostgresStoreError(`embedding must contain exactly ${EMBEDDING_DIMENSIONS} finite values`);
  }
  return `[${vector.join(",")}]`;
}

function normalizeAgent(row: QueryResultRow): AgentRegistration {
  const parsed = AgentRowSchema.parse(row);
  return AgentRegistrationSchema.parse({
    agentId: parsed.agent_id,
    displayName: parsed.display_name,
    serviceName: parsed.service_name,
    producerType: parsed.producer_type,
    environment: parsed.environment,
    normalizationProfile: parsed.normalization_profile,
    telemetryContractVersion: parsed.telemetry_contract_version,
    status: parsed.status,
    createdAt: parsed.created_at.toISOString(),
    updatedAt: parsed.updated_at.toISOString(),
  });
}

function normalizeActionProposal(row: QueryResultRow): ActionProposal {
  return {
    proposalId:String(row.proposal_id), sessionId:String(row.session_id), actionType:row.action_type as ActionProposal["actionType"],
    target:String(row.target), reason:String(row.reason), parameters:row.parameters as Record<string,unknown>, risk:row.risk as ActionProposal["risk"],
    status:row.status as ActionProposal["status"], proposedBy:String(row.proposed_by), ...(row.approved_by?{approvedBy:String(row.approved_by)}:{}),
    idempotencyKey:String(row.idempotency_key), createdAt:new Date(row.created_at as string).toISOString(),
    ...(row.remediation_plan ? { remediationPlan: row.remediation_plan as RemediationPlan } : {}),
    ...(row.policy_id ? { policyId: String(row.policy_id) } : {}),
    ...(row.policy_decision ? { policyDecision: row.policy_decision as unknown as PolicyDecision } : {}),
    ...(row.requester_identity ? { requesterIdentity: String(row.requester_identity) } : {}),
    ...(row.model_identity ? { modelIdentity: String(row.model_identity) } : {}),
    ...(row.pre_action_snapshot ? { preActionSnapshot: row.pre_action_snapshot as Record<string, unknown> } : {}),
    ...(row.execution_result ? { executionResult: row.execution_result as Record<string, unknown> } : {}),
    ...(row.verification_result ? { verificationResult: row.verification_result as Record<string, unknown> } : {}),
    ...(row.rollback_result ? { rollbackResult: row.rollback_result as Record<string, unknown> } : {}),
    ...(row.scheduled_for ? { scheduledFor: new Date(row.scheduled_for as string).toISOString() } : {}),
    ...(row.approval_fingerprint ? { approvalFingerprint: String(row.approval_fingerprint) } : {}),
    ...(row.scheduled_by ? { scheduledBy: String(row.scheduled_by) } : {}),
  };
}

function normalizeNotification(row:QueryResultRow):TraceyNotification{return{notificationId:String(row.notification_id),
  ...(row.session_id?{sessionId:String(row.session_id)}:{}),...(row.trigger_id?{triggerId:String(row.trigger_id)}:{}),title:String(row.title),summary:String(row.summary),
  severity:row.severity as TraceyNotification["severity"],correlationType:row.correlation_type as TraceyNotification["correlationType"],correlationId:String(row.correlation_id),
  ...(row.read_at?{readAt:new Date(row.read_at as string).toISOString()}:{}),...(row.archived_at?{archivedAt:new Date(row.archived_at as string).toISOString()}:{}),
  ...(row.dismissed_at?{dismissedAt:new Date(row.dismissed_at as string).toISOString()}:{}),...(row.category?{category:row.category as NonNullable<TraceyNotification["category"]>}:{}),
  ...(row.environment?{environment:String(row.environment)}:{}),createdAt:new Date(row.created_at as string).toISOString()};}

function normalizePolicy(row: QueryResultRow): AutonomyPolicyRecord {
  return {
    policyId: String(row.policy_id),
    scopeType: row.scope_type as AutonomyPolicyRecord["scopeType"],
    scopeId: String(row.scope_id),
    policy: AutonomyPolicySchema.parse(row.policy),
    version: Number(row.version),
    enabled: Boolean(row.enabled),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function normalizeIncident(row: QueryResultRow): Incident { return {
  incidentId: String(row.incident_id), title: String(row.title), summary: String(row.summary),
  severity: row.severity as Incident["severity"], status: row.status as Incident["status"], environment: String(row.environment),
  affectedAgentIds: z.array(z.string().uuid()).parse(row.affected_agent_ids), ...(row.owner ? { owner: String(row.owner) } : {}),
  startedAt: new Date(row.started_at as string).toISOString(), ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at as string).toISOString() } : {}),
  ...(row.investigation_session_id ? { investigationSessionId: String(row.investigation_session_id) } : {}),
  createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
}; }

function normalizeConnectorConfig(row: QueryResultRow): ConnectorConfigRecord { return {
  connectorId: row.connector_id as ConnectorConfigRecord["connectorId"], publicConfig: row.public_config as Record<string, unknown>,
  ...(row.encrypted_secrets ? { encryptedSecrets: String(row.encrypted_secrets) } : {}), secretNames: z.array(z.string()).parse(row.secret_names),
  enabled: Boolean(row.enabled), status: row.status as ConnectorConfigRecord["status"], ...(row.effective_identity ? { effectiveIdentity: String(row.effective_identity) } : {}),
  ...(row.last_checked_at ? { lastCheckedAt: new Date(row.last_checked_at as string).toISOString() } : {}), ...(row.latest_error ? { latestError: String(row.latest_error) } : {}),
  updatedBy: String(row.updated_by), createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
}; }

function normalizeBreakGlassOverride(row: QueryResultRow): BreakGlassOverride {
  return {
    overrideId: String(row.override_id),
    scopeType: row.scope_type as BreakGlassOverride["scopeType"],
    scopeId: String(row.scope_id),
    policy: AutonomyPolicySchema.parse(row.policy),
    reason: String(row.reason),
    activatedBy: String(row.activated_by),
    activatedAt: new Date(row.activated_at as string).toISOString(),
    expiresAt: new Date(row.expires_at as string).toISOString(),
    ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at as string).toISOString() } : {}),
    ...(row.revoked_by ? { revokedBy: String(row.revoked_by) } : {}),
    ...(row.revocation_reason ? { revocationReason: String(row.revocation_reason) } : {}),
  };
}

export class PostgresStore {
  private readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(config: PostgresStoreConfig) {
    const parsed = new URL(config.connectionString);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
      throw new PostgresStoreError("DATABASE_URL must use the postgres or postgresql protocol");
    }
    this.statementTimeoutMs = boundedInteger(config.statementTimeoutMs ?? 5_000, 100, 30_000, "statementTimeoutMs");
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: boundedInteger(config.maxConnections ?? 10, 1, 100, "maxConnections"),
      idleTimeoutMillis: boundedInteger(config.idleTimeoutMs ?? 30_000, 1_000, 300_000, "idleTimeoutMs"),
      connectionTimeoutMillis: this.statementTimeoutMs,
      statement_timeout: this.statementTimeoutMs,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async checkHealth(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  private async withTenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (tenantId.length === 0 || tenantId.length > 128) throw new PostgresStoreError("tenantId is invalid");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('tracey.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.statementTimeoutMs)]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new PostgresStoreError("PostgreSQL operation failed", { cause: error });
    } finally {
      client.release();
    }
  }

  async registerAgent(tenantId: string, input: AgentRegistrationRequest): Promise<AgentRegistration> {
    const agentId = randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tracey.agent_integrations (
           tenant_id, agent_id, display_name, service_name, producer_type, environment,
           normalization_profile, telemetry_contract_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, service_name, environment) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           producer_type = EXCLUDED.producer_type,
           normalization_profile = EXCLUDED.normalization_profile,
           telemetry_contract_version = EXCLUDED.telemetry_contract_version,
           status = 'active',
           updated_at = now()
         RETURNING agent_id, display_name, service_name, producer_type, environment,
                   normalization_profile, telemetry_contract_version, status, created_at, updated_at`,
        [
          tenantId,
          agentId,
          input.displayName,
          input.serviceName,
          input.producerType,
          input.environment,
          input.normalizationProfile,
          input.telemetryContractVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new PostgresStoreError("Agent registration returned no row");
      return normalizeAgent(row);
    });
  }

  async listAgents(tenantId: string, limit = 50): Promise<AgentRegistration[]> {
    const safeLimit = boundedInteger(limit, 1, 100, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT agent_id, display_name, service_name, producer_type, environment,
                normalization_profile, telemetry_contract_version, status, created_at, updated_at
           FROM tracey.agent_integrations
          WHERE tenant_id = $1
          ORDER BY created_at DESC, agent_id DESC
          LIMIT $2`,
        [tenantId, safeLimit],
      );
      return result.rows.map(normalizeAgent);
    });
  }

  async getAgent(tenantId: string, agentId: string): Promise<AgentRegistration | undefined> {
    const parsedAgentId = z.string().uuid().parse(agentId);
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT agent_id, display_name, service_name, producer_type, environment,
                normalization_profile, telemetry_contract_version, status, created_at, updated_at
           FROM tracey.agent_integrations
          WHERE tenant_id = $1 AND agent_id = $2
          LIMIT 1`,
        [tenantId, parsedAgentId],
      );
      const row = result.rows[0];
      return row ? normalizeAgent(row) : undefined;
    });
  }

  async createInvestigationSession(tenantId: string, title: string): Promise<InvestigationSession> {
    const boundedTitle = z.string().trim().min(1).max(200).parse(title);
    const sessionId = randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tracey.investigation_sessions (tenant_id, session_id, title)
         VALUES ($1, $2, $3)
         RETURNING session_id, title, status, created_at, updated_at`,
        [tenantId, sessionId, boundedTitle],
      );
      const row = result.rows[0] as Record<string, unknown>;
      return {
        sessionId: String(row.session_id), title: String(row.title), status: row.status as "active",
        createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
      };
    });
  }

  async listInvestigationSessions(tenantId: string, limit = 100): Promise<InvestigationSession[]> {
    const safeLimit = boundedInteger(limit, 1, 200, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT session_id,title,status,created_at,updated_at
           FROM tracey.investigation_sessions
          WHERE tenant_id=$1 ORDER BY updated_at DESC,session_id DESC LIMIT $2`,
        [tenantId, safeLimit],
      );
      return result.rows.map((row) => ({
        sessionId: String(row.session_id), title: String(row.title), status: row.status as "active" | "closed",
        createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString(),
      }));
    });
  }

  async clearInvestigationHistory(tenantId: string): Promise<{
    sessionsDeleted: number;
    messagesDeleted: number;
    toolAuditsDeleted: number;
    actionProposalsDeleted: number;
  }> {
    return this.withTenant(tenantId, async (client) => {
      const counts = await client.query(
        `SELECT
          (SELECT count(*)::int FROM tracey.investigation_sessions WHERE tenant_id=$1) AS sessions,
          (SELECT count(*)::int FROM tracey.investigation_messages WHERE tenant_id=$1) AS messages,
          (SELECT count(*)::int FROM tracey.agent_tool_audit WHERE tenant_id=$1) AS tool_audits,
          (SELECT count(*)::int FROM tracey.action_proposals WHERE tenant_id=$1) AS action_proposals`,
        [tenantId],
      );
      const row = counts.rows[0] as Record<string, unknown>;
      // These tables use tenant-scoped composite foreign keys with SET NULL,
      // but tenant_id itself is intentionally non-nullable. Detach only the
      // nullable session reference before deleting the parent sessions.
      await client.query(`UPDATE tracey.trigger_executions SET session_id=NULL WHERE tenant_id=$1 AND session_id IS NOT NULL`, [tenantId]);
      await client.query(`UPDATE tracey.notifications SET session_id=NULL WHERE tenant_id=$1 AND session_id IS NOT NULL`, [tenantId]);
      await client.query(`UPDATE tracey.incidents SET investigation_session_id=NULL WHERE tenant_id=$1 AND investigation_session_id IS NOT NULL`, [tenantId]);
      await client.query(`DELETE FROM tracey.investigation_sessions WHERE tenant_id=$1`, [tenantId]);
      return {
        sessionsDeleted: Number(row.sessions ?? 0),
        messagesDeleted: Number(row.messages ?? 0),
        toolAuditsDeleted: Number(row.tool_audits ?? 0),
        actionProposalsDeleted: Number(row.action_proposals ?? 0),
      };
    });
  }

  async appendInvestigationMessage(
    tenantId: string,
    input: { sessionId: string; role: "user" | "assistant"; content: string; evidenceRefs?: unknown[]; model?: string; grounding?: InvestigationMessage["grounding"]; toolCallCount?: number },
  ): Promise<InvestigationMessage> {
    const parsed = z.object({
      sessionId: z.string().uuid(), role: z.enum(["user", "assistant"]),
      content: z.string().trim().min(1).max(20_000), evidenceRefs: z.array(z.unknown()).max(500).default([]),
      model: z.string().trim().min(1).max(200).optional(),
      grounding: z.enum(["evidence_bound", "tool_grounded", "model_only"]).optional(),
      toolCallCount: z.number().int().min(0).max(100).optional(),
    }).parse(input);
    const messageId = randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tracey.investigation_messages
          (tenant_id, message_id, session_id, role, content, evidence_refs, model, grounding, tool_call_count)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING message_id, session_id, role, content, evidence_refs, model, grounding, tool_call_count, created_at`,
        [tenantId, messageId, parsed.sessionId, parsed.role, parsed.content, JSON.stringify(parsed.evidenceRefs), parsed.model ?? null, parsed.grounding ?? null, parsed.toolCallCount ?? null],
      );
      await client.query(`UPDATE tracey.investigation_sessions SET updated_at=now() WHERE tenant_id=$1 AND session_id=$2`, [tenantId, parsed.sessionId]);
      const row = result.rows[0] as Record<string, unknown>;
      return { messageId: String(row.message_id), sessionId: String(row.session_id), role: row.role as "user" | "assistant",
        content: String(row.content), evidenceRefs: row.evidence_refs as unknown[], ...(row.model ? { model: String(row.model) } : {}),
        ...(row.grounding ? { grounding: row.grounding as NonNullable<InvestigationMessage["grounding"]> } : {}),
        ...(row.tool_call_count !== null && row.tool_call_count !== undefined ? { toolCallCount: Number(row.tool_call_count) } : {}),
        createdAt: new Date(row.created_at as string).toISOString() };
    });
  }

  async listInvestigationMessages(tenantId: string, sessionId: string, limit = 100): Promise<InvestigationMessage[]> {
    const parsedId = z.string().uuid().parse(sessionId);
    const safeLimit = boundedInteger(limit, 1, 200, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT message_id, session_id, role, content, evidence_refs, model, grounding, tool_call_count, created_at
           FROM tracey.investigation_messages
          WHERE tenant_id = $1 AND session_id = $2
          ORDER BY created_at ASC, message_id ASC LIMIT $3`, [tenantId, parsedId, safeLimit]);
      return result.rows.map((row) => ({ messageId: String(row.message_id), sessionId: String(row.session_id), role: row.role as "user" | "assistant",
        content: String(row.content), evidenceRefs: row.evidence_refs as unknown[], ...(row.model ? { model: String(row.model) } : {}),
        ...(row.grounding ? { grounding: row.grounding as NonNullable<InvestigationMessage["grounding"]> } : {}),
        ...(row.tool_call_count !== null && row.tool_call_count !== undefined ? { toolCallCount: Number(row.tool_call_count) } : {}),
        createdAt: new Date(row.created_at as string).toISOString() }));
    });
  }

  async recordAgentToolAudit(tenantId: string, input: {
    sessionId: string; toolName: string; outcome: "success" | "error" | "denied";
    arguments: unknown; evidenceRefs: unknown[]; durationMs: number;
  }): Promise<void> {
    const hash = createHash("sha256").update(JSON.stringify(input.arguments)).digest("hex");
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tracey.agent_tool_audit
          (tenant_id, audit_id, session_id, tool_name, outcome, argument_hash, evidence_refs, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [tenantId, randomUUID(), input.sessionId, input.toolName, input.outcome, hash, JSON.stringify(input.evidenceRefs), Math.max(0, Math.round(input.durationMs))],
      );
    });
  }

  async createTriggerRule(tenantId: string, input: TriggerRuleInput): Promise<TriggerRule> {
    const parsed = z.object({
      agentId: z.string().uuid(), name: z.string().trim().min(1).max(200),
      kind: z.enum(["trace_webhook", "error_run", "latency"]), threshold: z.number().finite().nonnegative().optional(),
      lookbackMinutes: z.number().int().min(1).max(10_080), cooldownMinutes: z.number().int().min(1).max(10_080),
      enabled: z.boolean().default(true),
    }).parse(input);
    const triggerId = randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tracey.investigation_triggers
          (tenant_id, trigger_id, agent_id, name, kind, threshold, lookback_minutes, cooldown_minutes, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING trigger_id, agent_id, name, kind, threshold, lookback_minutes, cooldown_minutes, enabled, created_at, updated_at`,
        [tenantId, triggerId, parsed.agentId, parsed.name, parsed.kind, parsed.threshold ?? null, parsed.lookbackMinutes, parsed.cooldownMinutes, parsed.enabled]);
      const row = result.rows[0] as Record<string, unknown>;
      return { triggerId: String(row.trigger_id), agentId: String(row.agent_id), name: String(row.name), kind: row.kind as TriggerRule["kind"],
        ...(row.threshold === null ? {} : { threshold: Number(row.threshold) }), lookbackMinutes: Number(row.lookback_minutes),
        cooldownMinutes: Number(row.cooldown_minutes), enabled: Boolean(row.enabled),
        createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
    });
  }

  async listTriggerRules(tenantId: string): Promise<TriggerRule[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT trigger_id, agent_id, name, kind, threshold, lookback_minutes, cooldown_minutes, enabled, created_at, updated_at
           FROM tracey.investigation_triggers WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200`, [tenantId]);
      return result.rows.map((row) => ({ triggerId: String(row.trigger_id), agentId: String(row.agent_id), name: String(row.name), kind: row.kind as TriggerRule["kind"],
        ...(row.threshold === null ? {} : { threshold: Number(row.threshold) }), lookbackMinutes: Number(row.lookback_minutes),
        cooldownMinutes: Number(row.cooldown_minutes), enabled: Boolean(row.enabled),
        createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() }));
    });
  }

  async claimDueTriggerRules(tenantId: string, workerId: string, limit = 10): Promise<TriggerRule[]> {
    const owner = z.string().min(1).max(200).parse(workerId);
    const safeLimit = boundedInteger(limit, 1, 50, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `WITH due AS (
           SELECT trigger_id FROM tracey.investigation_triggers
            WHERE tenant_id=$1 AND enabled AND kind IN ('error_run','latency')
              AND next_poll_at <= now() AND (lease_until IS NULL OR lease_until < now())
            ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE tracey.investigation_triggers t SET lease_owner=$3, lease_until=now()+interval '2 minutes'
          FROM due WHERE t.tenant_id=$1 AND t.trigger_id=due.trigger_id
         RETURNING t.trigger_id,t.agent_id,t.name,t.kind,t.threshold,t.lookback_minutes,t.cooldown_minutes,t.enabled,t.created_at,t.updated_at`,
        [tenantId, safeLimit, owner]);
      return result.rows.map((row) => ({ triggerId: String(row.trigger_id), agentId: String(row.agent_id), name: String(row.name), kind: row.kind as TriggerRule["kind"],
        ...(row.threshold === null ? {} : { threshold: Number(row.threshold) }), lookbackMinutes: Number(row.lookback_minutes), cooldownMinutes: Number(row.cooldown_minutes),
        enabled: Boolean(row.enabled), createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() }));
    });
  }

  async completeTriggerPoll(tenantId: string, triggerId: string, workerId: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE tracey.investigation_triggers
            SET lease_owner=NULL, lease_until=NULL, next_poll_at=now()+(cooldown_minutes*interval '1 minute')
          WHERE tenant_id=$1 AND trigger_id=$2 AND lease_owner=$3`, [tenantId, z.string().uuid().parse(triggerId), workerId]);
    });
  }

  async createActionProposal(tenantId: string, input: {
    sessionId: string; actionType: ActionProposal["actionType"]; target: string; reason: string;
    parameters: Record<string, unknown>; risk: ActionProposal["risk"]; proposedBy: string;
  }): Promise<ActionProposal> {
    const parsed = z.object({ sessionId:z.string().uuid(), actionType:z.enum(["notification","ticket","restart","rollback","scale","resource_change","config_change"]),
      target:z.string().trim().min(1).max(500), reason:z.string().trim().min(1).max(4_000), parameters:z.record(z.unknown()),
      risk:z.enum(["low","medium","high"]), proposedBy:z.string().min(1).max(300) }).parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed.parameters)) > 16_000) throw new PostgresStoreError("action parameters exceed 16KB");
    const proposalId=randomUUID(), idempotencyKey=randomUUID();
    return this.withTenant(tenantId, async (client) => {
      const result=await client.query(
        `INSERT INTO tracey.action_proposals
          (tenant_id,proposal_id,session_id,action_type,target,reason,parameters,risk,proposed_by,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         RETURNING *`, [tenantId,proposalId,parsed.sessionId,parsed.actionType,parsed.target,parsed.reason,JSON.stringify(parsed.parameters),parsed.risk,parsed.proposedBy,idempotencyKey]);
      return normalizeActionProposal(result.rows[0]);
    });
  }

  async decideActionProposal(tenantId:string, proposalId:string, decision:"approved"|"rejected", actor:string):Promise<ActionProposal|undefined>{
    return this.withTenant(tenantId, async(client)=>{
      const id=z.string().uuid().parse(proposalId),safeActor=z.string().min(1).max(300).parse(actor);
      const locked=await client.query(`SELECT * FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2 FOR UPDATE`,[tenantId,id]);
      const previous=locked.rows[0]?.status as ActionProposal["status"]|undefined;
      if(!previous||!["proposed","awaiting_approval"].includes(previous))return undefined;
      const fingerprint = decision === "approved" ? actionApprovalFingerprint(normalizeActionProposal(locked.rows[0])) : null;
      const result=await client.query(
        `UPDATE tracey.action_proposals SET status=$3,approved_by=$4,approval_fingerprint=$5,decided_at=now(),state_updated_at=now()
          WHERE tenant_id=$1 AND proposal_id=$2 RETURNING *`,[tenantId,id,decision,safeActor,fingerprint]);
      await client.query(
        `INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details)
         VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,[tenantId,randomUUID(),id,previous,decision,safeActor]);
      return result.rows[0]?normalizeActionProposal(result.rows[0]):undefined;});
  }

  async getActionProposal(tenantId:string, proposalId:string):Promise<ActionProposal|undefined>{
    return this.withTenant(tenantId,async(client)=>{const result=await client.query(`SELECT * FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2 LIMIT 1`,[tenantId,z.string().uuid().parse(proposalId)]);return result.rows[0]?normalizeActionProposal(result.rows[0]):undefined;});
  }

  async requireActionReapproval(tenantId: string, proposalId: string, actor: string): Promise<ActionProposal | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const id = z.string().uuid().parse(proposalId);
      const safeActor = z.string().min(1).max(300).parse(actor);
      const locked = await client.query(
        `SELECT status FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2 FOR UPDATE`,
        [tenantId, id],
      );
      const previous = locked.rows[0]?.status as ActionProposal["status"] | undefined;
      if (!previous || !["approved", "approved_for_auto_execution"].includes(previous)) return undefined;
      const result = await client.query(
        `UPDATE tracey.action_proposals SET status='awaiting_approval',approved_by=NULL,approval_fingerprint=NULL,state_updated_at=now()
         WHERE tenant_id=$1 AND proposal_id=$2 AND status IN ('approved','approved_for_auto_execution') RETURNING *`,
        [tenantId, id],
      );
      if (!result.rows[0]) return undefined;
      await client.query(
        `INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details)
         VALUES ($1,$2,$3,$4,'awaiting_approval',$5,$6::jsonb)`,
        [tenantId, randomUUID(), id, previous, safeActor, JSON.stringify({ type: "approval_invalidated", reason: "proposal_content_changed" })],
      );
      return normalizeActionProposal(result.rows[0]);
    });
  }

  async listActionProposals(tenantId: string, limit = 100): Promise<ActionProposal[]> {
    const safeLimit = boundedInteger(limit, 1, 200, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.action_proposals WHERE tenant_id=$1
          ORDER BY created_at DESC,proposal_id DESC LIMIT $2`, [tenantId, safeLimit],
      );
      return result.rows.map(normalizeActionProposal);
    });
  }

  async completeActionProposal(tenantId:string,proposalId:string,status:"executed"|"failed"):Promise<void>{
    await this.withTenant(tenantId,async(client)=>{await client.query(`UPDATE tracey.action_proposals SET status=$3,executed_at=now() WHERE tenant_id=$1 AND proposal_id=$2 AND status='approved'`,[tenantId,z.string().uuid().parse(proposalId),status]);});
  }

  async getTriggerRule(tenantId: string, triggerId: string): Promise<TriggerRule | undefined> {
    const id = z.string().uuid().parse(triggerId);
    const rules = await this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT trigger_id, agent_id, name, kind, threshold, lookback_minutes, cooldown_minutes, enabled, created_at, updated_at
           FROM tracey.investigation_triggers WHERE tenant_id=$1 AND trigger_id=$2 LIMIT 1`, [tenantId, id]);
      return result.rows;
    });
    const row = rules[0];
    return row ? { triggerId: String(row.trigger_id), agentId: String(row.agent_id), name: String(row.name), kind: row.kind as TriggerRule["kind"],
      ...(row.threshold === null ? {} : { threshold: Number(row.threshold) }), lookbackMinutes: Number(row.lookback_minutes),
      cooldownMinutes: Number(row.cooldown_minutes), enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() } : undefined;
  }

  async startTriggerExecution(tenantId: string, input: {
    triggerId: string; correlationType: "trace" | "codex_conversation"; correlationId: string;
  }): Promise<string> {
    const parsed = z.discriminatedUnion("correlationType", [
      z.object({ triggerId: z.string().uuid(), correlationType: z.literal("trace"), correlationId: z.string().regex(/^[a-fA-F0-9]{32}$/) }),
      z.object({ triggerId: z.string().uuid(), correlationType: z.literal("codex_conversation"), correlationId: z.string().uuid() }),
    ]).parse(input);
    const executionId = randomUUID();
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tracey.trigger_executions
          (tenant_id, execution_id, trigger_id, trace_id, correlation_type, correlation_id, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,'started')`,
        [tenantId, executionId, parsed.triggerId, parsed.correlationType === "trace" ? parsed.correlationId : null, parsed.correlationType, parsed.correlationId]);
    });
    return executionId;
  }

  async completeTriggerExecution(tenantId: string, input: {
    executionId: string; outcome: "completed" | "failed" | "suppressed"; sessionId?: string; errorType?: string;
  }): Promise<void> {
    const parsed = z.object({ executionId: z.string().uuid(), outcome: z.enum(["completed", "failed", "suppressed"]),
      sessionId: z.string().uuid().optional(), errorType: z.string().min(1).max(200).optional() }).parse(input);
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE tracey.trigger_executions SET outcome=$3, session_id=$4, error_type=$5, completed_at=now()
          WHERE tenant_id=$1 AND execution_id=$2`,
        [tenantId, parsed.executionId, parsed.outcome, parsed.sessionId ?? null, parsed.errorType ?? null]);
    });
  }

  async createNotification(tenantId:string,input:{sessionId?:string;triggerId?:string;title:string;summary:string;
    severity:TraceyNotification["severity"];correlationType:TraceyNotification["correlationType"];correlationId:string;category?:TraceyNotification["category"];environment?:string}):Promise<TraceyNotification>{
    const parsed=z.object({sessionId:z.string().uuid().optional(),triggerId:z.string().uuid().optional(),title:z.string().trim().min(1).max(200),
      summary:z.string().trim().min(1).max(4_000),severity:z.enum(["info","warning","critical"]),correlationType:z.enum(["trace","codex_conversation","system"]),
      correlationId:z.string().trim().min(1).max(128),category:z.enum(["incident","approval","failure","recovery","connector","system"]).optional(),environment:z.string().trim().min(1).max(100).optional()}).parse(input);const notificationId=randomUUID();
    const text=`${parsed.title} ${parsed.summary}`.toLowerCase();const category=parsed.category??(text.includes("connector")?"connector":text.includes("recover")||text.includes("revert")||text.includes("rollback")?"recovery":text.includes("fail")?"failure":text.includes("approv")||text.includes("reject")?"approval":text.includes("incident")?"incident":"system");
    return this.withTenant(tenantId,async(client)=>{const result=await client.query(
      `INSERT INTO tracey.notifications (tenant_id,notification_id,session_id,trigger_id,title,summary,severity,correlation_type,correlation_id,category,environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[tenantId,notificationId,parsed.sessionId??null,parsed.triggerId??null,parsed.title,parsed.summary,parsed.severity,parsed.correlationType,parsed.correlationId,category,parsed.environment??null]);
      return normalizeNotification(result.rows[0]);});
  }

  async listNotifications(tenantId:string,input:{limit?:number;unreadOnly?:boolean}={}):Promise<TraceyNotification[]>{
    const limit=boundedInteger(input.limit??100,1,200,"limit");return this.withTenant(tenantId,async(client)=>{const result=await client.query(
      `SELECT * FROM tracey.notifications WHERE tenant_id=$1 AND archived_at IS NULL AND dismissed_at IS NULL AND ($2::boolean=false OR read_at IS NULL)
       ORDER BY (read_at IS NULL) DESC,created_at DESC,notification_id DESC LIMIT $3`,[tenantId,input.unreadOnly??false,limit]);return result.rows.map(normalizeNotification);});
  }

  async markNotificationRead(tenantId:string,notificationId:string):Promise<TraceyNotification|undefined>{
    return this.withTenant(tenantId,async(client)=>{const result=await client.query(
      `UPDATE tracey.notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND notification_id=$2 RETURNING *`,
      [tenantId,z.string().uuid().parse(notificationId)]);return result.rows[0]?normalizeNotification(result.rows[0]):undefined;});
  }

  async markAllNotificationsRead(tenantId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`UPDATE tracey.notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND archived_at IS NULL AND dismissed_at IS NULL`, [tenantId]); return result.rowCount ?? 0; });
  }

  async archiveNotification(tenantId: string, notificationId: string, dismiss = false): Promise<TraceyNotification | undefined> {
    return this.withTenant(tenantId, async (client) => { const field = dismiss ? "dismissed_at" : "archived_at"; const result = await client.query(`UPDATE tracey.notifications SET ${field}=COALESCE(${field},now()),read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND notification_id=$2 RETURNING *`, [tenantId, z.string().uuid().parse(notificationId)]); return result.rows[0] ? normalizeNotification(result.rows[0]) : undefined; });
  }

  async getNotificationPreferences(tenantId: string, subject: string): Promise<Record<string, unknown>> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`SELECT preferences FROM tracey.notification_preferences WHERE tenant_id=$1 AND subject=$2`, [tenantId, subject]); return (result.rows[0]?.preferences as Record<string, unknown> | undefined) ?? { inProduct: true, incidents: true, approvals: true, failures: true, recoveries: true, connectorProblems: true, externalDelivery: false }; });
  }

  async saveNotificationPreferences(tenantId: string, subject: string, preferences: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(JSON.stringify(preferences)) > 16_000) throw new PostgresStoreError("notification preferences exceed 16KB");
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`INSERT INTO tracey.notification_preferences (tenant_id,subject,preferences) VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant_id,subject) DO UPDATE SET preferences=EXCLUDED.preferences,updated_at=now() RETURNING preferences`, [tenantId, subject, JSON.stringify(preferences)]); return result.rows[0]?.preferences as Record<string, unknown>; });
  }

  async listConnectorConfigs(tenantId: string): Promise<ConnectorConfigRecord[]> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`SELECT * FROM tracey.connector_configs WHERE tenant_id=$1 ORDER BY connector_id`, [tenantId]); return result.rows.map(normalizeConnectorConfig); });
  }

  async getConnectorConfig(tenantId: string, connectorId: ConnectorConfigRecord["connectorId"]): Promise<ConnectorConfigRecord | undefined> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`SELECT * FROM tracey.connector_configs WHERE tenant_id=$1 AND connector_id=$2`, [tenantId, connectorId]); return result.rows[0] ? normalizeConnectorConfig(result.rows[0]) : undefined; });
  }

  async saveConnectorConfig(tenantId: string, input: {
    connectorId: ConnectorConfigRecord["connectorId"]; publicConfig: Record<string, unknown>; encryptedSecrets?: string;
    secretNames: string[]; enabled: boolean; status: ConnectorConfigRecord["status"]; effectiveIdentity?: string;
    latestError?: string; actor: string;
  }): Promise<ConnectorConfigRecord> {
    const parsed = z.object({ connectorId: z.enum(["signoz", "kubernetes", "codex", "claude-code", "generic-otel", "mcp"]), publicConfig: z.record(z.unknown()),
      encryptedSecrets: z.string().max(64_000).optional(), secretNames: z.array(z.string().min(1).max(100)).max(20), enabled: z.boolean(),
      status: z.enum(["ready", "unhealthy", "needs_configuration", "disabled"]), effectiveIdentity: z.string().trim().min(1).max(300).optional(), latestError: z.string().max(2_000).optional(), actor: z.string().trim().min(1).max(300) }).parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed.publicConfig)) > 32_000) throw new PostgresStoreError("connector configuration exceeds 32KB");
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`INSERT INTO tracey.connector_configs
      (tenant_id,connector_id,public_config,encrypted_secrets,secret_names,enabled,status,effective_identity,last_checked_at,latest_error,updated_by)
      VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,now(),$9,$10)
      ON CONFLICT (tenant_id,connector_id) DO UPDATE SET public_config=EXCLUDED.public_config,encrypted_secrets=COALESCE(EXCLUDED.encrypted_secrets,tracey.connector_configs.encrypted_secrets),
      secret_names=EXCLUDED.secret_names,enabled=EXCLUDED.enabled,status=EXCLUDED.status,effective_identity=EXCLUDED.effective_identity,last_checked_at=now(),latest_error=EXCLUDED.latest_error,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [tenantId, parsed.connectorId, JSON.stringify(parsed.publicConfig), parsed.encryptedSecrets ?? null, JSON.stringify(parsed.secretNames), parsed.enabled, parsed.status, parsed.effectiveIdentity ?? null, parsed.latestError ?? null, parsed.actor]);
      const saved=normalizeConnectorConfig(result.rows[0]);await client.query(`INSERT INTO tracey.connector_events (tenant_id,event_id,connector_id,operation,actor,details) VALUES ($1,$2,$3,'configuration_saved',$4,$5::jsonb)`,[tenantId,randomUUID(),parsed.connectorId,parsed.actor,JSON.stringify({enabled:saved.enabled,status:saved.status,publicConfig:saved.publicConfig,secretNames:saved.secretNames,effectiveIdentity:saved.effectiveIdentity})]);return saved; });
  }

  async deleteConnectorConfig(tenantId: string, connectorId: ConnectorConfigRecord["connectorId"], actor: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`DELETE FROM tracey.connector_configs WHERE tenant_id=$1 AND connector_id=$2 RETURNING connector_id`, [tenantId, connectorId]); if (!result.rows[0]) return false; await client.query(`INSERT INTO tracey.connector_events (tenant_id,event_id,connector_id,operation,actor,details) VALUES ($1,$2,$3,'deleted',$4,'{}'::jsonb)`, [tenantId, randomUUID(), connectorId, actor]); return true; });
  }

  async createIncident(tenantId: string, input: {
    title: string; summary: string; severity: Incident["severity"]; environment: string; affectedAgentIds?: string[]; actor: string;
  }): Promise<Incident> {
    const parsed = z.object({ title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(4_000),
      severity: z.enum(["info", "warning", "critical"]), environment: z.string().trim().min(1).max(100),
      affectedAgentIds: z.array(z.string().uuid()).max(100).default([]), actor: z.string().trim().min(1).max(300) }).parse(input);
    return this.withTenant(tenantId, async (client) => {
      const incidentId = randomUUID();
      const result = await client.query(`INSERT INTO tracey.incidents
        (tenant_id,incident_id,title,summary,severity,status,environment,affected_agent_ids,started_at)
        VALUES ($1,$2,$3,$4,$5,'open',$6,$7::jsonb,now()) RETURNING *`,
        [tenantId, incidentId, parsed.title, parsed.summary, parsed.severity, parsed.environment, JSON.stringify(parsed.affectedAgentIds)]);
      await client.query(`INSERT INTO tracey.incident_events (tenant_id,event_id,incident_id,event_type,actor,details)
        VALUES ($1,$2,$3,'created',$4,$5::jsonb)`, [tenantId, randomUUID(), incidentId, parsed.actor, JSON.stringify({ severity: parsed.severity })]);
      return normalizeIncident(result.rows[0]);
    });
  }

  async listIncidents(tenantId: string, input: { limit?: number; status?: Incident["status"] } = {}): Promise<Incident[]> {
    const limit = boundedInteger(input.limit ?? 100, 1, 200, "limit");
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(`SELECT * FROM tracey.incidents WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, started_at DESC LIMIT $3`, [tenantId, input.status ?? null, limit]);
      return result.rows.map(normalizeIncident);
    });
  }

  async getIncident(tenantId: string, incidentId: string): Promise<{ incident: Incident; events: IncidentEvent[] } | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const id = z.string().uuid().parse(incidentId);
      const [incident, events] = await Promise.all([
        client.query(`SELECT * FROM tracey.incidents WHERE tenant_id=$1 AND incident_id=$2`, [tenantId, id]),
        client.query(`SELECT * FROM tracey.incident_events WHERE tenant_id=$1 AND incident_id=$2 ORDER BY created_at,event_id`, [tenantId, id]),
      ]);
      if (!incident.rows[0]) return undefined;
      return { incident: normalizeIncident(incident.rows[0]), events: events.rows.map((row) => ({ eventId: String(row.event_id), incidentId: String(row.incident_id), eventType: String(row.event_type), actor: String(row.actor), details: row.details as Record<string, unknown>, createdAt: new Date(row.created_at as string).toISOString() })) };
    });
  }

  async updateIncident(tenantId: string, incidentId: string, input: {
    status?: Incident["status"]; owner?: string | null; note?: string; investigationSessionId?: string; actor: string;
  }): Promise<Incident | undefined> {
    const parsed = z.object({ status: z.enum(["open", "investigating", "monitoring", "resolved", "dismissed"]).optional(),
      owner: z.string().trim().min(1).max(300).nullable().optional(), note: z.string().trim().min(1).max(4_000).optional(),
      investigationSessionId: z.string().uuid().optional(), actor: z.string().trim().min(1).max(300) }).parse(input);
    return this.withTenant(tenantId, async (client) => {
      const id = z.string().uuid().parse(incidentId);
      const result = await client.query(`UPDATE tracey.incidents SET status=COALESCE($3,status), owner=CASE WHEN $4::boolean THEN $5 ELSE owner END,
        investigation_session_id=COALESCE($6,investigation_session_id), resolved_at=CASE WHEN $3 IN ('resolved','dismissed') THEN now() WHEN $3 IS NOT NULL THEN NULL ELSE resolved_at END, updated_at=now()
        WHERE tenant_id=$1 AND incident_id=$2 RETURNING *`, [tenantId, id, parsed.status ?? null, parsed.owner !== undefined, parsed.owner ?? null, parsed.investigationSessionId ?? null]);
      if (!result.rows[0]) return undefined;
      const eventType = parsed.note ? "note" : parsed.status ? "status_changed" : parsed.owner !== undefined ? "owner_changed" : "investigation_linked";
      await client.query(`INSERT INTO tracey.incident_events (tenant_id,event_id,incident_id,event_type,actor,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [tenantId, randomUUID(), id, eventType, parsed.actor, JSON.stringify({ ...(parsed.status ? { status: parsed.status } : {}), ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}), ...(parsed.note ? { note: parsed.note } : {}), ...(parsed.investigationSessionId ? { investigationSessionId: parsed.investigationSessionId } : {}) })]);
      return normalizeIncident(result.rows[0]);
    });
  }

  async upsertAutonomyPolicy(tenantId: string, input: {
    scopeType: AutonomyPolicyRecord["scopeType"];
    scopeId: string;
    policy: AutonomyPolicy;
    actor: string;
    enabled?: boolean;
  }): Promise<AutonomyPolicyRecord> {
    const parsed = z.object({
      scopeType: z.enum(["global", "agent", "service"]),
      scopeId: z.string().trim().min(1).max(255),
      policy: AutonomyPolicySchema,
      actor: z.string().trim().min(1).max(300),
      enabled: z.boolean().default(true),
    }).parse(input);
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO tracey.autonomy_policies
          (tenant_id, policy_id, scope_type, scope_id, policy, enabled, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7)
         ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE SET
           policy=EXCLUDED.policy, enabled=EXCLUDED.enabled, version=tracey.autonomy_policies.version+1,
           updated_by=EXCLUDED.updated_by, updated_at=now()
         RETURNING *`,
        [tenantId, randomUUID(), parsed.scopeType, parsed.scopeId, JSON.stringify(parsed.policy), parsed.enabled, parsed.actor],
      );
      const saved = normalizePolicy(result.rows[0]);
      await client.query(`INSERT INTO tracey.autonomy_policy_versions (tenant_id,policy_id,scope_type,scope_id,version,policy,enabled,actor)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING`, [tenantId, saved.policyId, saved.scopeType, saved.scopeId, saved.version, JSON.stringify(saved.policy), saved.enabled, parsed.actor]);
      return saved;
    });
  }

  async getAutonomyPolicy(tenantId: string, scopeType: AutonomyPolicyRecord["scopeType"], scopeId: string): Promise<AutonomyPolicyRecord | undefined> {
    const parsed = z.object({ scopeType: z.enum(["global", "agent", "service"]), scopeId: z.string().trim().min(1).max(255) }).parse({ scopeType, scopeId });
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.autonomy_policies
          WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 AND enabled
          LIMIT 1`, [tenantId, parsed.scopeType, parsed.scopeId],
      );
      return result.rows[0] ? normalizePolicy(result.rows[0]) : undefined;
    });
  }

  async listAutonomyPolicies(tenantId: string): Promise<AutonomyPolicyRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.autonomy_policies WHERE tenant_id=$1 ORDER BY scope_type,scope_id LIMIT 500`, [tenantId],
      );
      return result.rows.map(normalizePolicy);
    });
  }

  async listAutonomyPolicyVersions(tenantId: string, scopeType: AutonomyPolicyRecord["scopeType"], scopeId: string): Promise<Array<AutonomyPolicyRecord & { actor: string }>> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`SELECT policy_id,scope_type,scope_id,policy,version,enabled,actor,created_at FROM tracey.autonomy_policy_versions WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 ORDER BY version DESC LIMIT 200`, [tenantId, scopeType, scopeId]);
      return result.rows.map((row) => ({ policyId: String(row.policy_id), scopeType: row.scope_type as AutonomyPolicyRecord["scopeType"], scopeId: String(row.scope_id), policy: AutonomyPolicySchema.parse(row.policy), version: Number(row.version), enabled: Boolean(row.enabled), createdBy: String(row.actor), updatedBy: String(row.actor), actor: String(row.actor), createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.created_at as string).toISOString() })); });
  }

  async createBreakGlassOverride(tenantId: string, input: {
    scopeType: BreakGlassOverride["scopeType"];
    scopeId: string;
    policy: AutonomyPolicy;
    reason: string;
    durationMinutes: number;
    actor: string;
  }): Promise<BreakGlassOverride> {
    const parsed = z.object({
      scopeType: z.enum(["global", "agent", "service"]),
      scopeId: z.string().trim().min(1).max(255),
      policy: AutonomyPolicySchema,
      reason: z.string().trim().min(20).max(2_000),
      durationMinutes: z.number().int().min(5).max(60),
      actor: z.string().trim().min(1).max(300),
    }).parse(input);
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE tracey.break_glass_overrides
           SET revoked_at=now(),revoked_by=$4,revocation_reason='Superseded by a new audited override'
         WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 AND revoked_at IS NULL`,
        [tenantId, parsed.scopeType, parsed.scopeId, parsed.actor],
      );
      const result = await client.query(
        `INSERT INTO tracey.break_glass_overrides
          (tenant_id,override_id,scope_type,scope_id,policy,reason,activated_by,expires_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,now()+($8::int * interval '1 minute')) RETURNING *`,
        [tenantId, randomUUID(), parsed.scopeType, parsed.scopeId, JSON.stringify(parsed.policy), parsed.reason, parsed.actor, parsed.durationMinutes],
      );
      return normalizeBreakGlassOverride(result.rows[0]);
    });
  }

  async getActiveBreakGlassOverride(
    tenantId: string,
    scopeType: BreakGlassOverride["scopeType"],
    scopeId: string,
  ): Promise<BreakGlassOverride | undefined> {
    const parsed = z.object({ scopeType: z.enum(["global", "agent", "service"]), scopeId: z.string().trim().min(1).max(255) }).parse({ scopeType, scopeId });
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.break_glass_overrides
         WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 AND revoked_at IS NULL AND expires_at>now()
         ORDER BY activated_at DESC LIMIT 1`,
        [tenantId, parsed.scopeType, parsed.scopeId],
      );
      return result.rows[0] ? normalizeBreakGlassOverride(result.rows[0]) : undefined;
    });
  }

  async listBreakGlassOverrides(tenantId: string): Promise<BreakGlassOverride[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.break_glass_overrides WHERE tenant_id=$1 ORDER BY activated_at DESC LIMIT 100`,
        [tenantId],
      );
      return result.rows.map(normalizeBreakGlassOverride);
    });
  }

  async revokeBreakGlassOverride(tenantId: string, overrideId: string, actor: string, reason: string): Promise<BreakGlassOverride | undefined> {
    const parsed = z.object({ overrideId: z.string().uuid(), actor: z.string().trim().min(1).max(300), reason: z.string().trim().min(10).max(2_000) }).parse({ overrideId, actor, reason });
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE tracey.break_glass_overrides SET revoked_at=now(),revoked_by=$3,revocation_reason=$4
         WHERE tenant_id=$1 AND override_id=$2 AND revoked_at IS NULL RETURNING *`,
        [tenantId, parsed.overrideId, parsed.actor, parsed.reason],
      );
      return result.rows[0] ? normalizeBreakGlassOverride(result.rows[0]) : undefined;
    });
  }

  async attachPolicyEvaluation(tenantId: string, proposalId: string, input: {
    policyId: string;
    plan: RemediationPlan;
    decision: PolicyDecision;
    nextStatus: "policy_evaluated" | "awaiting_approval" | "approved_for_auto_execution" | "rejected";
    actor: string;
    requesterIdentity?: string;
    modelIdentity?: string;
  }): Promise<ActionProposal | undefined> {
    const parsed = z.object({
      policyId: z.string().uuid(),
      plan: z.record(z.unknown()),
      decision: z.record(z.unknown()),
      nextStatus: z.enum(["policy_evaluated", "awaiting_approval", "approved_for_auto_execution", "rejected"]),
      actor: z.string().min(1).max(300),
      requesterIdentity: z.string().min(1).max(300).optional(),
      modelIdentity: z.string().min(1).max(300).optional(),
    }).parse({ ...input, plan: input.plan, decision: input.decision });
    return this.withTenant(tenantId, async (client) => {
      const locked = await client.query(
        `SELECT status FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2 FOR UPDATE`,
        [tenantId, z.string().uuid().parse(proposalId)],
      );
      if (!locked.rows[0] || locked.rows[0].status !== "proposed") return undefined;
      let result = await client.query(
        `UPDATE tracey.action_proposals SET status=$3,remediation_plan=$4::jsonb,policy_id=$5,
           policy_decision=$6::jsonb,requester_identity=$7,model_identity=$8,state_updated_at=now()
         WHERE tenant_id=$1 AND proposal_id=$2 RETURNING *`,
        [tenantId, proposalId, parsed.nextStatus, JSON.stringify(parsed.plan), parsed.policyId, JSON.stringify(parsed.decision), parsed.requesterIdentity ?? null, parsed.modelIdentity ?? null],
      );
      if (parsed.nextStatus === "approved_for_auto_execution") {
        const fingerprint = actionApprovalFingerprint(normalizeActionProposal(result.rows[0]));
        result = await client.query(
          `UPDATE tracey.action_proposals SET approval_fingerprint=$3 WHERE tenant_id=$1 AND proposal_id=$2 RETURNING *`,
          [tenantId, proposalId, fingerprint],
        );
      }
      await client.query(
        `INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details)
         VALUES ($1,$2,$3,'proposed',$4,$5,$6::jsonb)`,
        [tenantId, randomUUID(), proposalId, parsed.nextStatus, parsed.actor, JSON.stringify({ policyDecision: parsed.decision })],
      );
      return normalizeActionProposal(result.rows[0]);
    });
  }

  async transitionAction(tenantId: string, proposalId: string, input: {
    expected: ActionProposal["status"][];
    next: ActionProposal["status"];
    actor: string;
    details?: Record<string, unknown>;
    resultField?: "pre_action_snapshot" | "execution_result" | "verification_result" | "rollback_result";
    result?: Record<string, unknown>;
  }): Promise<ActionProposal | undefined> {
    const id = z.string().uuid().parse(proposalId);
    const actor = z.string().min(1).max(300).parse(input.actor);
    const details = input.details ?? {};
    if (Buffer.byteLength(JSON.stringify(details)) > 32_000) throw new PostgresStoreError("action event details exceed 32KB");
    return this.withTenant(tenantId, async (client) => {
      const locked = await client.query(
        `SELECT status FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2 FOR UPDATE`, [tenantId, id],
      );
      const previous = locked.rows[0]?.status as ActionProposal["status"] | undefined;
      if (!previous || !input.expected.includes(previous)) return undefined;
      const resultColumn = input.resultField;
      const update = resultColumn
        ? `UPDATE tracey.action_proposals SET status=$3,state_updated_at=now(),${resultColumn}=$4::jsonb WHERE tenant_id=$1 AND proposal_id=$2 RETURNING *`
        : `UPDATE tracey.action_proposals SET status=$3,state_updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2 RETURNING *`;
      const result = await client.query(update, resultColumn ? [tenantId, id, input.next, JSON.stringify(input.result ?? {})] : [tenantId, id, input.next]);
      await client.query(
        `INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, randomUUID(), id, previous, input.next, actor, JSON.stringify(details)],
      );
      return normalizeActionProposal(result.rows[0]);
    });
  }

  async listActionEvents(tenantId: string, proposalId: string): Promise<ActionEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM tracey.action_events WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at,event_id LIMIT 500`,
        [tenantId, z.string().uuid().parse(proposalId)],
      );
      return result.rows.map((row) => ({
        eventId: String(row.event_id), proposalId: String(row.proposal_id),
        ...(row.from_status ? { fromStatus: row.from_status as ActionProposal["status"] } : {}),
        toStatus: row.to_status as ActionProposal["status"], actor: String(row.actor),
        details: row.details as Record<string, unknown>, createdAt: new Date(row.created_at as string).toISOString(),
      }));
    });
  }

  async recordActionEvent(tenantId: string, proposalId: string, input: { actor: string; details: Record<string, unknown> }): Promise<ActionEvent | undefined> {
    return this.withTenant(tenantId, async (client) => { const proposal = await client.query(`SELECT status FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2`, [tenantId, z.string().uuid().parse(proposalId)]); const status = proposal.rows[0]?.status as ActionProposal["status"] | undefined; if (!status) return undefined;
      const result = await client.query(`INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details) VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb) RETURNING *`, [tenantId, randomUUID(), proposalId, status, z.string().min(1).max(300).parse(input.actor), JSON.stringify(input.details)]); const row = result.rows[0]; return { eventId: String(row.event_id), proposalId: String(row.proposal_id), fromStatus: status, toStatus: status, actor: String(row.actor), details: row.details as Record<string, unknown>, createdAt: new Date(row.created_at as string).toISOString() }; });
  }

  async scheduleAction(tenantId: string, proposalId: string, scheduledFor: Date, actor: string): Promise<ActionProposal | undefined> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`UPDATE tracey.action_proposals SET scheduled_for=$3,scheduled_by=$4,state_updated_at=now() WHERE tenant_id=$1 AND proposal_id=$2 AND status IN ('approved','approved_for_auto_execution') RETURNING *`, [tenantId, z.string().uuid().parse(proposalId), scheduledFor, z.string().min(1).max(300).parse(actor)]); if (!result.rows[0]) return undefined; const saved = normalizeActionProposal(result.rows[0]); await client.query(`INSERT INTO tracey.action_events (tenant_id,event_id,proposal_id,from_status,to_status,actor,details) VALUES ($1,$2,$3,$4,$4,$5,$6::jsonb)`, [tenantId, randomUUID(), proposalId, saved.status, actor, JSON.stringify({ type: "scheduled", scheduledFor: scheduledFor.toISOString() })]); return saved; });
  }

  async listDueScheduledActions(tenantId: string, limit = 20): Promise<ActionProposal[]> {
    return this.withTenant(tenantId, async (client) => { const result = await client.query(`SELECT * FROM tracey.action_proposals WHERE tenant_id=$1 AND scheduled_for<=now() AND status IN ('approved','approved_for_auto_execution') ORDER BY scheduled_for LIMIT $2`, [tenantId, boundedInteger(limit, 1, 100, "limit")]); return result.rows.map(normalizeActionProposal); });
  }

  async countActiveActions(tenantId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::integer AS count FROM tracey.action_proposals
          WHERE tenant_id=$1 AND status IN ('approved_for_auto_execution','approved','executing','verifying','reverting')`, [tenantId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async getLastActionAt(tenantId: string, target: string): Promise<Date | undefined> {
    const safeTarget = z.string().trim().min(1).max(500).parse(target);
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT max(state_updated_at) AS last_action_at FROM tracey.action_proposals
          WHERE tenant_id=$1 AND target=$2
            AND status IN ('executing','verifying','succeeded','failed','reverting','reverted','revert_failed','executed')`,
        [tenantId, safeTarget],
      );
      const value = result.rows[0]?.last_action_at;
      return value ? new Date(value as string) : undefined;
    });
  }

  async claimExecutorAction(tenantId: string, input: {
    idempotencyKey: string;
    proposalId: string;
    action: unknown;
  }): Promise<{ claimed: boolean; status: "executing" | "succeeded" | "failed"; result?: Record<string, unknown> }> {
    const parsed = z.object({ idempotencyKey: z.string().min(1).max(255), proposalId: z.string().uuid() }).parse(input);
    const actionHash = createHash("sha256").update(JSON.stringify(input.action)).digest("hex");
    return this.withTenant(tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO tracey.executor_receipts (tenant_id,idempotency_key,proposal_id,action_hash,status)
         VALUES ($1,$2,$3,$4,'executing') ON CONFLICT DO NOTHING RETURNING status`,
        [tenantId, parsed.idempotencyKey, parsed.proposalId, actionHash],
      );
      if (inserted.rows[0]) return { claimed: true, status: "executing" };
      const existing = await client.query(
        `SELECT action_hash,status,result FROM tracey.executor_receipts
          WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenantId, parsed.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.action_hash !== actionHash) throw new PostgresStoreError("Idempotency key was reused with a different action");
      return {
        claimed: false,
        status: row.status as "executing" | "succeeded" | "failed",
        ...(row.result ? { result: row.result as Record<string, unknown> } : {}),
      };
    });
  }

  async completeExecutorAction(tenantId: string, idempotencyKey: string, input: {
    status: "succeeded" | "failed";
    result: Record<string, unknown>;
  }): Promise<void> {
    const key = z.string().min(1).max(255).parse(idempotencyKey);
    if (Buffer.byteLength(JSON.stringify(input.result)) > 32_000) throw new PostgresStoreError("executor result exceeds 32KB");
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE tracey.executor_receipts SET status=$3,result=$4::jsonb,updated_at=now()
          WHERE tenant_id=$1 AND idempotency_key=$2 AND status='executing'`,
        [tenantId, key, input.status, JSON.stringify(input.result)],
      );
    });
  }

  async indexDiagnosis(tenantId: string, input: DiagnosisSnapshotInput): Promise<string> {
    if (input.summary.length === 0 || input.summary.length > 20_000) {
      throw new PostgresStoreError("summary must contain 1 to 20,000 characters");
    }
    const snapshotId = randomUUID();
    const embedding = vectorLiteral(input.embedding);
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tracey.diagnosis_snapshots (
           tenant_id, snapshot_id, agent_id, trace_id, run_id, summary, diagnosis, evidence_refs, embedding
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::vector)`,
        [
          tenantId,
          snapshotId,
          input.agentId,
          input.traceId,
          input.runId,
          input.summary,
          JSON.stringify(input.diagnosis),
          JSON.stringify(input.evidenceRefs),
          embedding,
        ],
      );
      return snapshotId;
    });
  }

  async searchDiagnoses(tenantId: string, embeddingInput: number[], limit = 10): Promise<DiagnosisMatch[]> {
    const embedding = vectorLiteral(embeddingInput);
    const safeLimit = boundedInteger(limit, 1, 50, "limit");
    return this.withTenant(tenantId, async (client) => {
      await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
      const result = await client.query(
        `SELECT snapshot_id, agent_id, trace_id, run_id, summary, diagnosis, evidence_refs,
                embedding <=> $2::vector AS distance, created_at
           FROM tracey.diagnosis_snapshots
          WHERE tenant_id = $1 AND embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [tenantId, embedding, safeLimit],
      );
      return result.rows.map((row) => {
        const parsed = DiagnosisRowSchema.parse(row);
        return {
          snapshotId: parsed.snapshot_id,
          agentId: parsed.agent_id,
          traceId: parsed.trace_id,
          runId: parsed.run_id,
          summary: parsed.summary,
          diagnosis: parsed.diagnosis,
          evidenceRefs: parsed.evidence_refs,
          similarity: Math.max(-1, Math.min(1, 1 - parsed.distance)),
          createdAt: parsed.created_at.toISOString(),
        };
      });
    });
  }
}
