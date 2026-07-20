import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildConnectorRegistry } from "./index.js";

describe("connector registry", () => {
  it("advertises only external integrations with honest readiness", () => {
    const connectors = buildConnectorRegistry({
      signozConfigured: true,
      kubernetesInvestigatorEnabled: false,
      kubernetesExecutorConfigured: false,
      otlpConfigured: true,
      mcpClientConfigured: false,
      mcpServerConfigured: false,
    });

    assert.deepEqual(connectors.map(({ id }) => id), ["signoz", "kubernetes", "codex", "claude-code", "generic-otel", "mcp"]);
    assert.ok(connectors.every(({ externalSystem }) => externalSystem === true));
    assert.equal(connectors.find(({ id }) => id === "codex")?.state, "ready");
    assert.equal(connectors.find(({ id }) => id === "kubernetes")?.state, "needs_configuration");
    assert.equal(connectors.some(({ id }) => id.includes("notes")), false);
  });
});
