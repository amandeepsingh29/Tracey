import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentDeploymentMappingRequestSchema, AgentRegistrationRequestSchema } from "./agent.js";

describe("production agent registration", () => {
  it("accepts bounded producer metadata without tenant or credential fields", () => {
    const parsed = AgentRegistrationRequestSchema.parse({
      displayName: "Production Codex",
      serviceName: "codex-app-server",
      producerType: "codex_desktop",
      environment: "production",
      normalizationProfile: "codex-otel-0.144@1",
      telemetryContractVersion: "tracey-agent-run@1",
      tenantId: "must-be-stripped",
      apiKey: "must-be-stripped",
    });

    assert.equal(parsed.serviceName, "codex-app-server");
    assert.ok(!("tenantId" in parsed));
    assert.ok(!("apiKey" in parsed));
  });

  it("rejects unsupported producer types and unsafe service names", () => {
    assert.equal(AgentRegistrationRequestSchema.safeParse({
      displayName: "Unknown",
      serviceName: "agent service; DROP TABLE",
      producerType: "arbitrary",
      environment: "production",
      normalizationProfile: "unknown@1",
      telemetryContractVersion: "tracey-agent-run@1",
    }).success, false);
  });

  it("accepts a validated Kubernetes Deployment target and rejects unsafe names", () => {
    assert.deepEqual(AgentDeploymentMappingRequestSchema.parse({
      namespace: "production",
      workloadName: "support-agent-api",
      containerName: "agent",
    }), {
      connectorId: "kubernetes",
      namespace: "production",
      workloadKind: "Deployment",
      workloadName: "support-agent-api",
      containerName: "agent",
    });
    assert.equal(AgentDeploymentMappingRequestSchema.safeParse({
      namespace: "production;delete",
      workloadName: "support-agent-api",
    }).success, false);
  });
});
