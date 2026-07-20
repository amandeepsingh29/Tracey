import { createHash } from "node:crypto";
import { context, SpanKind, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import {
  agentRunDuration,
  agentRuns,
  agentCostUsd,
  cachedInputTokens,
  emitOperationalLog,
  emptyRetrievals,
  feedbackEvents,
  inputTokens,
  outputTokens,
  reasoningOutputTokens,
  retrievalScore,
  toolCalls,
  toolDuration,
  toolErrors,
  tracer,
  truncatedContexts,
} from "@tracey/telemetry";
import { calculateModelCost } from "@tracey/pricing";

export interface AgentRunOptions {
  runId: string;
  agentName: string;
  agentVersion: string;
  tenantId: string;
  environment: string;
  inputHash: string;
  sessionId?: string;
  workflowName?: string;
  workflowVersion?: string;
}

export interface InstrumentedAgentResult<T> {
  value: T;
  traceId: string;
  spanId: string;
}

export interface ModelCallOptions {
  providerName: string;
  requestModel: string;
  promptName?: string;
  promptVersion?: string;
  operationName?: "chat" | "text_completion" | "generate_content" | "embeddings";
  route?: string;
  openaiApiType?: "responses" | "chat_completions";
}

export interface ModelCallTelemetry {
  responseId?: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  finishReasons?: string[];
}

export interface AgentDecisionOptions {
  decisionType: "route" | "plan" | "select_tool" | "select_model" | "stop" | "escalate";
  selected: string;
  policy: string;
  candidateCount?: number;
  confidence?: number;
  evaluation?: {
    expected?: string;
    correct: boolean;
  };
}

export interface InstrumentedOperationResult<T, TTelemetry> {
  value: T;
  telemetry: TTelemetry;
}

export type ToolSideEffect = "none" | "read" | "write" | "irreversible";
export type ToolResultClass = "success" | "timeout" | "denied" | "invalid" | "upstream_error";

export interface ToolCallOptions<T> {
  toolName: string;
  toolVersion?: string;
  schemaVersion?: string;
  transport: "http" | "grpc" | "mcp" | "in_process";
  mcpServerName?: string;
  mcpServerVersion?: string;
  sideEffect: ToolSideEffect;
  attempt?: number;
  timeoutMs?: number;
  classifyResult?: (result: T) => ToolResultClass;
  classifyError?: (error: unknown) => Exclude<ToolResultClass, "success">;
}

export interface RetrievalOptions {
  retrieverName: string;
  retrieverVersion?: string;
  corpusVersion?: string;
  queryHash?: string;
  topK?: number;
}

export interface RetrievalTelemetry {
  resultCount: number;
  maxScore?: number;
  minScore?: number;
  contextTokens?: number;
  contextTruncated?: boolean;
  permissionFilterApplied?: boolean;
}

export interface FeedbackOptions {
  source: "thumbs_up" | "thumbs_down" | "support_ticket" | "evaluator" | "human_review";
  label: string;
  score?: number;
  reference?: string;
}

export interface ExternalFeedbackOptions extends FeedbackOptions {
  traceId: string;
  spanId: string;
  runId: string;
}

function asException(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedAttributes(values: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  );
}

function hashReference(reference: string | undefined): string | undefined {
  return reference
    ? `sha256:${createHash("sha256").update(reference).digest("hex")}`
    : undefined;
}

export async function withAgentRun<T>(
  options: AgentRunOptions,
  operation: () => Promise<T>,
): Promise<InstrumentedAgentResult<T>> {
  const startedAt = performance.now();
  return tracer.startActiveSpan(
    "agent.run",
    {
      kind: SpanKind.INTERNAL,
      attributes: boundedAttributes({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": options.agentName,
        "gen_ai.agent.version": options.agentVersion,
        "gen_ai.conversation.id": options.sessionId,
        "gen_ai.workflow.name": options.workflowName,
        "tracey.run.id": options.runId,
        "tracey.agent.name": options.agentName,
        "tracey.agent.version": options.agentVersion,
        "tracey.tenant.id": options.tenantId,
        "deployment.environment.name": options.environment,
        "tracey.workflow.name": options.workflowName,
        "tracey.workflow.version": options.workflowVersion,
        "tracey.input.hash": options.inputHash,
        "tracey.content.capture": "none",
      }),
    },
    async (span) => {
      try {
        const value = await operation();
        const spanContext = trace.getSpan(context.active())?.spanContext();
        if (!spanContext) throw new Error("Active trace context is unavailable");
        span.setAttribute("tracey.user.outcome", "resolved");
        span.setStatus({ code: SpanStatusCode.OK });
        agentRuns.add(1, {
          "tracey.agent.name": options.agentName,
          "tracey.user.outcome": "resolved",
        });
        emitOperationalLog("INFO", "Agent run completed", {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
          "tracey.run.id": options.runId,
          "tracey.agent.name": options.agentName,
          "tracey.user.outcome": "resolved",
        });
        return { value, traceId: spanContext.traceId, spanId: spanContext.spanId };
      } catch (error) {
        const exception = asException(error);
        const spanContext = span.spanContext();
        span.setAttribute("tracey.user.outcome", "failed");
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        agentRuns.add(1, {
          "tracey.agent.name": options.agentName,
          "tracey.user.outcome": "failed",
        });
        emitOperationalLog("ERROR", "Agent run failed", {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
          "tracey.run.id": options.runId,
          "tracey.agent.name": options.agentName,
          "tracey.user.outcome": "failed",
          "error.type": exception.name,
        });
        throw error;
      } finally {
        agentRunDuration.record((performance.now() - startedAt) / 1_000, {
          "tracey.agent.name": options.agentName,
        });
        span.end();
      }
    },
  );
}

export async function instrumentModelCall<T>(
  options: ModelCallOptions,
  operation: () => Promise<InstrumentedOperationResult<T, ModelCallTelemetry>>,
): Promise<T> {
  const operationName = options.operationName ?? "chat";
  return tracer.startActiveSpan(
    `${operationName} ${options.requestModel}`,
    {
      kind: SpanKind.CLIENT,
      attributes: boundedAttributes({
        "gen_ai.operation.name": operationName,
        "gen_ai.provider.name": options.providerName,
        "gen_ai.request.model": options.requestModel,
        "tracey.prompt.name": options.promptName,
        "tracey.prompt.version": options.promptVersion,
        "openai.api.type": options.openaiApiType,
        "tracey.model.route": options.route,
        "tracey.content.capture": "none",
      }),
    },
    async (span) => {
      try {
        const { value, telemetry } = await operation();
        span.setAttributes(
          boundedAttributes({
            "gen_ai.response.id": telemetry.responseId,
            "gen_ai.response.model": telemetry.responseModel,
            "gen_ai.usage.input_tokens": telemetry.inputTokens,
            "gen_ai.usage.output_tokens": telemetry.outputTokens,
            "gen_ai.usage.cached_input_tokens": telemetry.cachedInputTokens,
            "gen_ai.usage.reasoning_tokens": telemetry.reasoningOutputTokens,
          }),
        );
        if (telemetry.finishReasons) span.setAttribute("gen_ai.response.finish_reasons", telemetry.finishReasons);
        span.setStatus({ code: SpanStatusCode.OK });
        const metricAttributes = {
          "gen_ai.provider.name": options.providerName,
          "gen_ai.request.model": options.requestModel,
        };
        inputTokens.add(telemetry.inputTokens, metricAttributes);
        outputTokens.add(telemetry.outputTokens, metricAttributes);
        if (telemetry.cachedInputTokens !== undefined) {
          cachedInputTokens.add(telemetry.cachedInputTokens, metricAttributes);
        }
        if (telemetry.reasoningOutputTokens !== undefined) {
          reasoningOutputTokens.add(telemetry.reasoningOutputTokens, metricAttributes);
        }
        const cost = calculateModelCost({
          provider: options.providerName,
          model: telemetry.responseModel,
          inputTokens: telemetry.inputTokens,
          cachedInputTokens: telemetry.cachedInputTokens ?? 0,
          outputTokens: telemetry.outputTokens,
        });
        span.setAttributes({
          "tracey.cost.attribution": cost.status,
          "tracey.cost.catalog.version": cost.catalogVersion,
          "tracey.cost.source": cost.source,
          ...(cost.status === "unresolved"
            ? { "tracey.cost.unresolved.reason": cost.reason }
            : {
                "tracey.cost.currency": cost.currency,
                "tracey.cost.tier": cost.tier,
                "tracey.cost.nano_usd": cost.totalCostNanoUsd,
                "tracey.cost.usd": cost.totalCostUsd,
                "tracey.cost.input.nano_usd": cost.inputCostNanoUsd,
                "tracey.cost.cached_input.nano_usd": cost.cachedInputCostNanoUsd,
                "tracey.cost.output.nano_usd": cost.outputCostNanoUsd,
              }),
        });
        if (cost.status === "exact") {
          agentCostUsd.add(cost.totalCostUsd, {
            "gen_ai.provider.name": cost.provider,
            "gen_ai.response.model": cost.model,
            "tracey.cost.catalog.version": cost.catalogVersion,
          });
        }
        return value;
      } catch (error) {
        span.recordException(asException(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: asException(error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export async function instrumentAgentDecision<T>(
  options: AgentDecisionOptions,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    "agent.decision",
    {
      kind: SpanKind.INTERNAL,
      attributes: boundedAttributes({
        "tracey.decision.type": options.decisionType,
        "tracey.decision.selected": options.selected,
        "tracey.decision.policy": options.policy,
        "tracey.decision.candidate_count": options.candidateCount,
        "tracey.decision.confidence": options.confidence,
        "tracey.decision.expected": options.evaluation?.expected,
        "tracey.decision.correct": options.evaluation?.correct,
        "tracey.content.capture": "none",
      }),
    },
    async (span) => {
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(asException(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: asException(error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function classifyDefaultToolError(error: unknown): Exclude<ToolResultClass, "success"> {
  const value = asException(error);
  if (value.name === "AbortError" || /timeout|timed out/i.test(value.message)) return "timeout";
  return "upstream_error";
}

export async function instrumentToolCall<T>(
  options: ToolCallOptions<T>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  return tracer.startActiveSpan(
    `execute_tool ${options.toolName}`,
    {
      kind: options.transport === "in_process" ? SpanKind.INTERNAL : SpanKind.CLIENT,
      attributes: boundedAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": options.toolName,
        "tracey.tool.version": options.toolVersion,
        "tracey.tool.schema.version": options.schemaVersion,
        "tracey.tool.transport": options.transport,
        "tracey.mcp.server.name": options.mcpServerName,
        "tracey.mcp.server.version": options.mcpServerVersion,
        "tracey.tool.side_effect": options.sideEffect,
        "tracey.tool.attempt": options.attempt,
        "tracey.tool.timeout_ms": options.timeoutMs,
        "tracey.content.capture": "none",
      }),
    },
    async (span) => {
      let resultClass: ToolResultClass = "success";
      try {
        const result = await operation();
        resultClass = options.classifyResult?.(result) ?? "success";
        span.setAttribute("tracey.tool.result.class", resultClass);
        span.setStatus({ code: resultClass === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        if (resultClass !== "success") {
          toolErrors.add(1, {
            "gen_ai.tool.name": options.toolName,
            "tracey.tool.result.class": resultClass,
          });
        }
        return result;
      } catch (error) {
        resultClass = options.classifyError?.(error) ?? classifyDefaultToolError(error);
        span.setAttribute("tracey.tool.result.class", resultClass);
        span.recordException(asException(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: asException(error).message });
        toolErrors.add(1, {
          "gen_ai.tool.name": options.toolName,
          "tracey.tool.result.class": resultClass,
        });
        throw error;
      } finally {
        const metricAttributes = {
          "gen_ai.tool.name": options.toolName,
          "tracey.tool.result.class": resultClass,
        };
        toolCalls.add(1, metricAttributes);
        toolDuration.record((performance.now() - startedAt) / 1_000, metricAttributes);
        span.end();
      }
    },
  );
}

export async function instrumentRetrieval<T>(
  options: RetrievalOptions,
  operation: () => Promise<InstrumentedOperationResult<T, RetrievalTelemetry>>,
): Promise<T> {
  return tracer.startActiveSpan(
    `retrieval ${options.retrieverName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: boundedAttributes({
        "gen_ai.operation.name": "retrieval",
        "tracey.retriever.name": options.retrieverName,
        "tracey.retriever.version": options.retrieverVersion,
        "tracey.corpus.version": options.corpusVersion,
        "tracey.query.hash": options.queryHash,
        "tracey.top_k": options.topK,
        "tracey.content.capture": "none",
      }),
    },
    async (span) => {
      try {
        const { value, telemetry } = await operation();
        span.setAttributes(
          boundedAttributes({
            "tracey.result.count": telemetry.resultCount,
            "tracey.result.max_score": telemetry.maxScore,
            "tracey.result.min_score": telemetry.minScore,
            "tracey.context.tokens": telemetry.contextTokens,
            "tracey.context.truncated": telemetry.contextTruncated,
            "tracey.permission.filter": telemetry.permissionFilterApplied,
          }),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        const attributes = { "tracey.retriever.name": options.retrieverName };
        if (telemetry.maxScore !== undefined) retrievalScore.record(telemetry.maxScore, attributes);
        if (telemetry.resultCount === 0) emptyRetrievals.add(1, attributes);
        if (telemetry.contextTruncated) truncatedContexts.add(1, attributes);
        return value;
      } catch (error) {
        span.recordException(asException(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: asException(error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function recordAgentFeedback(options: FeedbackOptions): void {
  const span = trace.getSpan(context.active());
  const attributes = boundedAttributes({
    "tracey.feedback.source": options.source,
    "tracey.feedback.label": options.label,
    "tracey.feedback.score": options.score,
    "tracey.feedback.reference": hashReference(options.reference),
  });
  span?.addEvent("agent.feedback", attributes);
  feedbackEvents.add(1, {
    "tracey.feedback.source": options.source,
    "tracey.feedback.label": options.label,
  });
}

export function recordExternalAgentFeedback(options: ExternalFeedbackOptions): void {
  const correlationContext = trace.setSpanContext(context.active(), {
    traceId: options.traceId,
    spanId: options.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  context.with(correlationContext, () => {
    emitOperationalLog("INFO", "Agent feedback received", {
      trace_id: options.traceId,
      span_id: options.spanId,
      "tracey.run.id": options.runId,
      "tracey.feedback.source": options.source,
      "tracey.feedback.label": options.label,
      ...(options.score === undefined ? {} : { "tracey.feedback.score": options.score }),
      ...(options.reference ? { "tracey.feedback.reference": hashReference(options.reference) ?? "" } : {}),
    });
    feedbackEvents.add(1, {
      "tracey.feedback.source": options.source,
      "tracey.feedback.label": options.label,
    });
  });
}
