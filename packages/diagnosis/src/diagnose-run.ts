import type { TraceLog, TraceSpan } from "@tracey/domain";
import type { LatencyAnalysis } from "@tracey/graph";

export type DiagnosisCategory =
  | "retry_recovery"
  | "retrieval_failure"
  | "tool_selection"
  | "provider_fallback"
  | "context_truncation"
  | "schema_mismatch"
  | "negative_feedback"
  | "tool_failure"
  | "span_error"
  | "latency"
  | "telemetry_quality";

export interface DiagnosisEvidence {
  traceId: string;
  spanId: string;
  observation: string;
  signal?: "span" | "log";
}

export interface DiagnosisHypothesis {
  category: DiagnosisCategory;
  claim: string;
  confidence: number;
  evidence: DiagnosisEvidence[];
  limitation: string;
}

export interface DiagnosisRecommendation {
  action: string;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
}

export interface DiagnosisReport {
  summary: string;
  hypotheses: DiagnosisHypothesis[];
  recommendations: DiagnosisRecommendation[];
  evidenceCompleteness: number;
}

function stringAttribute(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericAttribute(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanAttribute(span: TraceSpan, key: string): boolean | undefined {
  const value = span.attributes[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function isError(span: TraceSpan): boolean {
  const resultClass = stringAttribute(span, "tracey.tool.result.class");
  return span.hasError === true || span.statusCode === "ERROR" || (resultClass !== undefined && resultClass !== "success");
}

function confidence(base: number, completeness: number): number {
  return Math.round(Math.min(1, Math.max(0, base * completeness)) * 100) / 100;
}

function spanReference(span: TraceSpan, observation: string): DiagnosisEvidence {
  return { traceId: span.traceId, spanId: span.spanId, observation, signal: "span" };
}

export function diagnoseRun(spans: TraceSpan[], analysis: LatencyAnalysis, logs: TraceLog[] = []): DiagnosisReport {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const onCriticalPath = new Set(analysis.criticalPathSpanIds);
  const hypotheses: DiagnosisHypothesis[] = [];
  const recommendations: DiagnosisRecommendation[] = [];

  const toolSpans = spans
    .filter((span) => stringAttribute(span, "gen_ai.operation.name") === "execute_tool" || stringAttribute(span, "gen_ai.tool.name") !== undefined)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);

  for (const timedOut of toolSpans.filter((span) => stringAttribute(span, "tracey.tool.result.class") === "timeout")) {
    const toolName = stringAttribute(timedOut, "gen_ai.tool.name") ?? timedOut.name;
    const timedOutAttempt = numericAttribute(timedOut.attributes, "tracey.tool.attempt");
    const recovered = toolSpans.find((candidate) => {
      const candidateName = stringAttribute(candidate, "gen_ai.tool.name") ?? candidate.name;
      const candidateAttempt = numericAttribute(candidate.attributes, "tracey.tool.attempt");
      return candidate.spanId !== timedOut.spanId &&
        candidateName === toolName &&
        candidate.startTimeMs >= timedOut.startTimeMs &&
        stringAttribute(candidate, "tracey.tool.result.class") === "success" &&
        (timedOutAttempt === undefined || candidateAttempt === undefined || candidateAttempt > timedOutAttempt);
    });
    if (!recovered) continue;
    hypotheses.push({
      category: "retry_recovery",
      claim: `Tool ${toolName} timed out and a later attempt succeeded, so the run contains an observed retry recovery.`,
      confidence: confidence(0.99, analysis.completenessScore),
      evidence: [
        spanReference(timedOut, `resultClass=timeout, attempt=${timedOutAttempt ?? "unknown"}, durationMs=${timedOut.durationMs}`),
        spanReference(recovered, `resultClass=success, attempt=${numericAttribute(recovered.attributes, "tracey.tool.attempt") ?? "unknown"}, durationMs=${recovered.durationMs}`),
      ],
      limitation: "The trace proves timeout followed by success for the same tool; it does not prove that retrying is safe for every input.",
    });
    recommendations.push({
      action: `Review ${toolName} timeout and retry thresholds while preserving its side-effect and idempotency safeguards.`,
      risk: "medium",
      requiresApproval: true,
    });
  }

  for (const retrieval of spans.filter((span) => stringAttribute(span, "gen_ai.operation.name") === "retrieval")) {
    if (numericAttribute(retrieval.attributes, "tracey.result.count") !== 0) continue;
    const retriever = stringAttribute(retrieval, "tracey.retriever.name") ?? retrieval.name;
    hypotheses.push({
      category: "retrieval_failure",
      claim: `Retriever ${retriever} returned zero sources, leaving subsequent generation without retrieved evidence from this operation.`,
      confidence: confidence(0.98, analysis.completenessScore),
      evidence: [spanReference(retrieval, "tracey.result.count=0")],
      limitation: "An empty result is observed; whether the final answer is unsupported requires a separate groundedness evaluation.",
    });
    recommendations.push({
      action: `Add a zero-result gate for ${retriever} that refuses, escalates, or switches to an approved source instead of answering without retrieval evidence.`,
      risk: "medium",
      requiresApproval: true,
    });
  }

  for (const decision of spans.filter((span) => stringAttribute(span, "tracey.decision.type") === "select_tool")) {
    const selected = stringAttribute(decision, "tracey.decision.selected");
    const expected = stringAttribute(decision, "tracey.decision.expected");
    const explicitlyCorrect = booleanAttribute(decision, "tracey.decision.correct");
    if (explicitlyCorrect !== false && (!selected || !expected || selected === expected)) continue;
    const decisionFinding = explicitlyCorrect === false
      ? `The tool-selection evaluator marked ${selected ?? "the selected tool"} as incorrect`
      : `The selected tool ${selected ?? "unknown"} differs from the recorded expected tool`;
    hypotheses.push({
      category: "tool_selection",
      claim: `${decisionFinding}${expected ? `; the expected tool was ${expected}` : ""}.`,
      confidence: confidence(0.97, analysis.completenessScore),
      evidence: [spanReference(decision, `selected=${selected ?? "unknown"}, expected=${expected ?? "not_recorded"}, correct=${explicitlyCorrect ?? "not_recorded"}`)],
      limitation: "Correctness comes from the recorded deterministic evaluator or policy label; Tracey does not infer the intended tool from private reasoning.",
    });
    recommendations.push({
      action: "Inspect the versioned routing policy and tool descriptions before changing model or prompt behavior.",
      risk: "low",
      requiresApproval: false,
    });
  }

  const modelSpans = spans
    .filter((span) => {
      const operation = stringAttribute(span, "gen_ai.operation.name");
      return operation === "chat" || operation === "text_completion" || operation === "generate_content";
    })
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  for (const fallback of modelSpans.filter((span) => stringAttribute(span, "tracey.model.route") === "fallback" && !isError(span))) {
    const failedPrimary = modelSpans.find((span) => span.startTimeMs <= fallback.startTimeMs && span.spanId !== fallback.spanId && isError(span));
    if (!failedPrimary) continue;
    hypotheses.push({
      category: "provider_fallback",
      claim: `Model ${stringAttribute(fallback, "gen_ai.response.model") ?? stringAttribute(fallback, "gen_ai.request.model") ?? fallback.name} completed on the fallback route after an earlier model call failed.`,
      confidence: confidence(0.98, analysis.completenessScore),
      evidence: [
        spanReference(failedPrimary, `model call failed; route=${stringAttribute(failedPrimary, "tracey.model.route") ?? "primary_or_unspecified"}`),
        spanReference(fallback, "tracey.model.route=fallback, status=success"),
      ],
      limitation: "Fallback execution is observed; cost impact cannot be claimed until a versioned provider price resolves both models.",
    });
    recommendations.push({
      action: "Compare fallback reliability, latency, and versioned cost before changing provider routing policy.",
      risk: "medium",
      requiresApproval: true,
    });
  }

  for (const retrieval of spans.filter((span) => booleanAttribute(span, "tracey.context.truncated") === true)) {
    hypotheses.push({
      category: "context_truncation",
      claim: `${retrieval.name} recorded context truncation before generation.`,
      confidence: confidence(0.99, analysis.completenessScore),
      evidence: [spanReference(retrieval, `tracey.context.truncated=true, contextTokens=${numericAttribute(retrieval.attributes, "tracey.context.tokens") ?? "unknown"}`)],
      limitation: "Truncation is observed, but its effect on answer quality requires an output evaluation.",
    });
    recommendations.push({
      action: "Review retrieval chunking, reranking, and context budget before increasing the model context limit.",
      risk: "low",
      requiresApproval: false,
    });
  }

  for (const invalidTool of toolSpans.filter((span) => stringAttribute(span, "tracey.tool.result.class") === "invalid")) {
    const toolName = stringAttribute(invalidTool, "gen_ai.tool.name") ?? invalidTool.name;
    hypotheses.push({
      category: "schema_mismatch",
      claim: `Tool ${toolName} rejected the call as invalid${stringAttribute(invalidTool, "tracey.tool.schema.version") ? ` under schema ${stringAttribute(invalidTool, "tracey.tool.schema.version")}` : ""}.`,
      confidence: confidence(0.98, analysis.completenessScore),
      evidence: [spanReference(invalidTool, `resultClass=invalid, schemaVersion=${stringAttribute(invalidTool, "tracey.tool.schema.version") ?? "not_recorded"}`)],
      limitation: "The invalid result is observed; proving the exact field mismatch requires a redacted validation record or secure payload reference.",
    });
    recommendations.push({
      action: `Compare the caller contract with the deployed ${toolName} schema version before retrying.`,
      risk: "low",
      requiresApproval: false,
    });
  }

  const rootSpanId = analysis.rootSpanId;
  for (const log of logs) {
    const source = typeof log.attributes["tracey.feedback.source"] === "string" ? log.attributes["tracey.feedback.source"] : undefined;
    const label = typeof log.attributes["tracey.feedback.label"] === "string" ? log.attributes["tracey.feedback.label"] : undefined;
    const score = numericAttribute(log.attributes, "tracey.feedback.score");
    const negative = source === "thumbs_down" || (score !== undefined && score < 0) || ["hallucination", "wrong_tool", "slow", "unsafe"].includes(label ?? "");
    if (!negative) continue;
    hypotheses.push({
      category: "negative_feedback",
      claim: `Negative ${source ?? "user"} feedback${label ? ` labeled ${label}` : ""} is linked to this trace.`,
      confidence: 1,
      evidence: [{
        traceId: log.traceId,
        spanId: log.spanId ?? rootSpanId,
        observation: `source=${source ?? "unknown"}, label=${label ?? "unknown"}, score=${score ?? "not_recorded"}`,
        signal: "log",
      }],
      limitation: "Feedback proves a reported outcome, not which upstream operation caused it.",
    });
  }

  const failedSpans = spans.filter((span) => {
    return isError(span);
  });

  for (const span of failedSpans) {
    const operation = stringAttribute(span, "gen_ai.operation.name");
    const toolName = stringAttribute(span, "gen_ai.tool.name");
    const resultClass = stringAttribute(span, "tracey.tool.result.class");
    const critical = onCriticalPath.has(span.spanId);
    const isTool = operation === "execute_tool" || toolName !== undefined;
    const subject = toolName ?? span.name;
    hypotheses.push({
      category: isTool ? "tool_failure" : "span_error",
      claim: `${isTool ? "Tool" : "Span"} ${subject} ended with ${resultClass ?? span.statusCode ?? "an error"}${critical ? " on the computed critical path" : ""}.`,
      confidence: confidence(critical ? 0.98 : 0.9, analysis.completenessScore),
      evidence: [
        spanReference(
          span,
          `hasError=${String(span.hasError ?? false)}, status=${span.statusCode ?? "unknown"}, resultClass=${resultClass ?? "unknown"}, durationMs=${span.durationMs}`,
        ),
      ],
      limitation: critical
        ? "The trace proves the error and timing relationship; external dependency causality still requires downstream evidence."
        : "The error is observed, but it is not on the computed critical path and may have been recovered.",
    });

    if (isTool) {
      recommendations.push({
        action: `Inspect ${subject} dependency telemetry and its timeout/retry policy before changing agent behavior.`,
        risk: "low",
        requiresApproval: false,
      });
      const sideEffect = stringAttribute(span, "tracey.tool.side_effect");
      if (sideEffect === "write" || sideEffect === "irreversible") {
        recommendations.push({
          action: `Do not automatically retry ${subject} until its side-effect and idempotency guarantees are verified.`,
          risk: "high",
          requiresApproval: true,
        });
      }
    }
  }

  const root = byId.get(analysis.rootSpanId);
  const latencyCandidate = analysis.criticalPathSpanIds
    .filter((spanId) => spanId !== analysis.rootSpanId)
    .map((spanId) => byId.get(spanId))
    .filter((span): span is TraceSpan => span !== undefined)
    .sort((left, right) => right.durationMs - left.durationMs)[0];
  if (latencyCandidate && analysis.wallClockMs > 0) {
    const share = latencyCandidate.durationMs / analysis.wallClockMs;
    if (share >= 0.2) {
      hypotheses.push({
        category: "latency",
        claim: `${latencyCandidate.name} occupies ${latencyCandidate.durationMs.toFixed(1)} ms (${(share * 100).toFixed(1)}%) of the root run wall time and lies on the computed critical path.`,
        confidence: confidence(0.95, analysis.completenessScore),
        evidence: [
          spanReference(
            latencyCandidate,
            `spanDurationMs=${latencyCandidate.durationMs}, rootWallClockMs=${analysis.wallClockMs}, criticalPath=true`,
          ),
        ],
        limitation: "This is exact timing attribution from span intervals, not proof that the operation's downstream system is the root cause.",
      });
    }
  }

  if (analysis.orphanSpanIds.length > 0 || analysis.additionalRootSpanIds.length > 0) {
    const affected = [...analysis.orphanSpanIds, ...analysis.additionalRootSpanIds];
    const evidence = affected
      .map((spanId) => byId.get(spanId))
      .filter((span): span is TraceSpan => span !== undefined)
      .map((span) => spanReference(span, `parentSpanId=${span.parentSpanId ?? "none"}`));
    hypotheses.push({
      category: "telemetry_quality",
      claim: `${affected.length} span(s) are disconnected from the selected root, so causal analysis is incomplete.`,
      confidence: 1,
      evidence,
      limitation: "Disconnected spans may represent missing W3C context propagation, sampling, or multiple operations returned by the query.",
    });
    recommendations.push({
      action: "Verify W3C trace-context propagation at the disconnected service boundaries before relying on causal conclusions.",
      risk: "low",
      requiresApproval: false,
    });
  }

  const order: Record<DiagnosisCategory, number> = {
    retry_recovery: 0,
    retrieval_failure: 1,
    tool_selection: 2,
    provider_fallback: 3,
    context_truncation: 4,
    schema_mismatch: 5,
    negative_feedback: 6,
    tool_failure: 7,
    span_error: 8,
    latency: 9,
    telemetry_quality: 10,
  };
  hypotheses.sort((left, right) => order[left.category] - order[right.category] || right.confidence - left.confidence);

  const primary = hypotheses[0];
  const summary = primary
    ? primary.claim
    : root
      ? `No deterministic failure or dominant child span was identified for ${root.name}; inspect the cited spans before forming a causal claim.`
      : "No deterministic diagnosis is available because the selected root span is missing.";

  return {
    summary,
    hypotheses,
    recommendations: recommendations.filter(
      (item, index, all) => all.findIndex((candidate) => candidate.action === item.action) === index,
    ),
    evidenceCompleteness: analysis.completenessScore,
  };
}
