import { createHash } from "node:crypto";
import { z } from "zod";
import { diagnoseRun, type DiagnosisCategory, type DiagnosisReport } from "@tracey/diagnosis";
import { SpanIdSchema, TraceIdSchema, type TraceLog, type TraceSpan } from "@tracey/domain";
import { analyzeLatency, buildRunGraph } from "@tracey/graph";

export const EvaluationScenarioSchema = z.enum([
  "crm_timeout_retry",
  "empty_retrieval",
  "incorrect_tool_selection",
  "provider_fallback",
  "context_truncation",
  "tool_schema_mismatch",
  "negative_feedback",
]);
export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;

const DiagnosisCategorySchema = z.enum([
  "retry_recovery",
  "retrieval_failure",
  "tool_selection",
  "provider_fallback",
  "context_truncation",
  "schema_mismatch",
  "negative_feedback",
  "tool_failure",
  "span_error",
  "latency",
  "telemetry_quality",
]);

const TraceSpanSchema = z.object({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  parentSpanId: SpanIdSchema.nullable(),
  name: z.string().min(1).max(512),
  serviceName: z.string().min(1).max(256),
  startedAt: z.string().datetime(),
  startTimeMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
  statusCode: z.string().max(128).optional(),
  hasError: z.boolean().optional(),
  attributes: z.record(z.unknown()),
});

const TraceLogSchema = z.object({
  timestamp: z.string().datetime(),
  traceId: TraceIdSchema,
  spanId: SpanIdSchema.optional(),
  severity: z.string().max(64).optional(),
  body: z.string().max(16_384),
  serviceName: z.string().max(256).optional(),
  attributes: z.record(z.unknown()),
});

export const CapturedEvaluationCaseSchema = z.object({
  caseId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  scenario: EvaluationScenarioSchema,
  traceId: TraceIdSchema,
  capture: z.object({
    kind: z.literal("signoz_query_v5"),
    capturedAt: z.string().datetime(),
    deployment: z.string().min(1).max(256),
    environment: z.string().min(1).max(128),
    tenantIdHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    queryStart: z.number().int().nonnegative(),
    queryEnd: z.number().int().positive(),
    payloadSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).refine(({ queryStart, queryEnd }) => queryStart < queryEnd, "queryStart must be before queryEnd"),
  spans: z.array(TraceSpanSchema).min(1).max(10_000),
  logs: z.array(TraceLogSchema).max(1_000),
  expected: z.object({
    primaryCategory: DiagnosisCategorySchema,
    requiredCategories: z.array(DiagnosisCategorySchema).min(1),
    allowedCategories: z.array(DiagnosisCategorySchema).min(1),
  }),
}).superRefine((value, context) => {
  if (value.spans.some(({ traceId }) => traceId !== value.traceId) || value.logs.some(({ traceId }) => traceId !== value.traceId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "All captured signals must share the case traceId" });
  }
  if (!value.spans.some(({ name, parentSpanId }) => name === "agent.run" && parentSpanId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A captured case requires one root agent.run span" });
  }
  if (!value.expected.requiredCategories.includes(value.expected.primaryCategory)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "primaryCategory must be required" });
  }
  if (value.expected.requiredCategories.some((category) => !value.expected.allowedCategories.includes(category))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every required category must also be allowed" });
  }
});
export type CapturedEvaluationCase = z.infer<typeof CapturedEvaluationCaseSchema>;

export const EvaluationDatasetSchema = z.object({
  schemaVersion: z.literal("1.0"),
  datasetId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,127}$/),
  createdAt: z.string().datetime(),
  cases: z.array(CapturedEvaluationCaseSchema).min(1).max(200),
});
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;

export interface CaseEvaluationResult {
  caseId: string;
  scenario: EvaluationScenario;
  traceId: string;
  predictedCategories: DiagnosisCategory[];
  top1Correct: boolean;
  top3Recall: boolean;
  requiredCategoriesPresent: boolean;
  evidenceReferences: number;
  resolvableEvidenceReferences: number;
  falseCausalClaims: number;
  diagnosis: DiagnosisReport;
}

