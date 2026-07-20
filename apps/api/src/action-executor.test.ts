import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServiceHealthSnapshot } from "@tracey/signoz-adapter";
import { compareServiceHealth } from "./action-executor.js";

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
});
