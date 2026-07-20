import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexConversationSearchSchema } from "./codex.js";

describe("CodexConversationSearchSchema", () => {
  it("defaults to the desktop app service while allowing explicit CLI service selection", () => {
    const input = {
      start: 1,
      end: 2,
      conversationId: "019f68cf-12e1-7871-9fa6-e3a6325f3a48",
    };
    assert.equal(CodexConversationSearchSchema.parse(input).serviceName, "codex-app-server");
    assert.equal(
      CodexConversationSearchSchema.parse({ ...input, serviceName: "Codex Desktop" }).serviceName,
      "Codex Desktop",
    );
  });
});
