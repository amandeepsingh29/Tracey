import { describe, expect, it } from "vitest";
import type { ExecutionFeed } from "../types";
import { executionFilterOptions, filterExecutions } from "./Runs";

const feed: ExecutionFeed = {
  executions: [
    {
      executionId: "trace:notes",
      sourceId: "agent:notes",
      producerType: "custom_otel",
      producerName: "Notes Assistant",
      serviceName: "notes-agent-api",
      environment: "development",
      runId: "notes-run-1",
      traceId: "a".repeat(32),
      status: "succeeded",
      startedAt: "2026-07-29T00:00:00.000Z",
      model: "openai/gpt-4o-mini",
      tools: ["search_notes"],
      eventCount: 1,
    },
    {
      executionId: "trace:support",
      sourceId: "agent:support",
      producerType: "claude_code",
      producerName: "Support Agent",
      serviceName: "support-agent-api",
      environment: "production",
      runId: "support-run-1",
      traceId: "b".repeat(32),
      status: "failed",
      startedAt: "2026-07-29T00:01:00.000Z",
      model: "claude-sonnet",
      tools: ["create_ticket"],
      eventCount: 1,
    },
  ],
  sources: [
    {
      sourceId: "agent:notes",
      displayName: "Notes Assistant",
      serviceName: "notes-agent-api",
      producerType: "custom_otel",
      status: "complete",
      observedExecutions: 1,
    },
    {
      sourceId: "agent:support",
      displayName: "Support Agent",
      serviceName: "support-agent-api",
      producerType: "claude_code",
      status: "complete",
      observedExecutions: 1,
    },
  ],
  window: { start: 1, end: 2 },
  registeredAgentCount: 2,
  truncated: false,
};

describe("Runs live filters", () => {
  it("derives every filter option from registered sources and observed executions", () => {
    expect(executionFilterOptions(feed)).toEqual({
      sources: feed.sources,
      producerTypes: ["claude_code", "custom_otel"],
      environments: ["development", "production"],
      statuses: ["failed", "succeeded"],
      models: ["claude-sonnet", "openai/gpt-4o-mini"],
      tools: ["create_ticket", "search_notes"],
    });
  });

  it("filters by an exact registered agent source without producer special cases", () => {
    expect(filterExecutions(feed.executions, {
      sourceId: "agent:notes",
      producerType: "all",
      environment: "all",
      status: "all",
      model: "all",
      tool: "all",
      search: "",
    }).map(({ runId }) => runId)).toEqual(["notes-run-1"]);
  });
});
