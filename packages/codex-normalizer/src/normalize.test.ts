import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodexConversationSearch, TraceLog, TraceLogSearchResult } from "@tracey/domain";
import { normalizeCodexConversation } from "./normalize.js";

const conversationId = "019f692d-ffde-77d1-a3e0-14b849467fdd";
const search: CodexConversationSearch = {
  start: 1,
  end: 100_000,
  conversationId,
  serviceName: "Codex Desktop",
  limit: 5_000,
};

function log(
  eventName: string,
  timestampMs: number,
  attributes: Record<string, unknown> = {},
): TraceLog {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    body: eventName,
    serviceName: "Codex Desktop",
    attributes: {
      "event.name": eventName,
      "event.timestamp": new Date(timestampMs).toISOString(),
      "conversation.id": conversationId,
      "app.version": "0.144.4",
      model: "gpt-test",
      ...attributes,
    },
  };
}

function result(logs: TraceLog[]): TraceLogSearchResult {
  return { logs, rejectedRows: 0, query: { rowsScanned: logs.length } };
}

describe("Codex OTel normalization", () => {
  it("projects observed prompt, response, decision, and tool events into one agent.run graph", () => {
    const normalized = normalizeCodexConversation(search, result([
      log("codex.conversation_starts", 900),
      log("codex.user_prompt", 1_000, { prompt_length: "77" }),
      log("codex.sse_event", 2_000, {
        "event.kind": "response.completed",
        input_token_count: "100",
        output_token_count: "20",
        cached_token_count: 40,
        reasoning_token_count: 2,
      }),
      log("codex.tool_decision", 2_100, {
        tool_name: "exec_command",
        decision: "approved",
        source: "Config",
      }),
      log("codex.tool_result", 2_300, {
        tool_name: "exec_command",
        duration_ms: "50",
        success: "true",
        output: "must not be copied",
      }),
      log("codex.sse_event", 3_000, {
        "event.kind": "response.completed",
        input_token_count: "120",
        output_token_count: "5",
        cached_token_count: 80,
        reasoning_token_count: 0,
      }),
    ]));

    assert.equal(normalized.runs.length, 1);
    const run = normalized.runs[0];
    assert.equal(run?.status, "complete");
    assert.equal(run?.durationMs, 2_000);
    assert.equal(run?.evidenceCompleteness, 1);
    assert.equal(run?.spans[0]?.name, "agent.run");
    assert.equal(run?.spans.filter(({ attributes }) => attributes["gen_ai.operation.name"] === "chat").length, 2);
    const tool = run?.spans.find(({ attributes }) => attributes["gen_ai.tool.name"] === "exec_command");
    assert.equal(tool?.durationMs, 50);
    assert.equal(tool?.attributes["tracey.tool.result.class"], "success");
    const serialized = JSON.stringify(run);
    assert.ok(!serialized.includes("must not be copied"));
    assert.ok(!serialized.includes('"output"'));
    assert.ok(run?.spans.every(({ traceId }) => traceId === run.spans[0]?.traceId));
  });

  it("segments multiple prompts and marks a turn without response.completed as incomplete", () => {
    const normalized = normalizeCodexConversation(search, result([
      log("codex.user_prompt", 1_000),
      log("codex.sse_event", 2_000, { "event.kind": "response.completed" }),
      log("codex.user_prompt", 3_000),
      log("codex.tool_result", 4_000, { tool_name: "read_file", success: false }),
    ]));

    assert.equal(normalized.runs.length, 2);
    assert.equal(normalized.runs[0]?.status, "complete");
    assert.equal(normalized.runs[1]?.status, "incomplete");
    assert.equal(normalized.runs[1]?.evidenceCompleteness, 0.5);
    assert.ok(normalized.runs[1]?.limitations.some((limitation) => /No response\.completed/.test(limitation)));
  });
});
