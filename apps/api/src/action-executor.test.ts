import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemediationPlanSchema } from "@tracey/autonomy";
import type { ServiceHealthSnapshot } from "@tracey/signoz-adapter";
import { ApprovedActionExecutor, compareServiceHealth } from "./action-executor.js";

function snapshot(overrides: Partial<ServiceHealthSnapshot> = {}): ServiceHealthSnapshot {
  return {
    serviceName: "sample-api",
    window: { start: 1, end: 2 },
    totalSpans: 100,
    errorSpans: 1,
    errorRate: 0.01,
    p95LatencyMs: 100,
    rejectedRows: 0,
    truncated: false,
    query: {},
    ...overrides,
  };
}

describe("SigNoz action verification", () => {
  const limits = { minimumSampleCount: 5, maxErrorRateIncrease: 0.01, maxLatencyIncreasePercent: 10 };

  it("accepts a healthy post-action window", () => {
    const result = compareServiceHealth(snapshot(), snapshot({ errorRate: 0.01, p95LatencyMs: 105 }), limits);
    assert.equal(result.verified, true);
    assert.deepEqual(result.reasons, []);
  });

  it("fails closed on regressions, truncation, or insufficient samples", () => {
    const result = compareServiceHealth(snapshot(), snapshot({ totalSpans: 2, errorRate: 0.1, p95LatencyMs: 140, truncated: true }), limits);
    assert.equal(result.verified, false);
    assert.ok(result.reasons.some((reason) => reason.includes("truncated")));
    assert.ok(result.reasons.some((reason) => reason.includes("sample count")));
    assert.ok(result.reasons.some((reason) => reason.includes("error rate")));
    assert.ok(result.reasons.some((reason) => reason.includes("p95 latency")));
  });

  it("polls until post-action spans arrive within the verification timeout", async () => {
    let queryCount = 0;
    const executor = new ApprovedActionExecutor({
      observability: {
        getServiceHealthSnapshot: async () => {
          queryCount += 1;
          return queryCount === 1
            ? snapshot({ window: { start: 2, end: 3 }, totalSpans: 0, errorSpans: 0, errorRate: 0, p95LatencyMs: 0 })
            : snapshot({ window: { start: 2, end: 4 }, totalSpans: 10, errorSpans: 0, errorRate: 0, p95LatencyMs: 100 });
        },
      },
      verificationPollIntervalMs: 0,
    });
    (executor as unknown as { investigator: {
      getDeploymentRolloutStatus: () => Promise<Record<string, unknown>>;
    } }).investigator = {
      getDeploymentRolloutStatus: async () => ({ ready: true, readyReplicas: 2 }),
    };
    const plan = RemediationPlanSchema.parse({
      action: { type: "restart_workload", namespace: "production", workload: "sample-api" },
      summary: "Restart sample API",
      reason: "Recover the unhealthy workload",
      confidence: 0.95,
      risk: "medium",
      reversible: true,
      expectedImpact: "One replica may be unavailable during rollout",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 },
      evidenceRefs: [],
      verification: {
        serviceName: "sample-api",
        timeoutSeconds: 10,
        lookbackSeconds: 300,
        minimumSampleCount: 5,
        settleSeconds: 0,
        requireWorkloadReady: true,
        maxErrorRateIncrease: 0.01,
        maxLatencyIncreasePercent: 10,
      },
    });

    const result = await executor.verify(plan.action, plan, { observability: snapshot() });

    assert.equal(result.verified, true);
    assert.equal(queryCount, 2);
  });
});
