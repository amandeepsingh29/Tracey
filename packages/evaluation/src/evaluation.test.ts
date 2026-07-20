import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceSpan } from "@tracey/domain";
import { capturedPayloadSha256, evaluateDataset } from "./evaluation.js";

const traceId = "a".repeat(32);
const rootId = "1".repeat(16);
const timeoutId = "2".repeat(16);
const successId = "3".repeat(16);

const spans: TraceSpan[] = [
  {
    traceId,
    spanId: rootId,
    parentSpanId: null,
    name: "agent.run",
    serviceName: "support-agent",
    startedAt: new Date(1_000).toISOString(),
    startTimeMs: 1_000,
    durationMs: 5_000,
    attributes: {},
  },
  {
    traceId,
    spanId: timeoutId,
    parentSpanId: rootId,
    name: "execute_tool crm.lookup",
    serviceName: "support-agent",
    startedAt: new Date(1_100).toISOString(),
    startTimeMs: 1_100,
    durationMs: 2_000,
    hasError: true,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "crm.lookup",
      "tracey.tool.attempt": 1,
      "tracey.tool.result.class": "timeout",
    },
  },
  {
    traceId,
    spanId: successId,
    parentSpanId: rootId,
    name: "execute_tool crm.lookup",
    serviceName: "support-agent",
    startedAt: new Date(3_200).toISOString(),
    startTimeMs: 3_200,
    durationMs: 500,
    hasError: false,
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "crm.lookup",
      "tracey.tool.attempt": 2,
      "tracey.tool.result.class": "success",
    },
  },
];

function dataset(payloadHash = capturedPayloadSha256(spans, [])) {
  return {
    schemaVersion: "1.0",
    datasetId: "unit-evaluation-v1",
    createdAt: new Date(10_000).toISOString(),
    cases: [{
      caseId: "crm-timeout-retry-01",
      scenario: "crm_timeout_retry",
      traceId,
      capture: {
        kind: "signoz_query_v5",
        capturedAt: new Date(9_000).toISOString(),
        deployment: "unit-signoz",
        environment: "test",
        tenantIdHash: `sha256:${"b".repeat(64)}`,
        queryStart: 1,
        queryEnd: 10_000,
        payloadSha256: payloadHash,
      },
      spans,
      logs: [],
      expected: {
        primaryCategory: "retry_recovery",
        requiredCategories: ["retry_recovery"],
        allowedCategories: ["retry_recovery", "tool_failure", "latency"],
      },
    }],
  };
}

describe("captured diagnosis evaluation", () => {
  it("runs the production graph and diagnosis path and resolves cited evidence", () => {
    const report = evaluateDataset(dataset());

    assert.equal(report.metrics.top1Accuracy, 1);
    assert.equal(report.metrics.top3Recall, 1);
    assert.equal(report.metrics.evidenceCitationPrecision, 1);
    assert.equal(report.metrics.falseCausalClaimRate, 0);
    assert.equal(report.gates.payloadIntegrity, true);
    assert.equal(report.gates.minimumDatasetSize.passed, false);
    assert.equal(report.gates.allScenariosCovered, false);
  });

  it("reports capture payload tampering", () => {
    const report = evaluateDataset(dataset(`sha256:${"0".repeat(64)}`));
    assert.equal(report.gates.payloadIntegrity, false);
  });
});
