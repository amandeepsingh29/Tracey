import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentRunsToExecutions, codexLogsToExecutions } from "./execution-feed.js";

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
  });
});
