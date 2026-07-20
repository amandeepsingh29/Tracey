import type {
  CohortComparisonSearch,
  CohortSpanSearchResult,
  CohortSpanSet,
  TraceSpan,
} from "@tracey/domain";
import { CohortComparisonSearchSchema, CohortDimensionAttribute } from "@tracey/domain";

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

export interface CohortStatistics {
  value: string;
  sampleSize: number;
  sufficientSample: boolean;
  errorCount: number;
  errorRate: number;
  errorRate95: ConfidenceInterval;
  durationMs: {
    mean: number;
    p50: number;
    p95: number;
  };
  tokens: {
    totalInput: number;
    totalOutput: number;
    meanInput: number;
    meanOutput: number;
  };
  cost: {
    exactSampleSize: number;
    unresolvedSampleSize: number;
    totalUsd: number;
    meanUsd: number | null;
  };
  evidenceTraceIds: string[];
}

export interface NumericDelta {
  absolute: number;
  relative: number | null;
}

export interface CohortComparisonReport {
  dimension: CohortComparisonSearch["dimension"];
  baseline: CohortStatistics;
  candidate: CohortStatistics;
  delta: {
    errorRate: NumericDelta;
    meanDurationMs: NumericDelta;
    p95DurationMs: NumericDelta;
    meanInputTokens: NumericDelta;
    meanOutputTokens: NumericDelta;
    meanCostUsd: NumericDelta | null;
  };
  evidence: {
    complete: boolean;
    baselineRejectedRows: number;
    candidateRejectedRows: number;
    baselineTruncated: boolean;
    candidateTruncated: boolean;
  };
  conclusion: "sufficient" | "insufficient_evidence";
  limitations: string[];
}

function numericAttribute(span: TraceSpan, key: string): number {
  const value = span.attributes[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalNumericAttribute(span: TraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function hasError(span: TraceSpan): boolean {
  const resultClass = span.attributes["tracey.tool.result.class"];
  return (
    span.hasError === true ||
    span.statusCode === "ERROR" ||
    (typeof resultClass === "string" && resultClass !== "success")
  );
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function wilsonInterval(successes: number, sampleSize: number): ConfidenceInterval {
  if (sampleSize === 0) return { lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const proportion = successes / sampleSize;
  const denominator = 1 + (z * z) / sampleSize;
  const center = (proportion + (z * z) / (2 * sampleSize)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / sampleSize + (z * z) / (4 * sampleSize * sampleSize));
  return { lower: round(Math.max(0, center - margin)), upper: round(Math.min(1, center + margin)) };
}

function statistics(
  set: CohortSpanSet,
  input: CohortComparisonSearch,
): CohortStatistics {
  const attribute = CohortDimensionAttribute[input.dimension];
  const spans = set.spans.filter((span) => span.attributes[attribute] === set.value);
  const durations = spans.map((span) => span.durationMs);
  const inputTokens = spans.map((span) => numericAttribute(span, "gen_ai.usage.input_tokens"));
  const outputTokens = spans.map((span) => numericAttribute(span, "gen_ai.usage.output_tokens"));
  const exactCosts = spans.flatMap((span) => {
    if (span.attributes["tracey.cost.attribution"] !== "exact") return [];
    const value = optionalNumericAttribute(span, "tracey.cost.usd");
    return value === undefined ? [] : [value];
  });
  const errorCount = spans.filter(hasError).length;
  return {
    value: set.value,
    sampleSize: spans.length,
    sufficientSample: spans.length >= input.minSampleSize,
    errorCount,
    errorRate: round(spans.length === 0 ? 0 : errorCount / spans.length),
    errorRate95: wilsonInterval(errorCount, spans.length),
    durationMs: {
      mean: round(mean(durations)),
      p50: round(percentile(durations, 0.5)),
      p95: round(percentile(durations, 0.95)),
    },
    tokens: {
      totalInput: inputTokens.reduce((sum, value) => sum + value, 0),
      totalOutput: outputTokens.reduce((sum, value) => sum + value, 0),
      meanInput: round(mean(inputTokens)),
      meanOutput: round(mean(outputTokens)),
    },
    cost: {
      exactSampleSize: exactCosts.length,
      unresolvedSampleSize: spans.length - exactCosts.length,
      totalUsd: round(exactCosts.reduce((sum, value) => sum + value, 0)),
      meanUsd: exactCosts.length === 0 ? null : round(mean(exactCosts)),
    },
    evidenceTraceIds: [...new Set(spans.map((span) => span.traceId))].slice(0, 20),
  };
}

function delta(candidate: number, baseline: number): NumericDelta {
  return {
    absolute: round(candidate - baseline),
    relative: baseline === 0 ? null : round((candidate - baseline) / baseline),
  };
}

export function compareCohorts(
  inputValue: CohortComparisonSearch,
  spans: CohortSpanSearchResult,
): CohortComparisonReport {
  const input = CohortComparisonSearchSchema.parse(inputValue);
  if (spans.dimension !== input.dimension) throw new Error("Cohort result dimension does not match the request");
  if (spans.baseline.value !== input.baseline || spans.candidate.value !== input.candidate) {
    throw new Error("Cohort result values do not match the request");
  }

  const baseline = statistics(spans.baseline, input);
  const candidate = statistics(spans.candidate, input);
  const evidenceComplete =
    spans.baseline.rejectedRows === 0 &&
    spans.candidate.rejectedRows === 0 &&
    !spans.baseline.truncated &&
    !spans.candidate.truncated;
  const limitations: string[] = [];
  if (!baseline.sufficientSample) limitations.push("Baseline cohort is below the configured minimum sample size.");
  if (!candidate.sufficientSample) limitations.push("Candidate cohort is below the configured minimum sample size.");
  if (spans.baseline.truncated || spans.candidate.truncated) {
    limitations.push("At least one cohort reached the configured span cap; statistics cover only the returned window.");
  }
  if (spans.baseline.rejectedRows > 0 || spans.candidate.rejectedRows > 0) {
    limitations.push("Some SigNoz rows failed normalization and were excluded.");
  }
  if (baseline.cost.unresolvedSampleSize > 0 || candidate.cost.unresolvedSampleSize > 0) {
    limitations.push("Cost deltas exclude spans without exact versioned price attribution.");
  }
  limitations.push(
    "This comparison reports observed association, not proof that the selected version caused the difference.",
  );

  return {
    dimension: input.dimension,
    baseline,
    candidate,
    delta: {
      errorRate: delta(candidate.errorRate, baseline.errorRate),
      meanDurationMs: delta(candidate.durationMs.mean, baseline.durationMs.mean),
      p95DurationMs: delta(candidate.durationMs.p95, baseline.durationMs.p95),
      meanInputTokens: delta(candidate.tokens.meanInput, baseline.tokens.meanInput),
      meanOutputTokens: delta(candidate.tokens.meanOutput, baseline.tokens.meanOutput),
      meanCostUsd:
        baseline.cost.meanUsd === null || candidate.cost.meanUsd === null
          ? null
          : delta(candidate.cost.meanUsd, baseline.cost.meanUsd),
    },
    evidence: {
      complete: evidenceComplete,
      baselineRejectedRows: spans.baseline.rejectedRows,
      candidateRejectedRows: spans.candidate.rejectedRows,
      baselineTruncated: spans.baseline.truncated,
      candidateTruncated: spans.candidate.truncated,
    },
    conclusion:
      baseline.sufficientSample && candidate.sufficientSample && evidenceComplete
        ? "sufficient"
        : "insufficient_evidence",
    limitations,
  };
}
