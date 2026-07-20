import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemediationPlanSchema } from "@tracey/autonomy";
import { actionApprovalFingerprint, type ActionProposal, type AutonomyPolicyRecord, type PostgresStore } from "@tracey/postgres-store";
import type { ApprovedActionExecutor } from "./action-executor.js";
import { AutonomyService } from "./autonomy-service.js";

function withCurrentApproval(proposal: ActionProposal): ActionProposal {
  return { ...proposal, approvalFingerprint: actionApprovalFingerprint(proposal) };
}

describe("autonomy execution lifecycle", () => {
  it("requires reconfirmation when approved proposal content changes", async () => {
    const plan = RemediationPlanSchema.parse({
      action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
      summary: "Restart sample workload", reason: "Observed readiness failure", confidence: 0.99,
      risk: "low", reversible: true, expectedImpact: "Restore readiness",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 }, evidenceRefs: [],
      verification: { serviceName: "sample-api", timeoutSeconds: 30, lookbackSeconds: 60, minimumSampleCount: 5, settleSeconds: 0, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
    });
    const approved = withCurrentApproval({ proposalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), actionType: "restart", target: "production/sample-workload", reason: plan.reason, parameters: {}, risk: "low", status: "approved", proposedBy: "operator-a", idempotencyKey: crypto.randomUUID(), createdAt: new Date().toISOString(), remediationPlan: plan });
    const changed = { ...approved, target: "production/different-workload" };
    let reconfirmationRequired = false;
    const store = {
      getActionProposal: async () => changed,
      requireActionReapproval: async () => { reconfirmationRequired = true; return { ...changed, status: "awaiting_approval" as const }; },
    } as unknown as PostgresStore;
    const executor = { captureSnapshot: async () => { throw new Error("must not execute"); } } as unknown as ApprovedActionExecutor;

    await assert.rejects(new AutonomyService("tenant-a", "production", store, executor).execute(changed, "operator-a"), /requires reconfirmation/);
    assert.equal(reconfirmationRequired, true);
  });

  it("uses persisted action history to enforce cooldown before automatic execution", async () => {
    const plan = RemediationPlanSchema.parse({
      action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
      summary: "Restart sample workload", reason: "Observed readiness failure", confidence: 0.99,
      risk: "low", reversible: true, expectedImpact: "Restore readiness",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 }, evidenceRefs: [],
      verification: { serviceName: "sample-api", timeoutSeconds: 30, lookbackSeconds: 60, minimumSampleCount: 5, settleSeconds: 0, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
      rollback: { action: { type: "rollback_deployment", namespace: "production", workload: "sample-workload" }, automatic: true },
    });
    const policy = {
      policyId: crypto.randomUUID(), scopeType: "global", scopeId: "default", version: 1, enabled: true,
      createdBy: "admin", updatedBy: "admin", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      policy: {
        mode: "guarded_autopilot", environments: ["production"], namespaces: ["production"], workloads: ["sample-workload"],
        allowedActions: ["restart_workload"], automaticActions: ["restart_workload"],
        prohibitedActions: ["read_secrets", "delete_namespace", "delete_database", "arbitrary_shell"],
        minimumConfidence: 0.9, maximumAutomaticRisk: "medium", maxReplicas: 10, maxAffectedWorkloads: 1,
        maxUnavailableReplicas: 1, maxConcurrentActions: 1, cooldownMinutes: 15,
      },
    } satisfies AutonomyPolicyRecord;
    const proposal: ActionProposal = {
      proposalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), actionType: "restart", target: "production/sample-workload",
      reason: plan.reason, parameters: {}, risk: "low", status: "proposed", proposedBy: "operator-a",
      idempotencyKey: crypto.randomUUID(), createdAt: new Date().toISOString(),
    };
    const store = {
      getLastActionAt: async () => new Date(), countActiveActions: async () => 0,
      createActionProposal: async () => proposal,
      attachPolicyEvaluation: async (_tenant: string, _id: string, input: { nextStatus: ActionProposal["status"]; decision: ActionProposal["policyDecision"] }) => ({
        ...proposal, status: input.nextStatus, remediationPlan: plan, policyDecision: input.decision,
      }),
      createNotification: async () => ({ notificationId: crypto.randomUUID() }),
    } as unknown as PostgresStore;
    const executor = { configured: () => true } as unknown as ApprovedActionExecutor;
    const result = await new AutonomyService("tenant-a", "production", store, executor).evaluatePlan({
      sessionId: proposal.sessionId, plan, policy, actor: "operator-a", actorRoles: ["operator"],
    });
    assert.equal(result.decision.decision, "require_approval");
    assert.match(result.decision.reasons.join(" "), /cooldown/);
    assert.equal(result.action.status, "awaiting_approval");
  });

  it("fails a proposal durably when pre-action evidence is unavailable", async () => {
    const base = withCurrentApproval({
      proposalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), actionType: "restart" as const,
      target: "production/sample-workload", reason: "test", parameters: {}, risk: "low" as const,
      status: "approved_for_auto_execution" as const, proposedBy: "operator-a", idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      remediationPlan: RemediationPlanSchema.parse({
        action: { type: "restart_workload", namespace: "production", workload: "sample-workload" }, summary: "Restart", reason: "Observed failure", confidence: 0.99, risk: "low", reversible: true,
        expectedImpact: "Recover", blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 }, evidenceRefs: [],
        verification: { serviceName: "sample-agent-api", timeoutSeconds: 30, lookbackSeconds: 60, minimumSampleCount: 5, settleSeconds: 0, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
      }),
    } satisfies ActionProposal);
    let status: ActionProposal["status"] = base.status;
    const store = {
      getActionProposal: async () => ({ ...base, status }),
      transitionAction: async (_tenant: string, _id: string, input: { next: ActionProposal["status"] }) => { status = input.next; return { ...base, status }; },
      createNotification: async () => ({ notificationId: crypto.randomUUID() }),
    } as unknown as PostgresStore;
    const executor = { captureSnapshot: async () => { throw new Error("SigNoz unavailable"); } } as unknown as ApprovedActionExecutor;
    await assert.rejects(new AutonomyService("tenant-a", "production", store, executor).execute(base, "policy-engine"), /SigNoz unavailable/);
    assert.equal(status, "failed");
  });

  it("automatically executes the configured recovery action after failed verification", async () => {
    const plan = RemediationPlanSchema.parse({
      action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
      summary: "Restart unhealthy sample workload",
      reason: "Readiness and trace evidence show an unhealthy rollout.",
      confidence: 0.98,
      risk: "low",
      reversible: true,
      expectedImpact: "Restore ready replicas",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 },
      evidenceRefs: [],
      verification: { serviceName: "sample-api", timeoutSeconds: 30, lookbackSeconds: 60, minimumSampleCount: 5, settleSeconds: 0, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
      rollback: { action: { type: "rollback_deployment", namespace: "production", workload: "sample-workload" }, automatic: true },
    });
    let proposal: ActionProposal = withCurrentApproval({
      proposalId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      actionType: "restart",
      target: "production/sample-workload",
      reason: plan.reason,
      parameters: {},
      risk: "low",
      status: "approved",
      proposedBy: "operator-a",
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      remediationPlan: plan,
    });
    const statuses: string[] = [];
    const store = {
      getActionProposal: async () => proposal,
      transitionAction: async (_tenant: string, _id: string, input: { next: ActionProposal["status"] }) => {
        statuses.push(input.next);
        proposal = { ...proposal, status: input.next };
        return proposal;
      },
      createNotification: async () => ({ notificationId: crypto.randomUUID() }),
    } as unknown as PostgresStore;
    const executed: string[] = [];
    const executor = {
      captureSnapshot: async () => ({ observability: { totalSpans: 10 } }),
      executeAction: async (action: { type: string }) => { executed.push(action.type); return { adapter: "webhook", result: { accepted: true } }; },
      verify: async () => ({ verified: false, reasons: ["error rate regression"] }),
      verifyRecovery: async () => ({ verified: true, workloadReady: true }),
    } as unknown as ApprovedActionExecutor;
    const result = await new AutonomyService("tenant-a", "production", store, executor).execute(proposal, "operator-a");
    assert.equal(result.status, "reverted");
    assert.deepEqual(executed, ["restart_workload", "rollback_deployment"]);
    assert.deepEqual(statuses, ["executing", "verifying", "reverting", "reverted"]);
  });

  it("records revert_failed when the rollback does not restore verified health", async () => {
    const plan = RemediationPlanSchema.parse({
      action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
      summary: "Restart unhealthy sample workload", reason: "Observed error regression", confidence: 0.99,
      risk: "low", reversible: true, expectedImpact: "Recover availability",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 }, evidenceRefs: [],
      verification: { serviceName: "sample-api", timeoutSeconds: 30, lookbackSeconds: 60, minimumSampleCount: 5, settleSeconds: 0, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
      rollback: { action: { type: "rollback_deployment", namespace: "production", workload: "sample-workload" }, automatic: true },
    });
    let proposal: ActionProposal = withCurrentApproval({
      proposalId: crypto.randomUUID(), sessionId: crypto.randomUUID(), actionType: "restart",
      target: "production/sample-workload", reason: plan.reason, parameters: {}, risk: "low", status: "approved",
      proposedBy: "operator-a", idempotencyKey: crypto.randomUUID(), createdAt: new Date().toISOString(), remediationPlan: plan,
    });
    const statuses: string[] = [];
    const store = {
      getActionProposal: async () => proposal,
      transitionAction: async (_tenant: string, _id: string, input: { next: ActionProposal["status"] }) => {
        statuses.push(input.next); proposal = { ...proposal, status: input.next }; return proposal;
      },
      createNotification: async () => ({ notificationId: crypto.randomUUID() }),
    } as unknown as PostgresStore;
    const executor = {
      captureSnapshot: async () => ({ observability: { totalSpans: 10 } }),
      executeAction: async () => ({ adapter: "webhook", result: { accepted: true } }),
      verify: async () => ({ verified: false, reasons: ["error rate regression"] }),
      verifyRecovery: async () => ({ verified: false, workloadReady: false, reasons: ["rollback unavailable"] }),
    } as unknown as ApprovedActionExecutor;
    const result = await new AutonomyService("tenant-a", "production", store, executor).execute(proposal, "operator-a");
    assert.equal(result.status, "revert_failed");
    assert.deepEqual(statuses, ["executing", "verifying", "reverting", "revert_failed"]);
  });
});
