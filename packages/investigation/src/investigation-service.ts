import type {
  AgentRunMetricsResult,
  AgentRunMetricsSearch,
  AgentRunSearchResult,
  AgentProducerType,
  CodexConversationSearch,
  CohortComparisonSearch,
  TraceDetailsSearch,
  TraceLogSearchResult,
  TraceSearch,
} from "@tracey/domain";
import { compareCohorts, type CohortComparisonReport } from "@tracey/cohort";
import {
  normalizeCodexConversation,
  type CodexConversationNormalization,
  type NormalizedCodexRun,
} from "@tracey/codex-normalizer";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { diagnoseRun, type DiagnosisReport } from "@tracey/diagnosis";
import { analyzeLatency, buildRunGraph, RunGraphError, type LatencyAnalysis } from "@tracey/graph";
import type { SigNozAdapter } from "@tracey/signoz-adapter";
import type { CodexRecentLogsSearch } from "@tracey/signoz-adapter";
import {
  diagnosisDuration,
  emitOperationalLog,
  evidenceCompleteness,
  investigationDuration,
  investigationRequests,
  tracer,
} from "@tracey/telemetry";

export class InvestigationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationNotFoundError";
  }
}

export interface TraceInvestigation {
  traceId: string;
  spans: Awaited<ReturnType<SigNozAdapter["getTraceSpans"]>>["spans"];
  logs: TraceLogSearchResult["logs"];
  analysis: LatencyAnalysis | null;
  diagnosis: DiagnosisReport | null;
  evidence: {
    complete: boolean;
    rejectedSpanRows: number;
    rejectedLogRows: number;
    nextCursor?: string;
    issue?: string;
    logsIssue?: string;
  };
  query: {
    traces: Awaited<ReturnType<SigNozAdapter["getTraceSpans"]>>["query"];
    logs?: TraceLogSearchResult["query"];
  };
}

export interface CohortInvestigation {
  comparison: CohortComparisonReport;
  query: {
    baseline: Awaited<ReturnType<SigNozAdapter["searchCohortSpans"]>>["baseline"]["query"];
    candidate: Awaited<ReturnType<SigNozAdapter["searchCohortSpans"]>>["candidate"]["query"];
  };
}

export interface InvestigatedCodexRun extends NormalizedCodexRun {
  analysis: LatencyAnalysis;
  diagnosis: DiagnosisReport;
}

export interface CodexConversationInvestigation
  extends Omit<CodexConversationNormalization, "runs"> {
  runs: InvestigatedCodexRun[];
}

export class InvestigationService {
  constructor(private readonly signoz: SigNozAdapter) {}

  searchAgentRuns(
    input: TraceSearch,
    producerType: AgentProducerType = "custom_otel",
  ): Promise<AgentRunSearchResult> {
    return this.signoz.searchAgentRuns(input, producerType);
  }

  queryAgentRunMetrics(input: AgentRunMetricsSearch): Promise<AgentRunMetricsResult> {
    return this.signoz.queryAgentRunMetrics(input);
  }

  getCodexRecentLogs(input: CodexRecentLogsSearch): Promise<TraceLogSearchResult> {
    return this.signoz.getCodexRecentLogs(input);
  }

  getServiceHealthSnapshot(input: { serviceName: string; start: number; end: number; limit?: number }) {
    return this.signoz.getServiceHealthSnapshot(input);
  }

