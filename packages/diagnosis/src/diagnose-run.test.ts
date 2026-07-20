import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceLog, TraceSpan } from "@tracey/domain";
import { analyzeLatency, buildRunGraph } from "@tracey/graph";
import { diagnoseRun } from "./diagnose-run.js";

const traceId = "a".repeat(32);
const rootId = "1".repeat(16);
const toolId = "2".repeat(16);

const spans: TraceSpan[] = [
  {
    traceId,
    spanId: rootId,
    parentSpanId: null,
    name: "agent.run",
    serviceName: "tracey-api",
    startedAt: new Date(0).toISOString(),
    startTimeMs: 0,
    durationMs: 10_000,
    attributes: {},
  },
  {
    traceId,
    spanId: toolId,
    parentSpanId: rootId,
    name: "execute_tool crm.lookup",
    serviceName: "tracey-api",
    startedAt: new Date(1_000).toISOString(),
    startTimeMs: 1_000,
    durationMs: 8_000,
    statusCode: "STATUS_CODE_ERROR",
    hasError: true,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "crm.lookup",
      "tracey.tool.result.class": "timeout",
      "tracey.tool.side_effect": "read",
    },
  },
];

describe("deterministic run diagnosis", () => {
  it("links a critical-path tool failure to the exact span", () => {
    const report = diagnoseRun(spans, analyzeLatency(buildRunGraph(spans)));

    assert.equal(report.hypotheses[0]?.category, "tool_failure");
    assert.equal(report.hypotheses[0]?.evidence[0]?.spanId, toolId);
    assert.match(report.summary, /crm\.lookup/);
    assert.ok(report.hypotheses.some((hypothesis) => hypothesis.category === "latency"));
  });

  it("recognizes all seven PRD failure classes from explicit telemetry", () => {
    const root = spans[0];
    assert.ok(root);
    const scenarioSpans: TraceSpan[] = [
      { ...root, durationMs: 20_000 },
      {
        ...spans[1]!,
        durationMs: 2_000,
        attributes: { ...spans[1]!.attributes, "tracey.tool.attempt": 1 },
      },
      {
        ...spans[1]!,
        spanId: "3".repeat(16),
        startTimeMs: 3_100,
        startedAt: new Date(3_100).toISOString(),
        durationMs: 1_000,
        hasError: false,
        statusCode: "STATUS_CODE_OK",
        attributes: {
          ...spans[1]!.attributes,
          "tracey.tool.attempt": 2,
          "tracey.tool.result.class": "success",
        },
      },
      {
        traceId,
        spanId: "4".repeat(16),
        parentSpanId: rootId,
        name: "retrieval policy-search",
        serviceName: "tracey-api",
        startedAt: new Date(4_200).toISOString(),
        startTimeMs: 4_200,
        durationMs: 500,
        attributes: {
          "gen_ai.operation.name": "retrieval",
          "tracey.retriever.name": "policy-search",
          "tracey.result.count": 0,
          "tracey.context.tokens": 8_000,
          "tracey.context.truncated": true,
        },
      },
      {
        traceId,
        spanId: "5".repeat(16),
        parentSpanId: rootId,
        name: "agent.decision",
        serviceName: "tracey-api",
        startedAt: new Date(4_800).toISOString(),
        startTimeMs: 4_800,
        durationMs: 100,
        attributes: {
          "tracey.decision.type": "select_tool",
          "tracey.decision.selected": "billing.lookup",
          "tracey.decision.expected": "refund.lookup",
          "tracey.decision.correct": false,
        },
      },
      {
        traceId,
        spanId: "6".repeat(16),
        parentSpanId: rootId,
        name: "chat primary",
        serviceName: "tracey-api",
        startedAt: new Date(5_000).toISOString(),
        startTimeMs: 5_000,
        durationMs: 500,
        hasError: true,
        statusCode: "STATUS_CODE_ERROR",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "primary-model",
          "tracey.model.route": "primary",
        },
      },
      {
        traceId,
        spanId: "7".repeat(16),
        parentSpanId: rootId,
        name: "chat fallback",
        serviceName: "tracey-api",
        startedAt: new Date(5_600).toISOString(),
        startTimeMs: 5_600,
        durationMs: 1_000,
        hasError: false,
        statusCode: "STATUS_CODE_OK",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "fallback-model",
          "gen_ai.response.model": "fallback-model",
          "tracey.model.route": "fallback",
        },
      },
      {
        traceId,
        spanId: "8".repeat(16),
        parentSpanId: rootId,
        name: "execute_tool refund.lookup",
        serviceName: "tracey-api",
        startedAt: new Date(6_700).toISOString(),
        startTimeMs: 6_700,
        durationMs: 300,
        hasError: true,
        statusCode: "STATUS_CODE_ERROR",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "refund.lookup",
          "tracey.tool.schema.version": "refund.lookup@4",
          "tracey.tool.result.class": "invalid",
        },
      },
    ];
    const feedbackLogs: TraceLog[] = [{
      timestamp: new Date(21_000).toISOString(),
      traceId,
      spanId: rootId,
      body: "Agent feedback received",
      attributes: {
        "tracey.feedback.source": "thumbs_down",
        "tracey.feedback.label": "wrong_tool",
        "tracey.feedback.score": -1,
      },
    }];

    const report = diagnoseRun(
      scenarioSpans,
      analyzeLatency(buildRunGraph(scenarioSpans)),
      feedbackLogs,
    );
    const categories = new Set(report.hypotheses.map(({ category }) => category));

    assert.deepEqual(
      [
        "retry_recovery",
        "retrieval_failure",
        "tool_selection",
        "provider_fallback",
        "context_truncation",
        "schema_mismatch",
        "negative_feedback",
      ].filter((category) => !categories.has(category as never)),
      [],
    );
    assert.ok(report.hypotheses.every(({ evidence }) => evidence.length > 0));
  });
});