export interface EvaluationReport {
  datasetId: string;
  datasetSize: number;
  capturedFromSigNoz: number;
  scenarioCoverage: Record<EvaluationScenario, number>;
  gates: {
    minimumDatasetSize: { required: number; actual: number; passed: boolean };
    allScenariosCovered: boolean;
    payloadIntegrity: boolean;
  };
  metrics: {
    top1Accuracy: number;
    top3Recall: number;
    requiredCategoryRecall: number;
    evidenceCitationPrecision: number;
    falseCausalClaimRate: number;
  };
  cases: CaseEvaluationResult[];
}

export function capturedPayloadSha256(spans: TraceSpan[], logs: TraceLog[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ spans, logs })).digest("hex")}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function evaluateDataset(input: unknown): EvaluationReport {
  const dataset = EvaluationDatasetSchema.parse(input);
  const scenarioCoverage = Object.fromEntries(
    EvaluationScenarioSchema.options.map((scenario) => [scenario, 0]),
  ) as Record<EvaluationScenario, number>;
  let payloadIntegrity = true;
  const cases = dataset.cases.map((evaluationCase): CaseEvaluationResult => {
    const spans = evaluationCase.spans as TraceSpan[];
    const logs = evaluationCase.logs as TraceLog[];
    scenarioCoverage[evaluationCase.scenario] += 1;
    if (capturedPayloadSha256(spans, logs) !== evaluationCase.capture.payloadSha256) {
      payloadIntegrity = false;
    }
    const diagnosis = diagnoseRun(
      spans,
      analyzeLatency(buildRunGraph(spans)),
      logs,
    );
    const predictedCategories = diagnosis.hypotheses.map(({ category }) => category);
    const evidenceSpanIds = new Set(spans.map(({ spanId }) => spanId));
    let evidenceReferences = 0;
    let resolvableEvidenceReferences = 0;
    for (const hypothesis of diagnosis.hypotheses) {
      for (const evidence of hypothesis.evidence) {
        evidenceReferences += 1;
        if (evidence.traceId === evaluationCase.traceId && evidenceSpanIds.has(evidence.spanId)) {
          resolvableEvidenceReferences += 1;
        }
      }
    }
    return {
      caseId: evaluationCase.caseId,
      scenario: evaluationCase.scenario,
      traceId: evaluationCase.traceId,
      predictedCategories,
      top1Correct: predictedCategories[0] === evaluationCase.expected.primaryCategory,
      top3Recall: predictedCategories.slice(0, 3).includes(evaluationCase.expected.primaryCategory),
      requiredCategoriesPresent: evaluationCase.expected.requiredCategories.every((category) => predictedCategories.includes(category)),
      evidenceReferences,
      resolvableEvidenceReferences,
      falseCausalClaims: diagnosis.hypotheses.filter(({ category }) => !evaluationCase.expected.allowedCategories.includes(category)).length,
      diagnosis,
    };
  });
  const totalEvidence = cases.reduce((sum, item) => sum + item.evidenceReferences, 0);
  const resolvableEvidence = cases.reduce((sum, item) => sum + item.resolvableEvidenceReferences, 0);
  const totalHypotheses = cases.reduce((sum, item) => sum + item.predictedCategories.length, 0);
  const falseClaims = cases.reduce((sum, item) => sum + item.falseCausalClaims, 0);

  return {
    datasetId: dataset.datasetId,
    datasetSize: cases.length,
    capturedFromSigNoz: dataset.cases.length,
    scenarioCoverage,
    gates: {
      minimumDatasetSize: { required: 30, actual: cases.length, passed: cases.length >= 30 },
      allScenariosCovered: Object.values(scenarioCoverage).every((count) => count > 0),
      payloadIntegrity,
    },
    metrics: {
      top1Accuracy: ratio(cases.filter(({ top1Correct }) => top1Correct).length, cases.length),
      top3Recall: ratio(cases.filter(({ top3Recall }) => top3Recall).length, cases.length),
      requiredCategoryRecall: ratio(cases.filter(({ requiredCategoriesPresent }) => requiredCategoriesPresent).length, cases.length),
      evidenceCitationPrecision: ratio(resolvableEvidence, totalEvidence),
      falseCausalClaimRate: ratio(falseClaims, totalHypotheses),
    },
    cases,
  };
}
