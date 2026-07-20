import {
  RemediationPlanSchema,
  evaluatePolicy,
  type CloudAction,
  type PolicyDecision,
  type RemediationPlan,
} from "@tracey/autonomy";
import { actionApprovalIsCurrent, type ActionProposal, type AutonomyPolicyRecord, type PostgresStore } from "@tracey/postgres-store";
import { ApprovedActionExecutor } from "./action-executor.js";

function proposalType(action: CloudAction): ActionProposal["actionType"] {
  switch (action.type) {
    case "restart_pod":
    case "restart_workload": return "restart";
    case "rollback_deployment":
    case "restore_previous_config": return "rollback";
    case "scale_deployment":
    case "update_hpa": return "scale";
    case "update_resource_limits": return "resource_change";
    default: return "config_change";
  }
}

function actionParameters(action: CloudAction): Record<string, unknown> {
  return Object.fromEntries(Object.entries(action).filter(([key]) => key !== "type"));
}

function statusForDecision(decision: PolicyDecision["decision"]): "policy_evaluated" | "awaiting_approval" | "approved_for_auto_execution" | "rejected" {
  switch (decision) {
    case "auto_execute": return "approved_for_auto_execution";
    case "require_approval": return "awaiting_approval";
    case "recommend": return "policy_evaluated";
    case "deny": return "rejected";
  }
}

export class AutonomyService {
  constructor(
    private readonly tenantId: string,
    private readonly environment: string,
    private readonly store: PostgresStore,
    private readonly executor: ApprovedActionExecutor,
  ) {}

  async evaluatePlan(input: {
    sessionId: string;
    plan: RemediationPlan;
    policy: AutonomyPolicyRecord;
    actor: string;
    actorRoles: string[];
    modelIdentity?: string;
  }): Promise<{ action: ActionProposal; decision: PolicyDecision }> {
    const plan = RemediationPlanSchema.parse(input.plan);
    const target = `${plan.action.namespace}/${plan.action.workload}`;
    const lastActionAt = await this.store.getLastActionAt(this.tenantId, target);
    let decision = evaluatePolicy({
      policy: input.policy.policy,
      plan,
      environment: this.environment,
      actorRoles: input.actorRoles,
      activeActionCount: await this.store.countActiveActions(this.tenantId),
      ...(lastActionAt ? { lastActionAt } : {}),
    });
    if (decision.decision === "auto_execute" && !this.executor.configured()) {
      decision = {
        decision: "deny",
        reasons: ["no restricted executor is configured; automatic execution fails closed"],
        evaluatedAt: new Date().toISOString(),
      };
    }
    const proposal = await this.store.createActionProposal(this.tenantId, {
      sessionId: input.sessionId,
      actionType: proposalType(plan.action),
      target,
      reason: plan.reason,
      parameters: actionParameters(plan.action),
      risk: plan.risk === "critical" ? "high" : plan.risk,
      proposedBy: input.actor,
    });
    const action = await this.store.attachPolicyEvaluation(this.tenantId, proposal.proposalId, {
      policyId: input.policy.policyId,
      plan,
      decision,
      nextStatus: statusForDecision(decision.decision),
      actor: input.actor,
      requesterIdentity: input.actor,
      ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
    });
    if (!action) throw new Error("Action proposal changed during policy evaluation");
    await this.notify(action, `Policy decision: ${decision.decision}`, decision.reasons.join("; "), decision.decision === "deny" ? "warning" : "info");
    if (decision.decision === "auto_execute") return { action: await this.execute(action, "policy-engine"), decision };
    return { action, decision };
  }