  async investigateCodexConversation(
    input: CodexConversationSearch,
  ): Promise<CodexConversationInvestigation> {
    const startedAt = performance.now();
    let outcome: "complete" | "incomplete" | "not_found" | "error" = "error";
    investigationRequests.add(1, { "tracey.investigation.operation": "codex_conversation" });
    return tracer.startActiveSpan(
      "tracey.investigate_codex_conversation",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "tracey.codex.conversation_id": input.conversationId,
          "tracey.content.capture": "none",
        },
      },
      async (span) => {
        try {
          const logs = await this.signoz.getCodexConversationLogs(input);
          const normalized = normalizeCodexConversation(input, logs);
          if (normalized.runs.length === 0) {
            throw new InvestigationNotFoundError(
              "No Codex user-prompt events were returned for this conversation and time range",
            );
          }
          const runs = normalized.runs.map((run): InvestigatedCodexRun => {
            const analysis = analyzeLatency(buildRunGraph(run.spans));
            return {
              ...run,
              analysis,
              diagnosis: diagnoseRun(run.spans, analysis),
            };
          });
          outcome = runs.every(({ status, evidenceCompleteness: completeness }) =>
            status === "complete" && completeness === 1
          ) ? "complete" : "incomplete";
          span.setAttribute("tracey.investigation.outcome", outcome);
          span.setAttribute("tracey.codex.normalized_run_count", runs.length);
          span.setStatus({ code: SpanStatusCode.OK });
          return { ...normalized, runs };
        } catch (error) {
          outcome = error instanceof InvestigationNotFoundError ? "not_found" : "error";
          const exception = error instanceof Error ? error : new Error(String(error));
          span.setAttribute("tracey.investigation.outcome", outcome);
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          investigationDuration.record((performance.now() - startedAt) / 1_000, {
            "tracey.investigation.operation": "codex_conversation",
            "tracey.investigation.outcome": outcome,
          });
          span.end();
        }
      },
    );
  }

  async compareCohorts(input: CohortComparisonSearch): Promise<CohortInvestigation> {
    const startedAt = performance.now();
    let outcome: "sufficient" | "insufficient_evidence" | "error" = "error";
    investigationRequests.add(1, { "tracey.investigation.operation": "cohort_comparison" });
    return tracer.startActiveSpan(
      "tracey.compare_cohorts",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "tracey.cohort.dimension": input.dimension,
          "tracey.content.capture": "none",
        },
      },
      async (span) => {
        try {
          const result = await this.signoz.searchCohortSpans(input);
          const comparison = compareCohorts(input, result);
          outcome = comparison.conclusion;
          span.setAttribute("tracey.investigation.outcome", outcome);
          span.setAttribute("tracey.cohort.baseline.sample_size", comparison.baseline.sampleSize);
          span.setAttribute("tracey.cohort.candidate.sample_size", comparison.candidate.sampleSize);
          span.setStatus({ code: SpanStatusCode.OK });
          return {
            comparison,
            query: {
              baseline: result.baseline.query,
              candidate: result.candidate.query,
            },
          };
        } catch (error) {
          const exception = error instanceof Error ? error : new Error(String(error));
          span.setAttribute("tracey.investigation.outcome", "error");
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR });
          emitOperationalLog("ERROR", "Cohort comparison failed", {
            "tracey.investigation.operation": "cohort_comparison",
            "tracey.investigation.outcome": "error",
            "error.type": exception.name,
          });
          throw error;
        } finally {
          investigationDuration.record((performance.now() - startedAt) / 1_000, {
            "tracey.investigation.operation": "cohort_comparison",
            "tracey.investigation.outcome": outcome,
          });
          span.end();
        }
      },
    );
  }

  async investigateTrace(input: TraceDetailsSearch): Promise<TraceInvestigation> {
    const startedAt = performance.now();
    let outcome: "complete" | "incomplete" | "not_found" | "error" = "error";
    investigationRequests.add(1, { "tracey.investigation.operation": "trace_detail" });
    return tracer.startActiveSpan(
      "tracey.investigate_trace",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "tracey.investigated.trace_id": input.traceId,
          "tracey.content.capture": "none",
        },
      },
      async (span) => {
        try {
          const investigation = await this.buildTraceInvestigation(input);
          outcome = investigation.evidence.complete ? "complete" : "incomplete";
          span.setAttribute("tracey.investigation.outcome", outcome);
          if (investigation.analysis) {
            span.setAttribute(
              "tracey.investigation.evidence_completeness",
              investigation.analysis.completenessScore,
            );
            evidenceCompleteness.record(investigation.analysis.completenessScore, {
              "tracey.investigation.outcome": outcome,
            });
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return investigation;
        } catch (error) {
          outcome = error instanceof InvestigationNotFoundError ? "not_found" : "error";
          const exception = error instanceof Error ? error : new Error(String(error));
          span.setAttribute("tracey.investigation.outcome", outcome);
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR });
          emitOperationalLog("ERROR", "Trace investigation failed", {
            "tracey.investigation.operation": "trace_detail",
            "tracey.investigation.outcome": outcome,
            "error.type": exception.name,
          });
          throw error;
        } finally {
          investigationDuration.record((performance.now() - startedAt) / 1_000, {
            "tracey.investigation.operation": "trace_detail",
            "tracey.investigation.outcome": outcome,
          });
          span.end();
        }
      },
    );
  }

  private async buildTraceInvestigation(input: TraceDetailsSearch): Promise<TraceInvestigation> {
    const result = await this.signoz.getTraceSpans(input);
    if (result.spans.length === 0) {
      throw new InvestigationNotFoundError("No spans were returned for this trace and time range");
    }

    let analysis: LatencyAnalysis | null = null;
    let diagnosis: DiagnosisReport | null = null;
    let analysisIssue: string | undefined;
    let logs: TraceLogSearchResult | undefined;
    let logsIssue: string | undefined;
    try {
      logs = await this.signoz.getTraceLogs({ ...input, limit: Math.min(input.limit, 1_000) });
    } catch (error) {
      logsIssue = "Correlated logs were unavailable; span analysis is still based on the returned trace data";
      emitOperationalLog("WARN", "Correlated trace logs were unavailable", {
        "tracey.investigation.operation": "trace_logs",
        "error.type": error instanceof Error ? error.name : "UnknownError",
      });
    }

    if (result.nextCursor) {
      analysisIssue = "Trace exceeds the bounded page size; request the next cursor before treating analysis as complete";
    } else {
      const diagnosisStartedAt = performance.now();
      let diagnosisOutcome: "success" | "invalid_graph" = "success";
      try {
        analysis = analyzeLatency(buildRunGraph(result.spans));
        diagnosis = diagnoseRun(result.spans, analysis, logs?.logs ?? []);
      } catch (error) {
        if (!(error instanceof RunGraphError)) throw error;
        diagnosisOutcome = "invalid_graph";
        analysisIssue = error.message;
      } finally {
        diagnosisDuration.record((performance.now() - diagnosisStartedAt) / 1_000, {
          "tracey.investigation.outcome": diagnosisOutcome,
        });
      }
    }

    return {
      traceId: input.traceId,
      spans: result.spans,
      logs: logs?.logs ?? [],
      analysis,
      diagnosis,
      evidence: {
        complete:
          result.rejectedRows === 0 &&
          (logs?.rejectedRows ?? 0) === 0 &&
          !result.nextCursor &&
          !logs?.nextCursor &&
          analysis !== null &&
          !logsIssue,
        rejectedSpanRows: result.rejectedRows,
        rejectedLogRows: logs?.rejectedRows ?? 0,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...(analysisIssue ? { issue: analysisIssue } : {}),
        ...(logsIssue ? { logsIssue } : {}),
      },
      query: {
        traces: result.query,
        ...(logs ? { logs: logs.query } : {}),
      },
    };
  }
}
