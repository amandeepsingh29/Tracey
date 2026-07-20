import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTraceyMcpServer, type TraceyInvestigationReader } from "./server.js";

const unusedReader: TraceyInvestigationReader = {
  searchAgentRuns: () => Promise.reject(new Error("not called during discovery")),
  investigateTrace: () => Promise.reject(new Error("not called during discovery")),
  investigateCodexConversation: () => Promise.reject(new Error("not called during discovery")),
  queryAgentRunMetrics: () => Promise.reject(new Error("not called during discovery")),
  compareCohorts: () => Promise.reject(new Error("not called during discovery")),
};

describe("Tracey MCP protocol surface", () => {
  it("advertises only bounded read-only investigation tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createTraceyMcpServer(unusedReader);
    const client = new Client({ name: "tracey-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.listTools();
      assert.deepEqual(
        result.tools.map((tool) => tool.name).sort(),
        [
          "tracey_compare_agent_cohorts",
          "tracey_get_codex_conversation",
          "tracey_get_trace_investigation",
          "tracey_query_agent_run_metrics",
          "tracey_search_agent_runs",
        ],
      );
      for (const tool of result.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
