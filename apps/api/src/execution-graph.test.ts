import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvestigatedCodexRun } from "@tracey/investigation";
import { buildCodexExecutionGraph, buildLocalCodexExecutionGraph } from "./execution-graph.js";

const run = {
  runId: "codex:conversation:1",
  conversationId: "019f692d-ffde-77d1-a3e0-14b849467fdd",
  turnIndex: 1,
  model: "gpt-test",
  startedAt: "2026-07-26T00:00:00.000Z",
  endedAt: "2026-07-26T00:00:03.000Z",
  durationMs: 3_000,
  status: "complete",
  evidenceCompleteness: 1,
  limitations: [],
  evidence: [],
  analysis: {},
  diagnosis: {},
  spans: [{
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    name: "agent.run",
    serviceName: "codex-app-server",
    startedAt: "2026-07-26T00:00:00.000Z",
    startTimeMs: Date.parse("2026-07-26T00:00:00.000Z"),
    durationMs: 3_000,
    statusCode: "STATUS_CODE_OK",
    attributes: {},
  }],
} as unknown as InvestigatedCodexRun;

describe("prompt-to-action execution graph", () => {
  it("builds observed tool-result edges from local Codex call identifiers", () => {
    const graph = buildCodexExecutionGraph({
      run,
      forensicModeAvailable: true,
      sensitiveValuesIncluded: false,
      forensicTurn: {
        conversationId: run.conversationId,
        turnIndex: 1,
        sourceFile: "session.jsonl",
        events: [
          { id: "prompt", timestamp: run.startedAt, kind: "prompt", label: "User prompt", content: "Check pods", sensitive: false, raw: {} },
          { id: "call", timestamp: "2026-07-26T00:00:01.000Z", kind: "tool_call", label: "Tool call · exec", content: "kubectl get pods", toolName: "exec", callId: "call-1", sensitive: false, raw: {} },
          { id: "result", timestamp: "2026-07-26T00:00:02.000Z", kind: "tool_result", label: "Tool result", content: "exit code 0", callId: "call-1", sensitive: false, raw: {} },
        ],
      },
    });
    assert.equal(graph.contentSource, "local_session");
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(graph.edges[1], {
      edgeId: "call->result",
      from: "call",
      to: "result",
      relationship: "tool_result",
      certainty: "observed",
    });
    assert.equal(graph.nodes[2]?.status, "succeeded");
  });

  it("builds a complete graph directly from a recent local Codex turn", () => {
    const graph = buildLocalCodexExecutionGraph({
      sensitiveValuesIncluded: false,
      forensicTurn: {
        conversationId: run.conversationId,
        turnIndex: 2,
        sourceFile: "session.jsonl",
        events: [
          { id: "prompt", timestamp: run.startedAt, kind: "prompt", label: "User prompt", content: "Check production", sensitive: false, raw: {} },
          { id: "final", timestamp: run.endedAt, kind: "response", phase: "final", label: "Final response", content: "Production is healthy", sensitive: false, raw: {} },
        ],
      },
    });
    assert.equal(graph.runId, `codex:${run.conversationId}:2`);
    assert.equal(graph.contentSource, "local_session");
    assert.equal(graph.status, "complete");
    assert.equal(graph.evidence.length, 0);
    assert.equal(graph.nodes[1]?.kind, "final");
  });
});
