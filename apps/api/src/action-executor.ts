import { CloudActionSchema, type CloudAction, type RemediationPlan } from "@tracey/autonomy";
import { KubernetesAdapter } from "@tracey/cloud-adapter";
import type { ActionProposal } from "@tracey/postgres-store";
import type { ServiceHealthSnapshot, SigNozAdapter } from "@tracey/signoz-adapter";

export interface ActionExecutionResult {
  adapter: "kubernetes" | "webhook";
  result: Record<string, unknown>;
}

export function compareServiceHealth(
  baseline: ServiceHealthSnapshot,
  current: ServiceHealthSnapshot,
  limits: { minimumSampleCount: number; maxErrorRateIncrease: number; maxLatencyIncreasePercent: number },
): { verified: boolean; errorRateIncrease: number; latencyIncreasePercent: number; reasons: string[] } {
  const reasons = [
    ...(baseline.truncated ? ["pre-action SigNoz query was truncated"] : []),
    ...(current.truncated ? ["post-action SigNoz query was truncated"] : []),
    ...(baseline.totalSpans < limits.minimumSampleCount ? [`pre-action SigNoz sample count ${baseline.totalSpans} is below ${limits.minimumSampleCount}`] : []),
    ...(current.totalSpans < limits.minimumSampleCount ? [`post-action SigNoz sample count ${current.totalSpans} is below ${limits.minimumSampleCount}`] : []),
    ...(baseline.rejectedRows > 0 ? [`pre-action SigNoz returned ${baseline.rejectedRows} invalid rows`] : []),
    ...(current.rejectedRows > 0 ? [`post-action SigNoz returned ${current.rejectedRows} invalid rows`] : []),
  ];
  const errorRateIncrease = current.errorRate - baseline.errorRate;
  const latencyIncreasePercent = baseline.p95LatencyMs === 0
    ? (current.p95LatencyMs === 0 ? 0 : Number.MAX_SAFE_INTEGER)
    : ((current.p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs) * 100;
  if (errorRateIncrease > limits.maxErrorRateIncrease) reasons.push(`error rate increased by ${errorRateIncrease.toFixed(4)}`);
  if (latencyIncreasePercent > limits.maxLatencyIncreasePercent) reasons.push(`p95 latency increased by ${latencyIncreasePercent.toFixed(2)}%`);
  return { verified: reasons.length === 0, errorRateIncrease, latencyIncreasePercent, reasons };
}

export class ApprovedActionExecutor {
  private readonly kubernetes?: KubernetesAdapter;
  private readonly investigator?: KubernetesAdapter;

  constructor(private readonly config: {
    webhookUrl?: string;
    token?: string;
    executorUrl?: string;
    executorToken?: string;
    timeoutMs?: number;
    kubernetesEnabled?: boolean;
    investigatorEnabled?: boolean;
    allowedNamespaces?: string[];
    allowedWorkloads?: string[];
    observability?: Pick<SigNozAdapter, "getServiceHealthSnapshot">;
    verificationPollIntervalMs?: number;
  }) {
    if (config.kubernetesEnabled) {
      this.kubernetes = new KubernetesAdapter({
        allowedNamespaces: config.allowedNamespaces ?? [],
        allowedWorkloads: config.allowedWorkloads ?? [],
      });
      this.investigator = this.kubernetes;
    } else if (config.investigatorEnabled) {
      this.investigator = new KubernetesAdapter({
        allowedNamespaces: config.allowedNamespaces ?? [],
        allowedWorkloads: config.allowedWorkloads ?? [],
      });
    }
  }

  configured(): boolean {
    return Boolean(this.kubernetes || this.config.executorUrl || this.config.webhookUrl);
  }

  async checkReadiness(): Promise<void> {
    const namespace = this.config.allowedNamespaces?.[0];
    if (this.investigator || this.kubernetes) {
      if (!namespace) throw new Error("Kubernetes connector scope is empty");
      await (this.investigator ?? this.kubernetes)!.checkAccess(namespace);
    }
    if (this.config.executorUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs ?? 5_000, 5_000));
      try {
        const response = await fetch(`${this.config.executorUrl.replace(/\/$/, "")}/ready`, {
          signal: controller.signal,
          headers: this.config.executorToken ? { authorization: `Bearer ${this.config.executorToken}` } : {},
        });
        if (!response.ok) throw new Error(`Restricted executor readiness returned HTTP ${response.status}`);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async execute(proposal: ActionProposal): Promise<ActionExecutionResult> {
    if (proposal.status !== "approved" && proposal.status !== "approved_for_auto_execution") {
      throw new Error("Action must be approved by policy or an administrator before execution");
    }

    const action = this.toCloudAction(proposal);
    if (action && this.kubernetes) {
      return { adapter: "kubernetes", result: await this.kubernetes.execute(action) };
    }

    if (!this.config.webhookUrl) {
      throw new Error(`No restricted executor is configured for action ${proposal.actionType}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": proposal.idempotencyKey,
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        },
        body: JSON.stringify({
          proposalId: proposal.proposalId,
          actionType: proposal.actionType,
          target: proposal.target,
          reason: proposal.reason,
          parameters: proposal.parameters,
          risk: proposal.risk,
          approvedBy: proposal.approvedBy,
        }),
      });
      if (!response.ok) throw new Error(`Approved action webhook returned HTTP ${response.status}`);
      return { adapter: "webhook", result: { accepted: true, status: response.status } };
    } finally {
      clearTimeout(timeout);
    }
  }

  actionForProposal(proposal: ActionProposal): CloudAction | undefined {
    return this.toCloudAction(proposal);
  }

  async executeAction(actionInput: CloudAction, context: { proposalId: string; idempotencyKey: string }): Promise<ActionExecutionResult> {
    const action = CloudActionSchema.parse(actionInput);
    if (this.kubernetes) return { adapter: "kubernetes", result: await this.kubernetes.execute(action) };
    if (!this.config.executorUrl) throw new Error("The restricted Kubernetes executor is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const response = await fetch(`${this.config.executorUrl.replace(/\/$/, "")}/v1/actions/execute`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": context.idempotencyKey,
          ...(this.config.executorToken ? { authorization: `Bearer ${this.config.executorToken}` } : {}),
        },
        body: JSON.stringify({ proposalId: context.proposalId, action }),
      });
      if (!response.ok) throw new Error(`Restricted executor returned HTTP ${response.status}`);
      const payload = await response.json() as { result?: Record<string, unknown> };
      return { adapter: "webhook", result: payload.result ?? { accepted: true } };
    } finally {
      clearTimeout(timeout);
    }
  }

  async captureSnapshot(actionInput: CloudAction, plan: RemediationPlan): Promise<Record<string, unknown>> {
    const action = CloudActionSchema.parse(actionInput);
    if (["apply_kubernetes_resource", "patch_kubernetes_resource", "delete_kubernetes_resource"].includes(action.type)) {
      if (!this.investigator) throw new Error("Kubernetes investigator is not configured; execution fails closed");
      const generic = action as Extract<CloudAction, { type: "apply_kubernetes_resource" | "patch_kubernetes_resource" | "delete_kubernetes_resource" }>;
      return { kubernetes: { resource: await this.investigator.getResourceIdentity(generic) } };
    }
    if (action.type === "restart_pod") {
      if (!this.investigator) throw new Error("Kubernetes investigator is not configured; execution fails closed");
      const pods = await this.investigator.listPods(action.namespace);
      const prefix = `${action.workload.slice(0, action.workload.lastIndexOf("-") + 1)}`;
      const matching = pods.filter(({ name }) => name.startsWith(prefix));
      return {
        kubernetes: {
          pod: await this.investigator.getPodStatus(action.namespace, action.workload),
          podPrefix: prefix,
          readyCount: matching.filter(({ phase, containers }) => phase === "Running" && containers.every(({ ready }) => ready)).length,
        },
      };
    }
    if (!this.config.observability) throw new Error("SigNoz verification is not configured; execution fails closed");
    const end = Date.now();
    const observability = await this.config.observability.getServiceHealthSnapshot({
      serviceName: plan.verification.serviceName,
      start: end - plan.verification.lookbackSeconds * 1_000,
      end,
    });
    this.assertUsableObservability(observability, plan.verification.minimumSampleCount, "pre-action");
    if (!this.investigator) throw new Error("Kubernetes investigator is not configured; execution fails closed");
    let kubernetes: Record<string, unknown> = { adapter: "kubernetes", snapshotAvailable: true };
    if (["restart_workload", "rollback_deployment", "scale_deployment", "update_resource_limits", "restore_previous_config"].includes(action.type)) {
      kubernetes = {
        deployment: await this.investigator.getDeploymentConfig(action.namespace, action.workload),
        rollout: await this.investigator.getDeploymentRolloutStatus(action.namespace, action.workload),
        revisions: await this.investigator.getReplicaSetHistory(action.namespace, action.workload),
      };
    }
    return { kubernetes, observability };
  }

  async verify(actionInput: CloudAction, plan: RemediationPlan, preSnapshot: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = CloudActionSchema.parse(actionInput);
    if (!this.investigator) return { verified: false, reason: "Kubernetes investigator is not configured for verification" };
    if (["apply_kubernetes_resource", "patch_kubernetes_resource", "delete_kubernetes_resource"].includes(action.type)) {
      const generic = action as Extract<CloudAction, { type: "apply_kubernetes_resource" | "patch_kubernetes_resource" | "delete_kubernetes_resource" }>;
      const before = (preSnapshot.kubernetes as { resource?: Record<string, unknown> } | undefined)?.resource;
      const deadline = Date.now() + plan.verification.timeoutSeconds * 1_000;
      let current = await this.investigator.getResourceIdentity(generic);
      while (Date.now() < deadline) {
        if (action.type === "delete_kubernetes_resource" && !current) {
          return { verified: true, resourceAbsent: true, previousResource: before };
        }
        if (action.type !== "delete_kubernetes_resource" && current && (!before || current.resourceVersion !== before.resourceVersion)) {
          return { verified: true, resourcePresent: true, previousResource: before, currentResource: current };
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        current = await this.investigator.getResourceIdentity(generic);
      }
      return { verified: false, reason: "Kubernetes resource state did not converge before timeout", previousResource: before, currentResource: current };
    }
    if (action.type === "restart_pod") {
      const before = preSnapshot.kubernetes as { podPrefix?: string; readyCount?: number } | undefined;
      const prefix = before?.podPrefix ?? `${action.workload.slice(0, action.workload.lastIndexOf("-") + 1)}`;
      const expectedReady = before?.readyCount ?? 1;
      const deadline = Date.now() + plan.verification.timeoutSeconds * 1_000;
      let pods = await this.investigator.listPods(action.namespace);
      while (Date.now() < deadline) {
        const oldPodGone = !pods.some(({ name }) => name === action.workload);
        const readyCount = pods.filter(({ name, phase, containers }) => name.startsWith(prefix) && phase === "Running" && containers.every(({ ready }) => ready)).length;
        if (oldPodGone && readyCount >= expectedReady) return { verified: true, oldPodGone, readyCount, expectedReady };
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        pods = await this.investigator.listPods(action.namespace);
      }
      return { verified: false, reason: "replacement pod did not restore the previous ready replica count before timeout" };
    }
    if (!this.config.observability) return { verified: false, reason: "SigNoz verifier is not configured" };
    const deadline = Date.now() + plan.verification.timeoutSeconds * 1_000;
    let workloadReady = true;
    let rollout: Record<string, unknown> | undefined;
    if (["restart_workload", "rollback_deployment", "scale_deployment", "update_resource_limits", "restore_previous_config"].includes(action.type)) {
      rollout = await this.investigator.getDeploymentRolloutStatus(action.namespace, action.workload);
      while (plan.verification.requireWorkloadReady && rollout.ready !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        rollout = await this.investigator.getDeploymentRolloutStatus(action.namespace, action.workload);
      }
      workloadReady = plan.verification.requireWorkloadReady ? rollout.ready === true : true;
    }
    const settleMs = Math.min(plan.verification.settleSeconds * 1_000, Math.max(0, deadline - Date.now()));
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const baseline = preSnapshot.observability as ServiceHealthSnapshot | undefined;
    if (!baseline) return { verified: false, workloadReady, rollout, reason: "Pre-action SigNoz snapshot is missing" };
    const end = Date.now();
    const start = Math.min(baseline.window.end, end - 1);
    const { current, comparison } = await this.pollPostActionHealth(plan, baseline, start, deadline);
    return {
      verified: workloadReady && comparison.verified,
      workloadReady,
      rollout,
      observability: { baseline, current, errorRateIncrease: comparison.errorRateIncrease, latencyIncreasePercent: comparison.latencyIncreasePercent },
      reasons: [...(!workloadReady ? ["workload did not become ready"] : []), ...comparison.reasons],
    };
  }

  async verifyRecovery(
    actionInput: CloudAction,
    plan: RemediationPlan,
    preSnapshot: Record<string, unknown>,
    recoveryStartedAt: number,
  ): Promise<Record<string, unknown>> {
    const action = CloudActionSchema.parse(actionInput);
    if (!this.investigator) return { verified: false, reason: "Kubernetes investigator is not configured for recovery verification" };
    if (!this.config.observability) return { verified: false, reason: "SigNoz verifier is not configured for recovery verification" };
    const deadline = Date.now() + plan.verification.timeoutSeconds * 1_000;
    let workloadReady = true;
    let rollout: Record<string, unknown> | undefined;
    if (["restart_workload", "rollback_deployment", "scale_deployment", "update_resource_limits", "restore_previous_config"].includes(action.type)) {
      rollout = await this.investigator.getDeploymentRolloutStatus(action.namespace, action.workload);
      while (plan.verification.requireWorkloadReady && rollout.ready !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        rollout = await this.investigator.getDeploymentRolloutStatus(action.namespace, action.workload);
      }
      workloadReady = plan.verification.requireWorkloadReady ? rollout.ready === true : true;
    }
    const settleMs = Math.min(plan.verification.settleSeconds * 1_000, Math.max(0, deadline - Date.now()));
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const baseline = preSnapshot.observability as ServiceHealthSnapshot | undefined;
    if (!baseline) return { verified: false, workloadReady, rollout, reason: "Pre-action SigNoz snapshot is missing during recovery" };
    const { current, comparison } = await this.pollPostActionHealth(
      plan,
      baseline,
      Math.min(recoveryStartedAt, Date.now() - 1),
      deadline,
    );
    return {
      verified: workloadReady && comparison.verified,
      workloadReady,
      rollout,
      observability: { baseline, current, errorRateIncrease: comparison.errorRateIncrease, latencyIncreasePercent: comparison.latencyIncreasePercent },
      reasons: [...(!workloadReady ? ["workload did not become ready after recovery"] : []), ...comparison.reasons],
    };
  }

  private assertUsableObservability(snapshot: ServiceHealthSnapshot, minimum: number, phase: string): void {
    const problems = this.observabilityProblems(snapshot, minimum, phase);
    if (problems.length > 0) throw new Error(problems.join("; "));
  }

  private async pollPostActionHealth(
    plan: RemediationPlan,
    baseline: ServiceHealthSnapshot,
    start: number,
    deadline: number,
  ): Promise<{
    current: ServiceHealthSnapshot;
    comparison: ReturnType<typeof compareServiceHealth>;
  }> {
    if (!this.config.observability) throw new Error("SigNoz verification is not configured");
    const pollIntervalMs = Math.max(0, this.config.verificationPollIntervalMs ?? 5_000);
    let lastError: unknown;
    while (true) {
      const end = Date.now();
      try {
        const current = await this.config.observability.getServiceHealthSnapshot({
          serviceName: plan.verification.serviceName,
          start: Math.min(start, end - 1),
          end,
        });
        const comparison = compareServiceHealth(baseline, current, plan.verification);
        const waitingForSamples = current.totalSpans < plan.verification.minimumSampleCount;
        if (!waitingForSamples || Date.now() >= deadline) return { current, comparison };
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        if (lastError) throw lastError;
        throw new Error("SigNoz verification timed out before enough post-action samples arrived");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }
  }

  private observabilityProblems(snapshot: ServiceHealthSnapshot, minimum: number, phase: string): string[] {
    return [
      ...(snapshot.truncated ? [`${phase} SigNoz query was truncated`] : []),
      ...(snapshot.totalSpans < minimum ? [`${phase} SigNoz sample count ${snapshot.totalSpans} is below ${minimum}`] : []),
      ...(snapshot.rejectedRows > 0 ? [`${phase} SigNoz returned ${snapshot.rejectedRows} invalid rows`] : []),
    ];
  }

  private toCloudAction(proposal: ActionProposal): CloudAction | undefined {
    if (proposal.actionType === "restart") {
      return CloudActionSchema.parse({ type: "restart_workload", ...proposal.parameters });
    }
    if (proposal.actionType === "rollback") {
      return CloudActionSchema.parse({ type: "rollback_deployment", ...proposal.parameters });
    }
    if (proposal.actionType === "scale") {
      return CloudActionSchema.parse({ type: "scale_deployment", ...proposal.parameters });
    }
    if (proposal.actionType === "resource_change") {
      return CloudActionSchema.parse({ type: "update_resource_limits", ...proposal.parameters });
    }
    return undefined;
  }
}