  async execute(proposalInput: ActionProposal, actor: string): Promise<ActionProposal> {
    const proposal = await this.store.getActionProposal(this.tenantId, proposalInput.proposalId);
    if (!proposal?.remediationPlan) throw new Error("Action has no validated remediation plan");
    if (!["approved", "approved_for_auto_execution"].includes(proposal.status)) throw new Error("Action is not approved for execution");
    if (!actionApprovalIsCurrent(proposal)) {
      await this.store.requireActionReapproval(this.tenantId, proposal.proposalId, actor);
      throw new Error("Action proposal changed after approval and requires reconfirmation");
    }
    const action = proposal.remediationPlan.action;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = await this.executor.captureSnapshot(action, proposal.remediationPlan);
    } catch (error) {
      const failed = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["approved", "approved_for_auto_execution"], next: "failed", actor,
        details: { phase: "preflight", errorType: error instanceof Error ? error.name : "UnknownError" },
      });
      if (failed) await this.notify(failed, "Remediation preflight failed", error instanceof Error ? error.message : "Pre-action evidence could not be captured", "critical");
      throw error;
    }
    const executing = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
      expected: ["approved", "approved_for_auto_execution"], next: "executing", actor,
      resultField: "pre_action_snapshot", result: snapshot,
    });
    if (!executing) throw new Error("Action execution was already claimed");
    await this.notify(executing, "Remediation executing", proposal.remediationPlan.summary, "warning");
    try {
      const execution = await this.executor.executeAction(action, {
        proposalId: proposal.proposalId,
        idempotencyKey: proposal.idempotencyKey,
      });
      const verifying = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["executing"], next: "verifying", actor,
        resultField: "execution_result", result: execution.result,
      });
      if (!verifying) throw new Error("Action could not enter verification");
      const verification = await this.executor.verify(action, proposal.remediationPlan, snapshot);
      if (verification.verified === true) {
        const succeeded = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
          expected: ["verifying"], next: "succeeded", actor,
          resultField: "verification_result", result: verification,
        });
        if (!succeeded) throw new Error("Verified action could not be completed");
        await this.notify(succeeded, "Remediation succeeded", proposal.remediationPlan.summary, "info");
        return succeeded;
      }
      return this.recover(proposal, verification, snapshot, actor);
    } catch (error) {
      const failed = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["executing", "verifying"], next: "failed", actor,
        details: { errorType: error instanceof Error ? error.name : "UnknownError" },
      });
      if (failed) await this.notify(failed, "Remediation failed", error instanceof Error ? error.message : "Execution failed", "critical");
      throw error;
    }
  }

  private async recover(
    proposal: ActionProposal,
    verification: Record<string, unknown>,
    preSnapshot: Record<string, unknown>,
    actor: string,
  ): Promise<ActionProposal> {
    const rollback = proposal.remediationPlan?.rollback;
    if (!rollback?.automatic) {
      const failed = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["verifying"], next: "failed", actor,
        resultField: "verification_result", result: verification,
      });
      if (!failed) throw new Error("Failed action could not be persisted");
      await this.notify(failed, "Verification failed", "The action did not pass verification and requires operator recovery.", "critical");
      return failed;
    }
    const reverting = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
      expected: ["verifying"], next: "reverting", actor,
      resultField: "verification_result", result: verification,
    });
    if (!reverting) throw new Error("Action could not enter recovery");
    try {
      const recoveryStartedAt = Date.now();
      const rollbackResult = await this.executor.executeAction(rollback.action, {
        proposalId: proposal.proposalId,
        idempotencyKey: `${proposal.idempotencyKey}:rollback`,
      });
      const recoveryVerification = await this.executor.verifyRecovery(
        rollback.action,
        proposal.remediationPlan!,
        preSnapshot,
        recoveryStartedAt,
      );
      const persistedRollback = { execution: rollbackResult.result, verification: recoveryVerification };
      if (recoveryVerification.verified !== true) {
        const failed = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
          expected: ["reverting"], next: "revert_failed", actor,
          resultField: "rollback_result", result: persistedRollback,
        });
        if (!failed) throw new Error("Failed recovery verification could not be persisted");
        await this.notify(failed, "Recovery verification failed", "The rollback executed but did not restore verified Kubernetes and SigNoz health.", "critical");
        return failed;
      }
      const reverted = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["reverting"], next: "reverted", actor,
        resultField: "rollback_result", result: persistedRollback,
      });
      if (!reverted) throw new Error("Rollback completion could not be persisted");
      await this.notify(reverted, "Remediation reverted", "Verification failed, so Tracey executed the configured recovery action.", "critical");
      return reverted;
    } catch (error) {
      const failed = await this.store.transitionAction(this.tenantId, proposal.proposalId, {
        expected: ["reverting"], next: "revert_failed", actor,
        details: { errorType: error instanceof Error ? error.name : "UnknownError" },
      });
      if (failed) await this.notify(failed, "Recovery failed", "Automatic recovery did not complete successfully.", "critical");
      throw error;
    }
  }

  private async notify(proposal: ActionProposal, title: string, summary: string, severity: "info" | "warning" | "critical"): Promise<void> {
    await this.store.createNotification(this.tenantId, {
      sessionId: proposal.sessionId,
      title,
      summary: summary.slice(0, 4_000),
      severity,
      correlationType: "system",
      correlationId: proposal.proposalId,
      environment: this.environment,
    });
  }
}
