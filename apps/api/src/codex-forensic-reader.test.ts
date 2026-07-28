import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listRecentCodexForensicTurns, readCodexForensicTurn, redactForensicContent } from "./codex-forensic-reader.js";

const conversationId = "019f692d-ffde-77d1-a3e0-14b849467fdd";

function line(timestamp: string, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp, type, payload });
}

describe("local Codex forensic reader", () => {
  it("segments turns and returns complete developer content with credentials protected", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracey-codex-"));
    const directory = join(root, "2026", "07", "26");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-${conversationId}.jsonl`);
    await writeFile(file, [
      line("2026-07-26T00:00:00.000Z", "turn_context", { turn_id: "turn-1" }),
      line("2026-07-26T00:00:00.100Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Deploy with OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz" }] }),
      line("2026-07-26T00:00:01.000Z", "response_item", { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "kubectl get pods" }),
      line("2026-07-26T00:00:02.000Z", "response_item", { type: "custom_tool_call_output", call_id: "call-1", output: "exit code 0" }),
      line("2026-07-26T00:00:03.000Z", "turn_context", { turn_id: "turn-2" }),
      line("2026-07-26T00:00:03.100Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Second prompt" }] }),
    ].join("\n"), "utf8");

    const protectedTurn = await readCodexForensicTurn({
      sessionsDir: root,
      conversationId,
      turnIndex: 1,
      includeSensitive: false,
    });
    assert.equal(protectedTurn?.events.length, 3);
    assert.equal(protectedTurn?.turnId, "turn-1");
    assert.match(protectedTurn?.events[0]?.content ?? "", /REDACTED_SENSITIVE_VALUE/);
    assert.equal(protectedTurn?.events[0]?.sensitive, true);
    assert.equal(JSON.stringify(protectedTurn).includes("sk-or-v1-abcdefghijklmnopqrstuvwxyz"), false);

    const revealedTurn = await readCodexForensicTurn({
      sessionsDir: root,
      conversationId,
      turnIndex: 1,
      includeSensitive: true,
    });
    assert.match(revealedTurn?.events[0]?.content ?? "", /sk-or-v1-abcdefghijklmnopqrstuvwxyz/);
  });

  it("recognizes common authorization material", () => {
    const result = redactForensicContent("authorization: Bearer abcdefghijkl token=second-secret");
    assert.equal(result.sensitive, true);
    assert.equal(result.content.includes("abcdefghijkl"), false);
    assert.equal(result.content.includes("second-secret"), false);
  });

  it("lists recent user-facing prompts and excludes injected environment context", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracey-codex-recent-"));
    const directory = join(root, "2026", "07", "26");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-${conversationId}.jsonl`), [
      line("2026-07-26T12:00:00.000Z", "turn_context", { turn_id: "turn-1" }),
      line("2026-07-26T12:00:00.100Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>internal</environment_context>" }] }),
      line("2026-07-26T12:00:00.200Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Show my latest failed deployment" }] }),
      line("2026-07-26T12:00:01.000Z", "response_item", { type: "function_call", name: "query_logs", call_id: "call-1", arguments: "{}" }),
      line("2026-07-26T12:00:02.000Z", "response_item", { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "The deployment failed." }] }),
    ].join("\n"), "utf8");

    const recent = await listRecentCodexForensicTurns({
      sessionsDir: root,
      since: Date.parse("2026-07-26T00:00:00.000Z"),
      limit: 10,
    });
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.prompt, "Show my latest failed deployment");
    assert.deepEqual(recent[0]?.toolNames, ["query_logs"]);
    assert.equal(recent[0]?.status, "complete");
  });
});
