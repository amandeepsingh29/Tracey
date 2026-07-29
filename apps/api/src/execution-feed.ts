import type { AgentRunSummary, TraceLog, TraceSpan } from "@tracey/domain";

export const executionContractFields = [
  "prompt",
  "response",
  "model",
  "retrieval",
  "tools",
  "errors",
  "tokens",
  "cost",
  "latency",
] as const;
export type ExecutionContractField = typeof executionContractFields[number];
export type ExecutionContract = {
  version: string;
  fields: Record<ExecutionContractField, boolean>;
  observedFields: number;
  totalFields: number;
  completeness: number;
};

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
  costUsd?: number;
  contract: ExecutionContract;
  eventCount: number;
};

export type ExecutionPage = {
  executions: ObservedExecution[];
  offset: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
};

export function compareExecutionsNewestFirst(left: ObservedExecution, right: ObservedExecution): number {
  const timestampOrder = Date.parse(right.startedAt) - Date.parse(left.startedAt);
  return timestampOrder || left.executionId.localeCompare(right.executionId);
}

export function pageExecutions(
  executions: ObservedExecution[],
  input: { offset: number; limit: number },
): ExecutionPage {
  const offset = Math.max(0, Math.trunc(input.offset));
  const limit = Math.max(1, Math.trunc(input.limit));
  const ordered = [...executions].sort(compareExecutionsNewestFirst);
  return {
    executions: ordered.slice(offset, offset + limit),
    offset,
    limit,
    total: ordered.length,
    hasNextPage: offset + limit < ordered.length,
  };
}

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

function executionContract(fields: Record<ExecutionContractField, boolean>, version = "1.0.0"): ExecutionContract {
  const observedFields = Object.values(fields).filter(Boolean).length;
  const totalFields = executionContractFields.length;
  return { version, fields, observedFields, totalFields, completeness: observedFields / totalFields };
}

const emptyContract = () => executionContract({
  prompt: false,
  response: false,
  model: false,
  retrieval: false,
  tools: false,
  errors: false,
  tokens: false,
  cost: false,
  latency: false,
});

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
      contract: executionContract({
        ...emptyContract().fields,
        model: Boolean(model),
        tools: tools.length > 0,
        errors: failed,
        tokens: inputTokens > 0 || outputTokens > 0,
        latency: durations.length > 0,
      }),
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
  spansByTraceId?: Map<string, TraceSpan[]>;
  contractVersion?: string;
}): ObservedExecution[] {
  return input.runs.map((run) => {
    const spans = input.spansByTraceId?.get(run.traceId) ?? [];
    const attributes = spans.map(({ attributes }) => attributes);
    const root = spans.find(({ name, parentSpanId }) => name === "agent.run" && !parentSpanId)
      ?? spans.find(({ name }) => name === "agent.run");
    const prompt = root && stringAttribute(root.attributes, "tracey.content.input");
    const response = root && stringAttribute(root.attributes, "tracey.content.output");
    const model = attributes
      .map((item) => stringAttribute(item, "gen_ai.response.model") ?? stringAttribute(item, "gen_ai.request.model"))
      .find(Boolean);
    const tools = [...new Set(attributes.map((item) => stringAttribute(item, "gen_ai.tool.name")).filter((value): value is string => Boolean(value)))].sort();
    const inputTokens = attributes.reduce((total, item) => total + (numberAttribute(item, "gen_ai.usage.input_tokens") ?? 0), 0);
    const outputTokens = attributes.reduce((total, item) => total + (numberAttribute(item, "gen_ai.usage.output_tokens") ?? 0), 0);
    const costUsd = attributes.reduce((total, item) => total + (numberAttribute(item, "tracey.cost.usd") ?? 0), 0);
    const hasRetrieval = spans.some(({ name, attributes: item }) =>
      name.startsWith("retrieval ") || stringAttribute(item, "gen_ai.operation.name") === "retrieval");
    const hasErrorEvidence = Boolean(run.outcome)
      || spans.some(({ hasError, statusCode }) => hasError !== undefined || statusCode !== undefined);
    const fields = {
      prompt: Boolean(prompt),
      response: Boolean(response),
      model: Boolean(model),
      retrieval: hasRetrieval,
      tools: tools.length > 0,
      errors: hasErrorEvidence,
      tokens: inputTokens > 0 || outputTokens > 0,
      cost: costUsd > 0,
      latency: run.durationMs !== undefined || spans.some(({ durationMs }) => durationMs >= 0),
    };
    return {
      executionId: `trace:${run.traceId}`,
      sourceId: input.sourceId,
      producerType: input.producerType,
      producerName: input.producerName,
      serviceName: input.serviceName,
      environment: input.environment,
      runId: run.runId,
      traceId: run.traceId,
      status: /^(?:fail(?:ed|ure)?|error)$/i.test(run.outcome ?? "") ? "failed"
        : /^(?:ok|success|succeeded|complete|resolved)$/i.test(run.outcome ?? "") ? "succeeded"
          : "observed",
      startedAt: run.startedAt,
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      ...(model ? { model } : {}),
      tools,
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(costUsd > 0 ? { costUsd } : {}),
      contract: executionContract(fields, input.contractVersion),
      eventCount: Math.max(1, spans.length),
    };
  });
}
