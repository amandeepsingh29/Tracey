import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { Agent, AgentOnboardingSource } from "../types";
import { agentProducerFilterOptions, connectedAgents, verifyRegisteredAgent } from "./Agents";

const baseAgent: Agent = {
  agentId: "11111111-1111-4111-8111-111111111111",
  displayName: "Support agent",
  serviceName: "support-agent-api",
  producerType: "custom_otel",
  environment: "development",
  normalizationProfile: "tracey.agent.v1",
  telemetryContractVersion: "1.0.0",
  status: "active",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const genericSource: AgentOnboardingSource = {
  sourceId: "generic-otel",
  connectorId: "generic-otel",
  producerType: "custom_otel",
  displayName: "OpenTelemetry agent",
  description: "Connect any agent",
  serviceNameSuggestion: "",
  displayNameSuggestion: "",
  normalizationProfile: "tracey.agent.v1",
  telemetryContractVersion: "1.0.0",
  instructions: [],
  configurationTemplate: "",
  isDefault: true,
};

afterEach(() => vi.restoreAllMocks());

describe("agent-agnostic onboarding", () => {
  it("verifies telemetry through the exact registered-agent execution source", async () => {
    vi.spyOn(api, "executions").mockResolvedValue({
      executions: [{
        executionId: "execution-1",
        sourceId: `agent:${baseAgent.agentId}`,
        producerType: "custom_otel",
        producerName: baseAgent.displayName,
        serviceName: baseAgent.serviceName,
        environment: baseAgent.environment,
        runId: "run-1",
        status: "observed",
        startedAt: "2026-07-28T00:00:00.000Z",
        tools: [],
        eventCount: 1,
      }],
      sources: [{
        sourceId: `agent:${baseAgent.agentId}`,
        displayName: baseAgent.displayName,
        serviceName: baseAgent.serviceName,
        producerType: baseAgent.producerType,
        status: "complete",
        observedExecutions: 1,
      }],
      window: { start: 1, end: 2 },
      registeredAgentCount: 1,
      truncated: false,
    });

    await expect(verifyRegisteredAgent(baseAgent)).resolves.toEqual({ observed: true, count: 1 });
  });

  it("keeps registration separate when the source has not emitted an execution", async () => {
    vi.spyOn(api, "executions").mockResolvedValue({
      executions: [],
      sources: [{
        sourceId: `agent:${baseAgent.agentId}`,
        displayName: baseAgent.displayName,
        serviceName: baseAgent.serviceName,
        producerType: baseAgent.producerType,
        status: "empty",
        observedExecutions: 0,
      }],
      window: { start: 1, end: 2 },
      registeredAgentCount: 1,
      truncated: false,
    });

    await expect(verifyRegisteredAgent(baseAgent)).resolves.toEqual({ observed: false, count: 0 });
  });

  it("hides agents and filter options whose producer connector is disconnected", () => {
    const codexAgent: Agent = {
      ...baseAgent,
      agentId: "22222222-2222-4222-8222-222222222222",
      producerType: "codex_desktop",
      displayName: "Codex",
      serviceName: "codex-app-server",
    };

    expect(connectedAgents([baseAgent, codexAgent], [genericSource])).toEqual([baseAgent]);
    expect(agentProducerFilterOptions([baseAgent, codexAgent], [genericSource])).toEqual([{
      producerType: "custom_otel",
      displayName: "OpenTelemetry agent",
    }]);
  });
});
