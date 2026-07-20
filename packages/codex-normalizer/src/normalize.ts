import { createHash } from "node:crypto";
import type {
  CodexConversationSearch,
  QueryExecutionMetadata,
  TraceLog,
  TraceLogSearchResult,
  TraceSpan,
} from "@tracey/domain";

export const CODEX_NORMALIZATION_VERSION = "codex-otel-0.144@1";

export interface CodexEvidenceReference {
  eventName: string;
  timestamp: string;
  sourceTraceId: string;
  sourceSpanId?: string;
}

export interface NormalizedCodexRun {
  runId: string;
  conversationId: string;
  turnIndex: number;
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "complete" | "incomplete" | "failed";
  spans: TraceSpan[];
  evidence: CodexEvidenceReference[];
  evidenceCompleteness: number;
  limitations: string[];
}

export interface CodexConversationNormalization {
  conversationId: string;
  normalizationVersion: string;
  runs: NormalizedCodexRun[];
  rejectedLogs: number;
  nextCursor?: string;
  query: QueryExecutionMetadata;
}

interface CodexEvent {
  log: TraceLog;
  name: string;
  timestampMs: number;
}

function stringAttribute(log: TraceLog, key: string): string | undefined {
  const value = log.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericAttribute(log: TraceLog, key: string): number | undefined {
  const value = log.attributes[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanAttribute(log: TraceLog, key: string): boolean | undefined {
  const value = log.attributes[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function hexId(seed: string, length: 16 | 32): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function eventReference(event: CodexEvent): CodexEvidenceReference {
  return {
    eventName: event.name,
    timestamp: new Date(event.timestampMs).toISOString(),
    sourceTraceId: event.log.traceId,
    ...(event.log.spanId ? { sourceSpanId: event.log.spanId } : {}),
  };
}

function sourceAttributes(event: CodexEvent): Record<string, unknown> {
  return {
    "tracey.source.signal": "log",
    "tracey.source.event.name": event.name,
    "tracey.source.trace_id": event.log.traceId,
    ...(event.log.spanId ? { "tracey.source.span_id": event.log.spanId } : {}),
    "tracey.content.capture": "none",
  };
}

function normalizeEvents(search: CodexConversationSearch, logs: TraceLog[]): { events: CodexEvent[]; rejected: number } {
  const events: CodexEvent[] = [];
  let rejected = 0;
  for (const log of logs) {
    const name = stringAttribute(log, "event.name");
    const conversationId = stringAttribute(log, "conversation.id");
    const eventTimestamp = stringAttribute(log, "event.timestamp") ?? log.timestamp;
    const timestampMs = Date.parse(eventTimestamp);
    if (!name?.startsWith("codex.") || conversationId !== search.conversationId || !Number.isFinite(timestampMs)) {
      rejected += 1;
      continue;
    }
    events.push({ log, name, timestampMs });
  }
  events.sort((left, right) => left.timestampMs - right.timestampMs);
  return { events, rejected };
}

function createRun(
  search: CodexConversationSearch,
  events: CodexEvent[],
  turnIndex: number,
  sourceIncomplete: boolean,
): NormalizedCodexRun {
  const prompt = events[0];
  if (!prompt) throw new Error("A Codex turn requires a user-prompt event");
  const completions = events.filter(
    (event) => event.name === "codex.sse_event" && stringAttribute(event.log, "event.kind") === "response.completed",
  );
  const lastCompletion = completions.at(-1);
  const lastEvent = events.at(-1) ?? prompt;
  const endEvent = lastCompletion ?? lastEvent;
  const startedAtMs = prompt.timestampMs;
  const endedAtMs = Math.max(startedAtMs, endEvent.timestampMs);
  const runId = `codex:${search.conversationId}:${turnIndex}`;
  const traceId = hexId(runId, 32);
  const rootSpanId = hexId(`${runId}:root`, 16);
  const model = stringAttribute(prompt.log, "model") ?? stringAttribute(prompt.log, "slug");
  const failed = events.some((event) =>
    (event.name === "codex.api_request" || event.name === "codex.websocket_request") &&
    booleanAttribute(event.log, "success") === false,
  ) && !lastCompletion;
  const status: NormalizedCodexRun["status"] = failed ? "failed" : lastCompletion ? "complete" : "incomplete";
  const root: TraceSpan = {
    traceId,
    spanId: rootSpanId,
    parentSpanId: null,
    name: "agent.run",
    serviceName: prompt.log.serviceName ?? search.serviceName,
    startedAt: new Date(startedAtMs).toISOString(),
    startTimeMs: startedAtMs,
    durationMs: endedAtMs - startedAtMs,
    statusCode: status === "failed" ? "STATUS_CODE_ERROR" : status === "complete" ? "STATUS_CODE_OK" : "STATUS_CODE_UNSET",
    hasError: status === "failed",
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "codex",
      "gen_ai.agent.version": stringAttribute(prompt.log, "app.version") ?? "unknown",
      "gen_ai.conversation.id": search.conversationId,
      "tracey.run.id": runId,
      "tracey.agent.name": "codex",
      "tracey.agent.version": stringAttribute(prompt.log, "app.version") ?? "unknown",
      "tracey.user.outcome": status === "complete" ? "resolved" : status,
      "tracey.normalization.version": CODEX_NORMALIZATION_VERSION,
      "tracey.source.type": "codex_otel_logs",
      "tracey.source.derived_trace_id": true,
      "tracey.source.event.count": events.length,
      "tracey.prompt.length": numericAttribute(prompt.log, "prompt_length") ?? 0,
      ...(model ? { "gen_ai.request.model": model } : {}),
      ...sourceAttributes(prompt),
    },
  };
  const children: TraceSpan[] = [];

  for (const [index, completion] of completions.entries()) {
    const spanId = hexId(`${runId}:model:${index}:${completion.timestampMs}`, 16);
    children.push({
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: `chat ${model ?? "codex-model"}`,
      serviceName: completion.log.serviceName ?? search.serviceName,
      startedAt: new Date(completion.timestampMs).toISOString(),
      startTimeMs: completion.timestampMs,
      durationMs: numericAttribute(completion.log, "duration_ms") ?? 0,
      statusCode: "STATUS_CODE_OK",
      hasError: false,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        ...(model ? { "gen_ai.request.model": model, "gen_ai.response.model": model } : {}),
        "gen_ai.usage.input_tokens": numericAttribute(completion.log, "input_token_count") ?? 0,
        "gen_ai.usage.output_tokens": numericAttribute(completion.log, "output_token_count") ?? 0,
        "gen_ai.usage.cached_input_tokens": numericAttribute(completion.log, "cached_token_count") ?? 0,
        "gen_ai.usage.reasoning_tokens": numericAttribute(completion.log, "reasoning_token_count") ?? 0,
        ...sourceAttributes(completion),
      },
    });
  }

  for (const [index, tool] of events.filter(({ name }) => name === "codex.tool_result").entries()) {
    const durationMs = numericAttribute(tool.log, "duration_ms") ?? 0;
    const success = booleanAttribute(tool.log, "success");
    const toolName = stringAttribute(tool.log, "tool_name") ?? "unknown";
    const startTimeMs = Math.max(startedAtMs, tool.timestampMs - durationMs);
    children.push({
      traceId,
      spanId: hexId(`${runId}:tool:${index}:${tool.timestampMs}:${toolName}`, 16),
      parentSpanId: rootSpanId,
      name: `execute_tool ${toolName}`,
      serviceName: tool.log.serviceName ?? search.serviceName,
      startedAt: new Date(startTimeMs).toISOString(),
      startTimeMs,
      durationMs,
      statusCode: success === false ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
      hasError: success === false,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "tracey.tool.transport": "codex",
        "tracey.tool.side_effect": "unknown",
        "tracey.tool.result.class": success === false ? "upstream_error" : "success",
        ...sourceAttributes(tool),
      },
    });
  }

  for (const [index, decision] of events.filter(({ name }) => name === "codex.tool_decision").entries()) {
    const toolName = stringAttribute(decision.log, "tool_name") ?? "unknown";
    children.push({
      traceId,
      spanId: hexId(`${runId}:decision:${index}:${decision.timestampMs}:${toolName}`, 16),
      parentSpanId: rootSpanId,
      name: "agent.tool_decision",
      serviceName: decision.log.serviceName ?? search.serviceName,
      startedAt: new Date(decision.timestampMs).toISOString(),
      startTimeMs: decision.timestampMs,
      durationMs: 0,
      statusCode: "STATUS_CODE_OK",
      hasError: false,
      attributes: {
        "tracey.decision.type": "approve_tool",
        "tracey.decision.selected": toolName,
        "tracey.codex.tool.decision": stringAttribute(decision.log, "decision") ?? "unknown",
        "tracey.codex.tool.decision.source": stringAttribute(decision.log, "source") ?? "unknown",
        ...sourceAttributes(decision),
      },
    });
  }

  children.sort((left, right) => left.startTimeMs - right.startTimeMs || left.spanId.localeCompare(right.spanId));
  const limitations: string[] = [
    "Trace and span IDs are deterministic Tracey projection IDs because Codex OTel events for one turn can use multiple or empty source trace contexts.",
    "Model-event durations are zero when Codex response.completed does not export a duration; token counts remain observed event values.",
  ];
  if (!lastCompletion) limitations.push("No response.completed event was observed for this turn.");
  if (sourceIncomplete) limitations.push("The SigNoz result was paginated or contained rejected rows.");
  return {
    runId,
    conversationId: search.conversationId,
    turnIndex,
    ...(model ? { model } : {}),
    startedAt: root.startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: root.durationMs,
    status,
    spans: [root, ...children],
    evidence: events.map(eventReference),
    evidenceCompleteness: sourceIncomplete || !lastCompletion ? 0.5 : 1,
    limitations,
  };
}

export function normalizeCodexConversation(
  search: CodexConversationSearch,
  result: TraceLogSearchResult,
): CodexConversationNormalization {
  const normalized = normalizeEvents(search, result.logs);
  const promptIndexes = normalized.events
    .map((event, index) => event.name === "codex.user_prompt" ? index : -1)
    .filter((index) => index >= 0);
  const sourceIncomplete = result.rejectedRows > 0 || result.nextCursor !== undefined || normalized.rejected > 0;
  const runs = promptIndexes.map((start, index) => {
    const end = promptIndexes[index + 1] ?? normalized.events.length;
    return createRun(search, normalized.events.slice(start, end), index + 1, sourceIncomplete);
  });
  return {
    conversationId: search.conversationId,
    normalizationVersion: CODEX_NORMALIZATION_VERSION,
    runs,
    rejectedLogs: result.rejectedRows + normalized.rejected,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    query: result.query,
  };
}
