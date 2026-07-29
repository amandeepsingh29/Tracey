import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentSetupRequestSchema, generateAgentSetup } from "./agent-setup.js";

const input = AgentSetupRequestSchema.parse({
  sourceId: "generic-otel",
  language: "python",
  displayName: "Support Agent",
  serviceName: "support-agent-api",
  environment: "development",
});

describe("generated agent setup", () => {
  it("uses the configured collector and exact registered identity", () => {
    const setup = generateAgentSetup(input, {
      otlpEndpoint: "http://collector.example:4318/v1/traces",
      tenantId: "tenant-a",
      contractVersion: "1.0.0",
    });
    assert.equal(setup.endpoint, "http://collector.example:4318");
    assert.match(setup.environment, /OTEL_SERVICE_NAME=support-agent-api/);
    assert.match(setup.environment, /TRACEY_TENANT_ID=tenant-a/);
    assert.match(setup.code, /agent\.run/);
    assert.match(setup.code, /execute_tool list_tickets/);
  });

  it("generates executable setup for Python, Node.js, and generic OTLP", () => {
    for (const language of ["python", "node", "otlp"] as const) {
      const setup = generateAgentSetup({ ...input, language }, {
        otlpEndpoint: "http://127.0.0.1:4318",
        tenantId: "default",
        contractVersion: "1.0.0",
      });
      assert.equal(setup.language, language);
      assert.ok(setup.code.length > 200);
      assert.deepEqual(setup.expectedSpans, ["agent.run", "retrieval <source>", "chat <model>", "execute_tool <tool>"]);
    }
  });
});
