import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceSpan } from "@tracey/domain";
import { analyzeLatency, buildRunGraph } from "./run-graph.js";

const traceId = "a".repeat(32);

function span(
  spanId: string,
  parentSpanId: string | null,
  startTimeMs: number,
  durationMs: number,
  name = "operation",
): TraceSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    serviceName: "tracey-api",
    startedAt: new Date(startTimeMs).toISOString(),
    startTimeMs,
    durationMs,
    attributes: {},
  };
}

describe("run graph latency analysis", () => {
  it("includes sequential child operations on the critical path", () => {
    const graph = buildRunGraph([
      span("1".repeat(16), null, 0, 10, "agent.run"),
      span("2".repeat(16), "1".repeat(16), 1, 4),
      span("3".repeat(16), "1".repeat(16), 5, 4),
    ]);
    const analysis = analyzeLatency(graph);

    assert.equal(analysis.wallClockMs, 10);
    assert.equal(analysis.criticalPathDurationMs, 10);
    assert.deepEqual(analysis.criticalPathSpanIds, [
      "1".repeat(16),
      "2".repeat(16),
      "3".repeat(16),
    ]);
  });

  it("does not add parallel child durations together", () => {
    const graph = buildRunGraph([
      span("1".repeat(16), null, 0, 10, "agent.run"),
      span("2".repeat(16), "1".repeat(16), 1, 8),
      span("3".repeat(16), "1".repeat(16), 1, 8),
    ]);
    const analysis = analyzeLatency(graph);

    assert.equal(analysis.criticalPathDurationMs, 10);
    assert.equal(analysis.parallelSiblingOverlapMs, 8);
    assert.equal(analysis.criticalPathSpanIds.length, 2);
  });

  it("surfaces missing context propagation through graph completeness", () => {
    const graph = buildRunGraph([
      span("1".repeat(16), null, 0, 10, "agent.run"),
      span("2".repeat(16), "f".repeat(16), 1, 4),
    ]);
    const analysis = analyzeLatency(graph);

    assert.deepEqual(analysis.orphanSpanIds, ["2".repeat(16)]);
    assert.equal(analysis.completenessScore, 0);
  });
});
