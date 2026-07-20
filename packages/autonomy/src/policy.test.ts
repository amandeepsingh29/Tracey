import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutonomyPolicySchema, RemediationPlanSchema, evaluatePolicy } from "./policy.js";

const plan = RemediationPlanSchema.parse({
  action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
  summary: "Restart an unhealthy workload",
  reason: "Every replica is failing readiness after a transient runtime failure.",
  confidence: 0.96,
  risk: "low",
  reversible: true,
  expectedImpact: "A rolling restart should restore ready replicas.",
  blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 },
  evidenceRefs: [],
  verification: { serviceName: "sample-api", timeoutSeconds: 300, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
  rollback: { action: { type: "restore_previous_config", namespace: "production", workload: "sample-workload" }, automatic: true },
});

function policy(mode: "observe" | "recommend" | "approval" | "guarded_autopilot" | "full_autopilot") {
  return AutonomyPolicySchema.parse({
    mode,
    environments: ["production"], namespaces: ["production"], workloads: ["sample-workload"],
    allowedActions: ["restart_workload"], automaticActions: ["restart_workload"],
    minimumConfidence: 0.9, maximumAutomaticRisk: "medium", maxConcurrentActions: 1, cooldownMinutes: 0,
  });
}

const input = { plan, environment: "production", actorRoles: ["operator"], activeActionCount: 0, now: new Date("2026-07-18T12:00:00Z") };

describe("autonomy policy engine", () => {
  it("enforces every autonomy mode", () => {
    assert.equal(evaluatePolicy({ ...input, policy: policy("observe") }).decision, "deny");
    assert.equal(evaluatePolicy({ ...input, policy: policy("recommend") }).decision, "recommend");
    assert.equal(evaluatePolicy({ ...input, policy: policy("approval") }).decision, "require_approval");
    assert.equal(evaluatePolicy({ ...input, policy: policy("guarded_autopilot") }).decision, "auto_execute");
    assert.equal(evaluatePolicy({ ...input, policy: policy("full_autopilot") }).decision, "auto_execute");
  });

  it("fails closed outside the explicit namespace and workload scope", () => {
    const decision = evaluatePolicy({ ...input, policy: { ...policy("full_autopilot"), namespaces: ["staging"] } });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reasons.join(" "), /namespace/);
  });

  it("supports explicit cluster-wide namespace and workload policy scopes", () => {
    const configured = AutonomyPolicySchema.parse({ ...policy("full_autopilot"), namespaces: ["*"], workloads: ["*"] });
    assert.equal(evaluatePolicy({ ...input, policy: configured }).decision, "auto_execute");
  });

  it("requires approval when guarded autopilot confidence is insufficient", () => {
    const decision = evaluatePolicy({ ...input, policy: policy("guarded_autopilot"), plan: { ...plan, confidence: 0.4 } });
    assert.equal(decision.decision, "require_approval");
    assert.match(decision.reasons.join(" "), /confidence/);
  });

  it("allows approval-mode plans to queue while another action is active", () => {
    const decision = evaluatePolicy({ ...input, policy: policy("approval"), activeActionCount: 10 });
    assert.equal(decision.decision, "require_approval");
  });

  it("blocks excessive scaling and unprivileged actors", () => {
    const scaling = RemediationPlanSchema.parse({ ...plan, action: { type: "scale_deployment", namespace: "production", workload: "sample-workload", replicas: 21 } });
    const configured = AutonomyPolicySchema.parse({ ...policy("full_autopilot"), allowedActions: ["scale_deployment"], automaticActions: ["scale_deployment"], maxReplicas: 10 });
    const decision = evaluatePolicy({ ...input, plan: scaling, policy: configured, actorRoles: ["viewer"] });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reasons.join(" "), /replica target/);
    assert.match(decision.reasons.join(" "), /analyst, operator, or admin/);
  });

  it("rejects shell injection through Kubernetes names", () => {
    assert.throws(() => RemediationPlanSchema.parse({ ...plan, action: { type: "restart_workload", namespace: "production; rm -rf /", workload: "sample-workload" } }));
  });

  it("allows only typed non-secret rollout configuration patches", () => {
    assert.doesNotThrow(() => RemediationPlanSchema.parse({ ...plan, action: {
      type: "apply_config_patch", namespace: "production", workload: "sample-workload",
      patch: { maxUnavailable: "25%", progressDeadlineSeconds: 600 },
    } }));
    assert.throws(() => RemediationPlanSchema.parse({ ...plan, action: {
      type: "apply_config_patch", namespace: "production", workload: "sample-workload",
      patch: { env: "SECRET=value" },
    } }));
  });

  it("denies actions whose declared blast radius exceeds policy limits", () => {
    const decision = evaluatePolicy({ ...input, policy: policy("full_autopilot"), plan: {
      ...plan, blastRadius: { workloads: 2, estimatedUnavailableReplicas: 3 },
    } });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reasons.join(" "), /blast radius/);
    assert.match(decision.reasons.join(" "), /unavailable replicas/);
  });

  it("requires approval when concurrency, cooldown, or maintenance controls are active", () => {
    const configured = AutonomyPolicySchema.parse({
      ...policy("guarded_autopilot"), cooldownMinutes: 15, maxConcurrentActions: 1,
      maintenanceWindow: { startHourUtc: 13, endHourUtc: 14 },
    });
    const decision = evaluatePolicy({
      ...input,
      policy: configured,
      activeActionCount: 1,
      lastActionAt: new Date("2026-07-18T11:55:00Z"),
    });
    assert.equal(decision.decision, "require_approval");
    assert.match(decision.reasons.join(" "), /concurrent action limit/);
    assert.match(decision.reasons.join(" "), /cooldown/);
    assert.match(decision.reasons.join(" "), /maintenance window/);
  });

  it("supports maintenance windows that cross midnight", () => {
    const configured = AutonomyPolicySchema.parse({
      ...policy("guarded_autopilot"), maintenanceWindow: { startHourUtc: 22, endHourUtc: 2 },
    });
    const decision = evaluatePolicy({ ...input, policy: configured, now: new Date("2026-07-18T23:00:00Z") });
    assert.equal(decision.decision, "auto_execute");
  });

  it("always requires explicit confirmation for generic Kubernetes mutations", () => {
    const generic = RemediationPlanSchema.parse({
      ...plan,
      action: {
        type: "patch_kubernetes_resource",
        namespace: "production",
        workload: "sample-workload",
        apiVersion: "apps/v1",
        kind: "Deployment",
        patch: { spec: { replicas: 3 } },
      },
    });
    const configured = AutonomyPolicySchema.parse({
      ...policy("full_autopilot"),
      allowedActions: ["patch_kubernetes_resource"],
      automaticActions: ["patch_kubernetes_resource"],
    });
    const decision = evaluatePolicy({ ...input, policy: configured, plan: generic });
    assert.equal(decision.decision, "require_approval");
    assert.match(decision.reasons.join(" "), /explicit administrator confirmation/);
  });
});
