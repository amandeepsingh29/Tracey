import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentRunsToExecutions,
  codexLogsToExecutions,
  pageExecutions,
} from "./execution-feed.js";

describe("unified execution feed", () => {
  it("groups privacy-safe Codex events by trace and aggregates operational metadata", () => {
    const traceId = "a".repeat(32);
    const conversationId = crypto.randomUUID();
    const executions = codexLogsToExecutions({
      sourceId: "agent:codex",
      serviceName: "codex-app-server",
      producerName: "Codex App Server",
      environment: "development",
      logs: [
        { timestamp: "2026-07-25T00:00:00.000Z", traceId, body: "codex.api_request", attributes: { "conversation.id": conversationId, model: "gpt-5", duration_ms: 20, input_token_count: 10, success: true } },
        { timestamp: "2026-07-25T00:00:01.000Z", traceId, body: "codex.tool.call", attributes: { "conversation.id": conversationId, tool_name: "exec_command", output_token_count: 5, success: false, "error.type": "TimeoutError" } },
      ],
    });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.sourceId, "agent:codex");
    assert.equal(executions[0]?.status, "failed");
    assert.equal(executions[0]?.conversationId, conversationId);
    assert.equal(executions[0]?.model, "gpt-5");
    assert.deepEqual(executions[0]?.tools, ["exec_command"]);
    assert.equal(executions[0]?.inputTokens, 10);
    assert.equal(executions[0]?.outputTokens, 5);
    assert.equal(executions[0]?.eventCount, 2);
  });

  it("normalizes registered agent roots without inventing absent model or tool data", () => {
    const executions = agentRunsToExecutions({
      sourceId: "agent:support",
      producerType: "custom_otel",
      producerName: "Support agent",
      serviceName: "support-agent-api",
      environment: "production",
      runs: [{ traceId: "b".repeat(32), runId: "run-1", serviceName: "support-agent-api", outcome: "success", startedAt: "2026-07-25T00:00:00.000Z", durationMs: 42 }],
    });
    assert.equal(executions[0]?.status, "succeeded");
    assert.equal(executions[0]?.sourceId, "agent:support");
    assert.deepEqual(executions[0]?.tools, []);
    assert.equal(executions[0]?.model, undefined);
    assert.equal(executions[0]?.contract.fields.latency, true);
    assert.equal(executions[0]?.contract.fields.model, false);
  });

  it("reports exact execution contract coverage from observed child spans", () => {
    const traceId = "c".repeat(32);
    const spans = [
      { traceId, spanId: "1".repeat(16), parentSpanId: null, name: "agent.run", serviceName: "support-agent-api", startedAt: "2026-07-25T00:00:00.000Z", startTimeMs: 1, durationMs: 50, statusCode: "STATUS_CODE_OK", hasError: false, attributes: { "tracey.content.input": "prompt", "tracey.content.output": "answer" } },
      { traceId, spanId: "2".repeat(16), parentSpanId: "1".repeat(16), name: "retrieval docs", serviceName: "support-agent-api", startedAt: "2026-07-25T00:00:00.001Z", startTimeMs: 2, durationMs: 5, attributes: { "gen_ai.operation.name": "retrieval" } },
      { traceId, spanId: "3".repeat(16), parentSpanId: "1".repeat(16), name: "chat gpt-4o-mini", serviceName: "support-agent-api", startedAt: "2026-07-25T00:00:00.010Z", startTimeMs: 10, durationMs: 20, attributes: { "gen_ai.response.model": "gpt-4o-mini", "gen_ai.usage.input_tokens": 18, "gen_ai.usage.output_tokens": 11, "tracey.cost.usd": 0.0000093 } },
      { traceId, spanId: "4".repeat(16), parentSpanId: "1".repeat(16), name: "execute_tool list_tickets", serviceName: "support-agent-api", startedAt: "2026-07-25T00:00:00.035Z", startTimeMs: 35, durationMs: 10, attributes: { "gen_ai.tool.name": "list_tickets" } },
    ];
    const executions = agentRunsToExecutions({
      sourceId: "agent:support",
      producerType: "custom_otel",
      producerName: "Support agent",
      serviceName: "support-agent-api",
      environment: "production",
      contractVersion: "1.0.0",
      spansByTraceId: new Map([[traceId, spans]]),
      runs: [{ traceId, runId: "run-full", serviceName: "support-agent-api", outcome: "resolved", startedAt: "2026-07-25T00:00:00.000Z", durationMs: 50 }],
    });
    assert.equal(executions[0]?.contract.completeness, 1);
    assert.equal(executions[0]?.model, "gpt-4o-mini");
    assert.deepEqual(executions[0]?.tools, ["list_tickets"]);
    assert.equal(executions[0]?.inputTokens, 18);
    assert.equal(executions[0]?.costUsd, 0.0000093);
  });

  it("paginates executions with deterministic ordering when timestamps tie", () => {
    const runs = ["c", "a", "b"].map((suffix) => ({
      traceId: suffix.repeat(32),
      runId: `run-${suffix}`,
      serviceName: "support-agent-api",
      outcome: "success",
      startedAt: "2026-07-25T00:00:00.000Z",
      durationMs: 1,
    }));
    const executions = agentRunsToExecutions({
      sourceId: "agent:support",
      producerType: "custom_otel",
      producerName: "Support agent",
      serviceName: "support-agent-api",
      environment: "production",
      runs,
    });

    const first = pageExecutions(executions, { offset: 0, limit: 2 });
    const second = pageExecutions(executions, { offset: 2, limit: 2 });
    assert.deepEqual(first.executions.map(({ runId }) => runId), ["run-a", "run-b"]);
    assert.deepEqual(second.executions.map(({ runId }) => runId), ["run-c"]);
    assert.equal(first.total, 3);
    assert.equal(first.hasNextPage, true);
    assert.equal(second.hasNextPage, false);
  });
});
