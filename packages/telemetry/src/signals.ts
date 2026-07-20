import { metrics, trace, type Counter, type Histogram, type MetricOptions } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export const tracer = trace.getTracer("io.crumbles.tracey", "0.1.0");

function lazyCounter(name: string, options: MetricOptions): Pick<Counter, "add"> {
  let instrument: Counter | undefined;
  return {
    add(...args: Parameters<Counter["add"]>) {
      instrument ??= metrics
        .getMeter("io.crumbles.tracey", "0.1.0")
        .createCounter(name, options);
      instrument.add(...args);
    },
  };
}

function lazyHistogram(name: string, options: MetricOptions): Pick<Histogram, "record"> {
  let instrument: Histogram | undefined;
  return {
    record(...args: Parameters<Histogram["record"]>) {
      instrument ??= metrics
        .getMeter("io.crumbles.tracey", "0.1.0")
        .createHistogram(name, options);
      instrument.record(...args);
    },
  };
}

export const agentRuns = lazyCounter("tracey.agent.runs", {
  description: "Number of completed agent runs",
  unit: "{run}",
});

export const agentRunDuration = lazyHistogram("tracey.agent.run.duration", {
  description: "Agent run wall-clock duration",
  unit: "s",
});

export const inputTokens = lazyCounter("tracey.agent.tokens.input", {
  description: "Input tokens consumed by agent model calls",
  unit: "{token}",
});

export const outputTokens = lazyCounter("tracey.agent.tokens.output", {
  description: "Output tokens consumed by agent model calls",
  unit: "{token}",
});

export const cachedInputTokens = lazyCounter("tracey.agent.tokens.cached_input", {
  description: "Input tokens served from provider prompt cache",
  unit: "{token}",
});

export const reasoningOutputTokens = lazyCounter("tracey.agent.tokens.reasoning_output", {
  description: "Provider-reported reasoning tokens included in output usage",
  unit: "{token}",
});

export const agentCostUsd = lazyCounter("tracey.agent.cost.usd", {
  description: "Exactly attributed agent model cost from a versioned provider catalog",
  unit: "USD",
});

export const toolCalls = lazyCounter("tracey.agent.tool.calls", {
  description: "Number of agent tool calls",
  unit: "{call}",
});

export const toolErrors = lazyCounter("tracey.agent.tool.errors", {
  description: "Number of failed agent tool calls",
  unit: "{call}",
});

export const toolDuration = lazyHistogram("tracey.agent.tool.duration", {
  description: "Agent tool call duration",
  unit: "s",
});

export const retrievalScore = lazyHistogram("tracey.agent.retrieval.score", {
  description: "Highest relevance score returned by retrieval",
  unit: "1",
});

export const emptyRetrievals = lazyCounter("tracey.agent.retrieval.empty", {
  description: "Number of retrieval operations returning no results",
  unit: "{operation}",
});

export const truncatedContexts = lazyCounter("tracey.agent.context.truncated", {
  description: "Number of retrieval contexts truncated before generation",
  unit: "{operation}",
});

export const feedbackEvents = lazyCounter("tracey.agent.feedback", {
  description: "Number of feedback events linked to agent runs",
  unit: "{event}",
});

export const signozAdapterRequests = lazyCounter("tracey.signoz.adapter.requests", {
  description: "Number of bounded SigNoz Query Range operations attempted by Tracey",
  unit: "{request}",
});

export const signozAdapterErrors = lazyCounter("tracey.signoz.adapter.errors", {
  description: "Number of failed SigNoz Query Range operations by classified outcome",
  unit: "{error}",
});

export const signozAdapterDuration = lazyHistogram("tracey.signoz.adapter.duration", {
  description: "Wall-clock duration of SigNoz Query Range operations",
  unit: "s",
});

export const investigationRequests = lazyCounter("tracey.investigation.requests", {
  description: "Number of Tracey investigation operations",
  unit: "{investigation}",
});

export const investigationDuration = lazyHistogram("tracey.investigation.duration", {
  description: "Wall-clock duration of Tracey investigation operations",
  unit: "s",
});

export const diagnosisDuration = lazyHistogram("tracey.investigation.diagnosis.duration", {
  description: "Duration of deterministic graph analysis and diagnosis",
  unit: "s",
});

export const evidenceCompleteness = lazyHistogram("tracey.investigation.evidence.completeness", {
  description: "Computed evidence completeness for successfully analyzed traces",
  unit: "1",
});

export const apiAuthentication = lazyCounter("tracey.api.authentication", {
  description: "Number of Tracey API authentication decisions",
  unit: "{decision}",
});

export function emitOperationalLog(
  severity: "INFO" | "WARN" | "ERROR",
  body: string,
  attributes: Record<string, string | number | boolean>,
): void {
  logs.getLogger("io.crumbles.tracey", "0.1.0").emit({
    severityNumber:
      severity === "ERROR"
        ? SeverityNumber.ERROR
        : severity === "WARN"
          ? SeverityNumber.WARN
          : SeverityNumber.INFO,
    severityText: severity,
    body,
    attributes,
  });
}
