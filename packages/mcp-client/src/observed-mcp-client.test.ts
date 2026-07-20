import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpToolArgumentsError, toolDenialReason, validateToolArguments } from "./observed-mcp-client.js";

describe("MCP safety boundary", () => {
  it("requires explicit read-tool allowlisting and honors destructive annotations", () => {
    const baseTool = { name: "orders.lookup", inputSchema: { type: "object" as const } };
    assert.match(toolDenialReason(baseTool, new Set()) ?? "", /not present/);
    assert.equal(toolDenialReason(baseTool, new Set(["orders.lookup"])), undefined);
    assert.match(
      toolDenialReason(
        { ...baseTool, annotations: { destructiveHint: true } },
        new Set(["orders.lookup"]),
      ) ?? "",
      /destructive/,
    );
  });

  it("rejects oversized arguments before any network call", () => {
    assert.throws(
      () => validateToolArguments({ value: "x".repeat(100) }, 32),
      McpToolArgumentsError,
    );
  });
});
