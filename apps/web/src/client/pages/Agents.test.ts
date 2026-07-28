import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { Agent } from "../types";
import { verifyRegisteredAgent } from "./Agents";

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

afterEach(() => vi.restoreAllMocks());

describe("agent connection verification", () => {
  it("verifies a registered OpenTelemetry agent through its exact run query", async () => {
    const runs = vi.spyOn(api, "agentRuns").mockResolvedValue({
      runs: [{ runId: "run-1", traceId: "a".repeat(32) }],
    });

    await expect(verifyRegisteredAgent(baseAgent)).resolves.toEqual({ observed: true, count: 1 });
    expect(runs).toHaveBeenCalledWith(baseAgent.agentId, expect.objectContaining({ limit: 20 }));
  });

  it("uses a real local Codex conversation without requiring SigNoz fallback", async () => {
    vi.spyOn(api, "recentCodexConversations").mockResolvedValue({
      conversations: [{
        conversationId: "conversation-1",
        turnIndex: 1,
        prompt: "Inspect the service",
        startedAt: "2026-07-28T00:00:00.000Z",
        endedAt: "2026-07-28T00:00:01.000Z",
        durationMs: 1_000,
        eventCount: 3,
        toolNames: ["shell"],
        status: "complete",
      }],
      windowHours: 168,
      source: "local_codex_session",
    });
    const fallback = vi.spyOn(api, "executions");

    await expect(verifyRegisteredAgent({
      ...baseAgent,
      producerType: "codex_desktop",
      serviceName: "codex-app-server",
    })).resolves.toEqual({ observed: true, count: 1 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not accept telemetry from a different service during Codex fallback", async () => {
    vi.spyOn(api, "recentCodexConversations").mockRejectedValue(new Error("Local forensic mode disabled"));
    vi.spyOn(api, "executions").mockResolvedValue({
      executions: [{
        executionId: "execution-1",
        producerType: "codex_desktop",
        producerName: "Other Codex",
        serviceName: "other-codex-service",
        environment: "development",
        runId: "run-1",
        status: "observed",
        startedAt: "2026-07-28T00:00:00.000Z",
        tools: [],
        eventCount: 1,
      }],
      sources: [],
      window: { start: 1, end: 2 },
      registeredAgentCount: 1,
      truncated: false,
    });

    await expect(verifyRegisteredAgent({
      ...baseAgent,
      producerType: "codex_desktop",
      serviceName: "codex-app-server",
    })).resolves.toEqual({ observed: false, count: 0 });
  });
});
