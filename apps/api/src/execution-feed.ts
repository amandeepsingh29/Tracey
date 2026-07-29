import type { AgentRunSummary, TraceLog } from "@tracey/domain";

export type ObservedExecution = {
  executionId: string;
  sourceId: string;
  producerType: "codex_desktop" | "codex_cli" | "claude_code" | "custom_otel";
  producerName: string;
  serviceName: string;
  environment: string;
  runId: string;
  traceId?: string;
  conversationId?: string;
  status: "succeeded" | "failed" | "observed";
  startedAt: string;
  durationMs?: number;
  model?: string;
  tools: string[];
  inputTokens?: number;
  outputTokens?: number;
  eventCount: number;
};

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberAttribute(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usefulTraceId(traceId: string): string | undefined {
  return /^[a-fA-F0-9]{32}$/.test(traceId) && traceId !== "0".repeat(32) ? traceId : undefined;
}

export function codexLogsToExecutions(input: {
  logs: TraceLog[];
  sourceId: string;
  serviceName: string;
  producerName: string;
  environment: string;
  producerType?: "codex_desktop" | "codex_cli";
}): ObservedExecution[] {
  const groups = new Map<string, TraceLog[]>();
  for (const log of input.logs) {
    const conversationId = stringAttribute(log.attributes, "conversation.id");
    const traceId = usefulTraceId(log.traceId);
    const key = traceId ? `trace:${traceId}` : conversationId ? `conversation:${conversationId}` : `event:${log.timestamp}:${log.body}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  return [...groups.entries()].map(([key, logs]) => {
    const ordered = [...logs].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    const attributes = ordered.map((log) => log.attributes);
    const conversationId = attributes.map((item) => stringAttribute(item, "conversation.id")).find(Boolean);
    const traceId = ordered.map((log) => usefulTraceId(log.traceId)).find(Boolean);
    const model = [...attributes].reverse().map((item) => stringAttribute(item, "model")).find(Boolean);
    const tools = [...new Set(attributes.map((item) => stringAttribute(item, "tool_name")).filter((value): value is string => Boolean(value)))].sort();
    const durations = attributes.map((item) => numberAttribute(item, "duration_ms")).filter((value): value is number => value !== undefined);
    const inputTokens = attributes.reduce((total, item) => total + (numberAttribute(item, "input_token_count") ?? 0), 0);
    const outputTokens = attributes.reduce((total, item) => total + (numberAttribute(item, "output_token_count") ?? 0), 0);
    const failed = attributes.some((item) => item.success === false || typeof item["error.type"] === "string");
    return {
      executionId: key,
      sourceId: input.sourceId,
      producerType: input.producerType ?? "codex_desktop",
      producerName: input.producerName,
      serviceName: input.serviceName,
      environment: input.environment,
      runId: conversationId ?? traceId ?? key,
      ...(traceId ? { traceId } : {}),
      ...(conversationId ? { conversationId } : {}),
      status: failed ? "failed" : "observed",
      startedAt: ordered[0]!.timestamp,
      ...(durations.length > 0 ? { durationMs: Math.max(...durations) } : {}),
      ...(model ? { model } : {}),
      tools,
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      eventCount: ordered.length,
    };
  });
}

export function agentRunsToExecutions(input: {
  runs: AgentRunSummary[];
  sourceId: string;
  producerType: "claude_code" | "custom_otel";
  producerName: string;
  serviceName: string;
  environment: string;
}): ObservedExecution[] {
  return input.runs.map((run) => ({
    executionId: `trace:${run.traceId}`,
    sourceId: input.sourceId,
    producerType: input.producerType,
    producerName: input.producerName,
    serviceName: input.serviceName,
    environment: input.environment,
    runId: run.runId,
    traceId: run.traceId,
    status: /^(?:fail(?:ed|ure)?|error)$/i.test(run.outcome ?? "") ? "failed"
      : /^(?:ok|success|succeeded|complete)$/i.test(run.outcome ?? "") ? "succeeded"
        : "observed",
    startedAt: run.startedAt,
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    tools: [],
    eventCount: 1,
  }));
}
