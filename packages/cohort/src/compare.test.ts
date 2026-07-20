import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CohortSpanSet, TraceSpan } from "@tracey/domain";
import { compareCohorts } from "./compare.js";

function span(index: number, version: string, durationMs: number, error = false): TraceSpan {
  return {
    traceId: index.toString(16).padStart(32, "0"),
    spanId: index.toString(16).padStart(16, "0"),
    parentSpanId: null,
    name: "gen_ai.chat",
    serviceName: "tracey-api",
    startedAt: new Date(index * 1_000).toISOString(),
    startTimeMs: index * 1_000,
    durationMs,
    hasError: error,
    attributes: {
      "tracey.prompt.version": version,
      "gen_ai.usage.input_tokens": 100 + index,
      "gen_ai.usage.output_tokens": 20 + index,
      "tracey.cost.attribution": "exact",
      "tracey.cost.usd": index / 1_000,
    },
  };
}

function set(value: string, spans: TraceSpan[], truncated = false): CohortSpanSet {
  return { value, spans, rejectedRows: 0, truncated, query: {} };
}

describe("deterministic cohort comparison", () => {
  const input = {
    start: 1,
    end: 10_000,
    serviceName: "tracey-api",
    dimension: "prompt_version" as const,
    baseline: "support@1",
    candidate: "support@2",
    maxSpansPerCohort: 100,
    minSampleSize: 2,
  };

  it("computes latency, error, and token deltas from observed spans", () => {
    const report = compareCohorts(input, {
      dimension: "prompt_version",
      baseline: set("support@1", [span(1, "support@1", 100), span(2, "support@1", 200)]),
      candidate: set("support@2", [span(3, "support@2", 300), span(4, "support@2", 500, true)]),
    });

    assert.equal(report.conclusion, "sufficient");
    assert.equal(report.baseline.durationMs.mean, 150);
    assert.equal(report.candidate.durationMs.mean, 400);
    assert.equal(report.delta.meanDurationMs.absolute, 250);
    assert.equal(report.baseline.errorRate, 0);
    assert.equal(report.candidate.errorRate, 0.5);
    assert.equal(report.delta.errorRate.relative, null);
    assert.equal(report.baseline.cost.totalUsd, 0.003);
    assert.equal(report.candidate.cost.totalUsd, 0.007);
    assert.equal(report.delta.meanCostUsd?.absolute, 0.002);
    assert.equal(report.evidence.complete, true);
  });

  it("refuses a sufficient conclusion for truncated or undersampled evidence", () => {
    const report = compareCohorts(input, {
      dimension: "prompt_version",
      baseline: set("support@1", [span(1, "support@1", 100)]),
      candidate: set("support@2", [span(2, "support@2", 200)], true),
    });

    assert.equal(report.conclusion, "insufficient_evidence");
    assert.equal(report.evidence.complete, false);
    assert.ok(report.limitations.some((limitation) => /minimum sample/i.test(limitation)));
    assert.ok(report.limitations.some((limitation) => /span cap/i.test(limitation)));
  });
});
