import type {
  AgentRunMetricsResult,
  AgentRunMetricsSearch,
  AgentRunSearchResult,
  AgentRunSummary,
  AgentProducerType,
  CohortComparisonSearch,
  CohortSpanSearchResult,
  CohortSpanSet,
  CodexConversationSearch,
  QueryExecutionMetadata,
  TraceDetailsSearch,
  TraceLog,
  TraceLogSearchResult,
  TraceSearch,
  TraceSpan,
  TraceSpanSearchResult,
  TelemetryScope,
} from "@tracey/domain";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AgentRunMetricsSearchSchema,
  CodexConversationSearchSchema,
  CohortComparisonSearchSchema,
  CohortDimensionAttribute,
  TelemetryScopeSchema,
  TraceDetailsSearchSchema,
  TraceSearchSchema,
} from "@tracey/domain";
import {
  emitOperationalLog,
  signozAdapterDuration,
  signozAdapterErrors,
  signozAdapterRequests,
  tracer,
} from "@tracey/telemetry";
import { z } from "zod";

export interface SigNozAdapterConfig {
  baseUrl: string;
  apiKey: string;
  scope: TelemetryScope;
  timeoutMs?: number;
  cohortTimeoutMs?: number;
}

export interface CodexRecentLogsSearch {
  start: number;
  end: number;
  serviceName: "codex-app-server" | "Codex Desktop";
  limit?: number;
  cursor?: string;
}

const CodexRecentLogsSearchSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  serviceName: z.enum(["codex-app-server", "Codex Desktop"]),
  limit: z.number().int().min(1).max(1_000).default(500),
  cursor: z.string().min(1).max(2_000).optional(),
}).refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000, "invalid or excessive Codex log window");

function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export type SigNozQueryOperation =
  | "search_agent_runs"
  | "trace_spans"
  | "trace_logs"
  | "codex_logs"
  | "agent_run_metrics"
  | "service_health"
  | "cohort_spans";
export type SigNozQueryOutcome =
  | "success"
  | "invalid_request"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "internal_error";

interface SigNozAdapterErrorOptions extends ErrorOptions {
  kind?: Exclude<SigNozQueryOutcome, "success" | "invalid_request" | "internal_error">;
}

export class SigNozAdapterError extends Error {
  readonly kind: Exclude<SigNozQueryOutcome, "success" | "invalid_request" | "internal_error">;

  constructor(
    message: string,
    readonly statusCode?: number,
    options?: SigNozAdapterErrorOptions,
  ) {
    super(message, options);
    this.name = "SigNozAdapterError";
    this.kind = options?.kind ?? (statusCode === undefined ? "network_error" : "http_error");
  }
}

export function classifySigNozQueryError(error: unknown): Exclude<SigNozQueryOutcome, "success"> {
  if (error instanceof SigNozAdapterError) return error.kind;
  if (error instanceof z.ZodError) return "invalid_request";
  return "internal_error";
}

export function buildSigNozMetricAttributes(
  operation: SigNozQueryOperation,
  outcome?: SigNozQueryOutcome,
): Record<string, string> {
  return {
    "tracey.signoz.operation": operation,
    ...(outcome ? { "tracey.signoz.outcome": outcome } : {}),
  };
}

const RawRowSchema = z
  .object({
    timestamp: z.string(),
    data: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const RawResultSchema = z
  .object({
    queryName: z.string().optional(),
    nextCursor: z.string().optional(),
    rows: z.array(RawRowSchema).nullable().optional(),
  })
  .passthrough();

const SigNozRawResponseSchema = z
  .object({
    status: z.string(),
    data: z
      .object({
        type: z.literal("raw"),
        data: z
          .object({
            results: z.array(RawResultSchema).nullable().optional(),
          })
          .passthrough(),
        meta: z
          .object({
            rowsScanned: z.number().nonnegative().optional(),
            bytesScanned: z.number().nonnegative().optional(),
            durationMs: z.number().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const MetricLabelSchema = z.object({
  key: z.object({ name: z.string() }).passthrough(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const MetricSeriesSchema = z.object({
  labels: z.array(MetricLabelSchema).optional(),
  values: z
    .array(
      z.object({
        timestamp: z.number(),
        value: z.number(),
      }),
    )
    .nullable()
    .optional(),
});

const SigNozTimeSeriesResponseSchema = z
  .object({
    status: z.string(),
    data: z
      .object({
        type: z.literal("time_series"),
        data: z
          .object({
            results: z
              .array(
                z.object({
                  queryName: z.string().optional(),
                  aggregations: z
                    .array(
                      z.object({
                        series: z.array(MetricSeriesSchema).nullable().optional(),
                      }),
                    )
                    .nullable()
                    .optional(),
                }),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
        meta: z
          .object({
            rowsScanned: z.number().nonnegative().optional(),
            bytesScanned: z.number().nonnegative().optional(),
            durationMs: z.number().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type RawRow = z.infer<typeof RawRowSchema>;
type RawResponse = z.infer<typeof SigNozRawResponseSchema>;
type TimeSeriesResponse = z.infer<typeof SigNozTimeSeriesResponseSchema>;

const traceSelectFields = [
  { name: "trace_id", fieldContext: "span", fieldDataType: "string" },
  { name: "span_id", fieldContext: "span", fieldDataType: "string" },
  { name: "parent_span_id", fieldContext: "span", fieldDataType: "string" },
  { name: "name", fieldContext: "span", fieldDataType: "string" },
  { name: "duration_nano", fieldContext: "span", fieldDataType: "int64" },
  { name: "status_code", fieldContext: "span", fieldDataType: "string" },
  { name: "has_error", fieldContext: "span", fieldDataType: "bool" },
  { name: "service.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "deployment.environment.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.tenant.id", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.run.id", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.agent.name", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.agent.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.user.outcome", fieldContext: "span", fieldDataType: "string" },
  { name: "gen_ai.operation.name", fieldContext: "span", fieldDataType: "string" },
  { name: "gen_ai.provider.name", fieldContext: "span", fieldDataType: "string" },
  { name: "gen_ai.request.model", fieldContext: "span", fieldDataType: "string" },
  { name: "gen_ai.response.model", fieldContext: "span", fieldDataType: "string" },
  { name: "gen_ai.usage.input_tokens", fieldContext: "span", fieldDataType: "int64" },
  { name: "gen_ai.usage.output_tokens", fieldContext: "span", fieldDataType: "int64" },
  { name: "gen_ai.tool.name", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.prompt.name", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.prompt.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.tool.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.tool.schema.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.tool.attempt", fieldContext: "span", fieldDataType: "int64" },
  { name: "tracey.tool.side_effect", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.tool.result.class", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.model.route", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.content.capture", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.content.input", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.content.output", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.decision.type", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.decision.selected", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.decision.policy", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.decision.expected", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.decision.correct", fieldContext: "span", fieldDataType: "bool" },
  { name: "tracey.retriever.name", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.retriever.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.corpus.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.result.count", fieldContext: "span", fieldDataType: "int64" },
  { name: "tracey.result.max_score", fieldContext: "span", fieldDataType: "float64" },
  { name: "tracey.context.tokens", fieldContext: "span", fieldDataType: "int64" },
  { name: "tracey.context.truncated", fieldContext: "span", fieldDataType: "bool" },
  { name: "tracey.cost.attribution", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.cost.catalog.version", fieldContext: "span", fieldDataType: "string" },
  { name: "tracey.cost.nano_usd", fieldContext: "span", fieldDataType: "int64" },
  { name: "tracey.cost.usd", fieldContext: "span", fieldDataType: "float64" },
] as const;

const serviceHealthSelectFields = [
  { name: "duration_nano", fieldContext: "span", fieldDataType: "int64" },
  { name: "status_code", fieldContext: "span", fieldDataType: "string" },
  { name: "has_error", fieldContext: "span", fieldDataType: "bool" },
  { name: "service.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "deployment.environment.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.tenant.id", fieldContext: "resource", fieldDataType: "string" },
] as const;

export interface ServiceHealthSnapshot {
  serviceName: string;
  window: { start: number; end: number };
  totalSpans: number;
  errorSpans: number;
  errorRate: number;
  p95LatencyMs: number;
  rejectedRows: number;
  truncated: boolean;
  query: QueryExecutionMetadata;
}

// SigNoz rejects a query when any selected custom attribute has never appeared in
// the workspace. Native Claude roots therefore use only stable intrinsic/resource
// fields; child trace queries can fetch producer-specific evidence after discovery.
const nativeRootSelectFields = traceSelectFields.slice(0, 10);
const customRootSelectFields = [
  ...traceSelectFields.slice(0, 10),
  ...traceSelectFields.slice(10, 15),
] as const;

function missingSelectedField(responseText: string): string | undefined {
  try {
    const payload = JSON.parse(responseText) as { error?: { message?: unknown } };
    const message = typeof payload.error?.message === "string" ? payload.error.message : "";
    return /field [`']([^`']+)[`'] not found/.exec(message)?.[1];
  } catch {
    return undefined;
  }
}

function withoutSelectedField(payload: unknown, fieldName: string): unknown | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const cloned = structuredClone(payload) as {
    compositeQuery?: { queries?: Array<{ spec?: { selectFields?: Array<{ name?: unknown }> } }> };
  };
  let removed = false;
  for (const query of cloned.compositeQuery?.queries ?? []) {
    const fields = query.spec?.selectFields;
    if (!fields) continue;
    const filtered = fields.filter(({ name }) => name !== fieldName);
    if (filtered.length !== fields.length) {
      query.spec!.selectFields = filtered;
      removed = true;
    }
  }
  return removed ? cloned : undefined;
}

const logSelectFields = [
  { name: "trace_id", fieldContext: "log", fieldDataType: "string" },
  { name: "span_id", fieldContext: "log", fieldDataType: "string" },
  { name: "severity_text", fieldContext: "log", fieldDataType: "string" },
  { name: "body", fieldContext: "body", fieldDataType: "string" },
  { name: "service.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "deployment.environment.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.tenant.id", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.run.id", fieldContext: "attribute", fieldDataType: "string" },
  { name: "tracey.agent.name", fieldContext: "attribute", fieldDataType: "string" },
  { name: "tracey.feedback.source", fieldContext: "attribute", fieldDataType: "string" },
  { name: "tracey.feedback.label", fieldContext: "attribute", fieldDataType: "string" },
  { name: "tracey.feedback.score", fieldContext: "attribute", fieldDataType: "float64" },
  { name: "tracey.feedback.reference", fieldContext: "attribute", fieldDataType: "string" },
] as const;

const codexLogSelectFields = [
  { name: "trace_id", fieldContext: "log", fieldDataType: "string" },
  { name: "span_id", fieldContext: "log", fieldDataType: "string" },
  { name: "severity_text", fieldContext: "log", fieldDataType: "string" },
  { name: "service.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "service.version", fieldContext: "resource", fieldDataType: "string" },
  { name: "deployment.environment.name", fieldContext: "resource", fieldDataType: "string" },
  { name: "tracey.tenant.id", fieldContext: "resource", fieldDataType: "string" },
  { name: "event.name", fieldContext: "attribute", fieldDataType: "string" },
  { name: "event.timestamp", fieldContext: "attribute", fieldDataType: "string" },
  { name: "conversation.id", fieldContext: "attribute", fieldDataType: "string" },
  { name: "app.version", fieldContext: "attribute", fieldDataType: "string" },
  { name: "originator", fieldContext: "attribute", fieldDataType: "string" },
  { name: "model", fieldContext: "attribute", fieldDataType: "string" },
  { name: "slug", fieldContext: "attribute", fieldDataType: "string" },
  { name: "prompt_length", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "duration_ms", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "success", fieldContext: "attribute", fieldDataType: "bool" },
  { name: "event.kind", fieldContext: "attribute", fieldDataType: "string" },
  { name: "input_token_count", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "output_token_count", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "cached_token_count", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "reasoning_token_count", fieldContext: "attribute", fieldDataType: "int64" },
  { name: "tool_name", fieldContext: "attribute", fieldDataType: "string" },
  { name: "decision", fieldContext: "attribute", fieldDataType: "string" },
  { name: "source", fieldContext: "attribute", fieldDataType: "string" },
  { name: "error.type", fieldContext: "attribute", fieldDataType: "string" },
] as const;

function parseRawResponse(value: unknown): RawResponse {
  const parsed = SigNozRawResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new SigNozAdapterError("SigNoz response does not match the documented v5 raw query schema", undefined, {
      cause: parsed.error,
      kind: "invalid_response",
    });
  }
  return parsed.data;
}

function rowsFrom(response: RawResponse): { rows: RawRow[]; nextCursor?: string } {
  const results = response.data.data.results ?? [];
  const rows = results.flatMap((result) => result.rows ?? []);
  const nextCursor = results.find((result) => result.nextCursor)?.nextCursor;
  return nextCursor ? { rows, nextCursor } : { rows };
}

function queryMetadata(response: RawResponse | TimeSeriesResponse): QueryExecutionMetadata {
  const meta = response.data.meta;
  if (!meta) return {};
  return {
    ...(meta.rowsScanned === undefined ? {} : { rowsScanned: meta.rowsScanned }),
    ...(meta.bytesScanned === undefined ? {} : { bytesScanned: meta.bytesScanned }),
    ...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
  };
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNonNegativeNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeRun(row: RawRow): AgentRunSummary | undefined {
  const data = row.data ?? {};
  const traceId = readString(data, "trace_id");
  const runId = readString(data, "tracey.run.id");
  const serviceName = readString(data, "service.name");
  const startedAtMs = Date.parse(row.timestamp);
  if (!traceId || !runId || !serviceName || !Number.isFinite(startedAtMs)) return undefined;

  const durationNano = readNonNegativeNumber(data, "duration_nano");
  const agentName = readString(data, "tracey.agent.name");
  const outcome = readString(data, "tracey.user.outcome");
  return {
    traceId,
    runId,
    serviceName,
    startedAt: new Date(startedAtMs).toISOString(),
    ...(agentName ? { agentName } : {}),
    ...(outcome ? { outcome } : {}),
    ...(durationNano === undefined ? {} : { durationMs: durationNano / 1_000_000 }),
  };
}

function normalizeClaudeRun(row: RawRow): AgentRunSummary | undefined {
  const data = row.data ?? {};
  const traceId = readString(data, "trace_id");
  const serviceName = readString(data, "service.name");
  const startedAtMs = Date.parse(row.timestamp);
  if (!traceId || !serviceName || !Number.isFinite(startedAtMs)) return undefined;

  const durationNano = readNonNegativeNumber(data, "duration_nano");
  const hasError = readBoolean(data, "has_error");
  return {
    traceId,
    runId: `claude:${traceId}`,
    serviceName,
    startedAt: new Date(startedAtMs).toISOString(),
    agentName: "claude-code",
    ...(hasError === undefined ? {} : { outcome: hasError ? "error" : "observed" }),
    ...(durationNano === undefined ? {} : { durationMs: durationNano / 1_000_000 }),
  };
}

function normalizeSpan(row: RawRow): TraceSpan | undefined {
  const data = row.data ?? {};
  const traceId = readString(data, "trace_id");
  const spanId = readString(data, "span_id");
  const name = readString(data, "name");
  const serviceName = readString(data, "service.name");
  const durationNano = readNonNegativeNumber(data, "duration_nano");
  const startTimeMs = Date.parse(row.timestamp);
  if (!traceId || !spanId || !name || !serviceName || durationNano === undefined || !Number.isFinite(startTimeMs)) {
    return undefined;
  }

  const parentSpanId = readString(data, "parent_span_id") ?? null;
  const statusCode = readString(data, "status_code");
  const hasError = readBoolean(data, "has_error");
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    serviceName,
    startedAt: new Date(startTimeMs).toISOString(),
    startTimeMs,
    durationMs: durationNano / 1_000_000,
    ...(statusCode ? { statusCode } : {}),
    ...(hasError === undefined ? {} : { hasError }),
    attributes: data,
  };
}

function normalizeLog(row: RawRow): TraceLog | undefined {
  const data = row.data ?? {};
  const traceId = readString(data, "trace_id");
  const body = readString(data, "body");
  const timestampMs = Date.parse(row.timestamp);
  if (!traceId || !body || !Number.isFinite(timestampMs)) return undefined;
  const spanId = readString(data, "span_id");
  const severity = readString(data, "severity_text");
  const serviceName = readString(data, "service.name");
  return {
    timestamp: new Date(timestampMs).toISOString(),
    traceId,
    body,
    ...(spanId ? { spanId } : {}),
    ...(severity ? { severity } : {}),
    ...(serviceName ? { serviceName } : {}),
    attributes: data,
  };
}

function normalizeCodexLog(row: RawRow): TraceLog | undefined {
  const data = row.data ?? {};
  const traceId = readString(data, "trace_id") ?? "0".repeat(32);
  const eventName = readString(data, "event.name");
  const eventTimestamp = readString(data, "event.timestamp");
  const timestampMs = Date.parse(eventTimestamp ?? row.timestamp);
  if (!eventName?.startsWith("codex.") || !Number.isFinite(timestampMs)) return undefined;
  const spanId = readString(data, "span_id");
  const severity = readString(data, "severity_text");
  const serviceName = readString(data, "service.name");
  return {
    timestamp: new Date(timestampMs).toISOString(),
    traceId,
    body: eventName,
    ...(spanId ? { spanId } : {}),
    ...(severity ? { severity } : {}),
    ...(serviceName ? { serviceName } : {}),
    attributes: data,
  };
}

function scopeFilters(scopeInput: TelemetryScope): string[] {
  const scope = TelemetryScopeSchema.parse(scopeInput);
  return [
    `tracey.tenant.id = '${escapeFilterValue(scope.tenantId)}'`,
    `deployment.environment.name = '${escapeFilterValue(scope.environment)}'`,
  ];
}

export function buildAgentRunsQuery(
  input: TraceSearch,
  scope: TelemetryScope,
  producerType: AgentProducerType = "custom_otel",
): unknown {
  const search = TraceSearchSchema.parse(input);
  const rootSpanName = producerType === "claude_code" ? "claude_code.interaction" : "agent.run";
  const filters = [
    `service.name = '${escapeFilterValue(search.serviceName)}'`,
    `name = '${rootSpanName}'`,
    "parent_span_id = ''",
    ...scopeFilters(scope),
  ];
  if (search.runId) {
    if (producerType === "claude_code") {
      const traceId = search.runId.startsWith("claude:") ? search.runId.slice(7) : "";
      if (!/^[a-fA-F0-9]{32}$/.test(traceId)) {
        throw new z.ZodError([{
          code: "custom",
          path: ["runId"],
          message: "Claude Code runId must use claude:<32-hex-trace-id>",
        }]);
      }
      filters.push(`trace_id = '${traceId}'`);
    } else {
      filters.push(`tracey.run.id = '${escapeFilterValue(search.runId)}'`);
    }
  }

  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: { expression: filters.join(" AND ") },
            selectFields: producerType === "claude_code" ? nativeRootSelectFields : customRootSelectFields,
            order: [{ key: { name: "timestamp" }, direction: "desc" }],
            limit: search.limit,
            offset: search.offset,
            disabled: false,
          },
        },
      ],
    },
  };
}

export function buildTraceSpansQuery(input: TraceDetailsSearch, scope: TelemetryScope): unknown {
  const search = TraceDetailsSearchSchema.parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: {
              expression: [
                `trace_id = '${escapeFilterValue(search.traceId)}'`,
                ...scopeFilters(scope),
              ].join(" AND "),
            },
            selectFields: traceSelectFields,
            order: [{ key: { name: "timestamp" }, direction: "asc" }],
            limit: search.limit,
            ...(search.cursor ? { cursor: search.cursor } : {}),
            disabled: false,
          },
        },
      ],
    },
  };
}

export function buildServiceSpansQuery(
  input: { serviceName: string; start: number; end: number; limit?: number },
  scope: TelemetryScope,
): unknown {
  const search = z.object({
    serviceName: z.string().trim().min(1).max(255),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    limit: z.number().int().min(1).max(10_000).default(10_000),
  }).refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [{
        type: "builder_query",
        spec: {
          name: "A",
          signal: "traces",
          filter: {
            expression: [
              `service.name = '${escapeFilterValue(search.serviceName)}'`,
              ...scopeFilters(scope),
            ].join(" AND "),
          },
          selectFields: traceSelectFields,
          order: [{ key: { name: "timestamp" }, direction: "desc" }],
          limit: search.limit,
          disabled: false,
        },
      }],
    },
  };
}

export function buildTraceLogsQuery(input: TraceDetailsSearch, scope: TelemetryScope): unknown {
  const search = TraceDetailsSearchSchema.parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "logs",
            filter: {
              expression: [
                `trace_id = '${escapeFilterValue(search.traceId)}'`,
                ...scopeFilters(scope),
              ].join(" AND "),
            },
            selectFields: logSelectFields,
            order: [{ key: { name: "timestamp" }, direction: "asc" }],
            limit: Math.min(search.limit, 1_000),
            ...(search.cursor ? { cursor: search.cursor } : {}),
            disabled: false,
          },
        },
      ],
    },
  };
}

export function buildCodexConversationLogsQuery(
  input: CodexConversationSearch,
  scope: TelemetryScope,
): unknown {
  const search = CodexConversationSearchSchema.parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "logs",
            filter: {
              expression: [
                `service.name = '${escapeFilterValue(search.serviceName)}'`,
                `conversation.id = '${escapeFilterValue(search.conversationId)}'`,
                ...scopeFilters(scope),
              ].join(" AND "),
            },
            selectFields: codexLogSelectFields,
            order: [{ key: { name: "timestamp" }, direction: "asc" }],
            limit: Math.min(search.limit, 1_000),
            ...(search.cursor ? { cursor: search.cursor } : {}),
            disabled: false,
          },
        },
      ],
    },
  };
}

export function buildCodexRecentLogsQuery(
  input: CodexRecentLogsSearch,
  scope: TelemetryScope,
): unknown {
  const search = CodexRecentLogsSearchSchema.parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [{
        type: "builder_query",
        spec: {
          name: "A",
          signal: "logs",
          filter: {
            expression: [
              `service.name = '${escapeFilterValue(search.serviceName)}'`,
              ...scopeFilters(scope),
            ].join(" AND "),
          },
          selectFields: codexLogSelectFields,
          order: [{ key: { name: "timestamp" }, direction: "desc" }],
          limit: search.limit,
          ...(search.cursor ? { cursor: search.cursor } : {}),
          disabled: false,
        },
      }],
    },
  };
}

export function buildAgentRunMetricsQuery(input: AgentRunMetricsSearch, scope: TelemetryScope): unknown {
  const search = AgentRunMetricsSearchSchema.parse(input);
  return {
    start: search.start,
    end: search.end,
    requestType: "time_series",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "metrics",
            stepInterval: search.stepInterval,
            aggregations: [
              {
                metricName: "tracey.agent.runs",
                temporality: "cumulative",
                timeAggregation: "increase",
                spaceAggregation: "sum",
              },
            ],
            filter: {
              expression: [
                `service.name = '${escapeFilterValue(search.serviceName)}'`,
                ...scopeFilters(scope),
              ].join(" AND "),
            },
            groupBy: [
              { name: "tracey.agent.name", fieldContext: "attribute", fieldDataType: "string" },
              { name: "tracey.user.outcome", fieldContext: "attribute", fieldDataType: "string" },
            ],
            disabled: false,
          },
        },
      ],
    },
  };
}

export function buildServiceHealthQuery(
  input: { serviceName: string; start: number; end: number; limit?: number },
  scope: TelemetryScope,
): unknown {
  const parsed = z.object({
    serviceName: z.string().trim().min(1).max(128),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    limit: z.number().int().min(1).max(1_000).default(1_000),
  }).refine(({ start, end }) => start < end, "start must be before end").parse(input);
  return {
    start: parsed.start,
    end: parsed.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: { queries: [{
      type: "builder_query",
      spec: {
        name: "A",
        signal: "traces",
        filter: { expression: [
          `service.name = '${escapeFilterValue(parsed.serviceName)}'`,
          ...scopeFilters(scope),
        ].join(" AND ") },
        selectFields: serviceHealthSelectFields,
        order: [{ key: { name: "timestamp" }, direction: "desc" }],
        limit: parsed.limit,
        disabled: false,
      },
    }] },
  };
}

export function buildCohortSpansQuery(
  input: CohortComparisonSearch,
  scope: TelemetryScope,
  cohortValue: string,
  page: { limit: number; cursor?: string },
): unknown {
  const search = CohortComparisonSearchSchema.parse(input);
  const dimensionAttribute = CohortDimensionAttribute[search.dimension];
  if (cohortValue !== search.baseline && cohortValue !== search.candidate) {
    throw new Error("cohortValue must be the configured baseline or candidate");
  }
  return {
    start: search.start,
    end: search.end,
    requestType: "raw",
    schemaVersion: "v1",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: {
              expression: [
                `service.name = '${escapeFilterValue(search.serviceName)}'`,
                `${dimensionAttribute} = '${escapeFilterValue(cohortValue)}'`,
                ...scopeFilters(scope),
              ].join(" AND "),
            },
            selectFields: traceSelectFields,
            order: [{ key: { name: "timestamp" }, direction: "desc" }],
            limit: Math.min(page.limit, 1_000),
            ...(page.cursor ? { cursor: page.cursor } : {}),
            disabled: false,
          },
        },
      ],
    },
  };
}

function addQueryMetadata(
  total: QueryExecutionMetadata,
  next: QueryExecutionMetadata,
): QueryExecutionMetadata {
  const add = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const rowsScanned = add(total.rowsScanned, next.rowsScanned);
  const bytesScanned = add(total.bytesScanned, next.bytesScanned);
  const durationMs = add(total.durationMs, next.durationMs);
  return {
    ...(rowsScanned === undefined ? {} : { rowsScanned }),
    ...(bytesScanned === undefined ? {} : { bytesScanned }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export class SigNozAdapter {
  private readonly endpoint: string;
  private readonly serverAddress: string;
  private readonly timeoutMs: number;
  private readonly cohortTimeoutMs: number;

  constructor(private readonly config: SigNozAdapterConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/$/, "")}/api/v5/query_range`;
    this.serverAddress = new URL(config.baseUrl).hostname;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.cohortTimeoutMs = config.cohortTimeoutMs ?? 25_000;
    TelemetryScopeSchema.parse(config.scope);
  }

  async searchAgentRuns(
    input: TraceSearch,
    producerType: AgentProducerType = "custom_otel",
  ): Promise<AgentRunSearchResult> {
    return this.observe("search_agent_runs", async () => {
      const response = parseRawResponse(
        await this.query(buildAgentRunsQuery(input, this.config.scope, producerType)),
      );
      const { rows, nextCursor } = rowsFrom(response);
      const normalizer = producerType === "claude_code" ? normalizeClaudeRun : normalizeRun;
      const runs = rows.map(normalizer).filter((run): run is AgentRunSummary => run !== undefined);
      return {
        runs,
        rejectedRows: rows.length - runs.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async getTraceSpans(input: TraceDetailsSearch): Promise<TraceSpanSearchResult> {
    return this.observe("trace_spans", async () => {
      const response = parseRawResponse(await this.query(buildTraceSpansQuery(input, this.config.scope)));
      const { rows, nextCursor } = rowsFrom(response);
      const spans = rows.map(normalizeSpan).filter((span): span is TraceSpan => span !== undefined);
      return {
        spans,
        rejectedRows: rows.length - spans.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async getServiceSpans(
    input: { serviceName: string; start: number; end: number; limit?: number },
  ): Promise<TraceSpanSearchResult> {
    return this.observe("trace_spans", async () => {
      const response = parseRawResponse(await this.query(buildServiceSpansQuery(input, this.config.scope)));
      const { rows, nextCursor } = rowsFrom(response);
      const spans = rows.map(normalizeSpan).filter((span): span is TraceSpan => span !== undefined);
      return {
        spans,
        rejectedRows: rows.length - spans.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async getTraceLogs(input: TraceDetailsSearch): Promise<TraceLogSearchResult> {
    return this.observe("trace_logs", async () => {
      const response = parseRawResponse(await this.query(buildTraceLogsQuery(input, this.config.scope)));
      const { rows, nextCursor } = rowsFrom(response);
      const traceLogs = rows.map(normalizeLog).filter((log): log is TraceLog => log !== undefined);
      return {
        logs: traceLogs,
        rejectedRows: rows.length - traceLogs.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async getCodexConversationLogs(input: CodexConversationSearch): Promise<TraceLogSearchResult> {
    return this.observe("codex_logs", async () => {
      const response = parseRawResponse(
        await this.query(buildCodexConversationLogsQuery(input, this.config.scope)),
      );
      const { rows, nextCursor } = rowsFrom(response);
      const logs = rows.map(normalizeCodexLog).filter((log): log is TraceLog => log !== undefined);
      return {
        logs,
        rejectedRows: rows.length - logs.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async getCodexRecentLogs(input: CodexRecentLogsSearch): Promise<TraceLogSearchResult> {
    return this.observe("codex_logs", async () => {
      const response = parseRawResponse(await this.query(buildCodexRecentLogsQuery(input, this.config.scope)));
      const { rows, nextCursor } = rowsFrom(response);
      const logs = rows.map(normalizeCodexLog).filter((log): log is TraceLog => log !== undefined);
      return {
        logs,
        rejectedRows: rows.length - logs.length,
        query: queryMetadata(response),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  }

  async queryAgentRunMetrics(input: AgentRunMetricsSearch): Promise<AgentRunMetricsResult> {
    return this.observe("agent_run_metrics", async () => {
      const parsed = SigNozTimeSeriesResponseSchema.safeParse(
        await this.query(buildAgentRunMetricsQuery(input, this.config.scope)),
      );
      if (!parsed.success) {
        throw new SigNozAdapterError(
          "SigNoz response does not match the documented v5 time-series query schema",
          undefined,
          { cause: parsed.error, kind: "invalid_response" },
        );
      }

      const series = (parsed.data.data.data.results ?? []).flatMap((result) =>
        (result.aggregations ?? []).flatMap((aggregation) =>
          (aggregation.series ?? []).map((item) => ({
            attributes: Object.fromEntries((item.labels ?? []).map((label) => [label.key.name, label.value])),
            points: (item.values ?? []).map((point) => ({
              timestamp: point.timestamp,
              value: point.value,
            })),
          })),
        ),
      );
      return { series, query: queryMetadata(parsed.data) };
    });
  }

  async getServiceHealthSnapshot(input: {
    serviceName: string;
    start: number;
    end: number;
    limit?: number;
  }): Promise<ServiceHealthSnapshot> {
    return this.observe("service_health", async () => {
      const response = parseRawResponse(await this.query(buildServiceHealthQuery(input, this.config.scope)));
      const page = rowsFrom(response);
      const samples = page.rows.flatMap((row) => {
        const data = row.data ?? {};
        const durationNano = readNonNegativeNumber(data, "duration_nano");
        if (durationNano === undefined) return [];
        const statusCode = readString(data, "status_code")?.toUpperCase();
        return [{
          durationMs: durationNano / 1_000_000,
          error: readBoolean(data, "has_error") === true || statusCode === "ERROR",
        }];
      });
      const sorted = samples.map(({ durationMs }) => durationMs).sort((left, right) => left - right);
      const errorSpans = samples.filter(({ error }) => error).length;
      const p95Index = sorted.length === 0 ? 0 : Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
      return {
        serviceName: input.serviceName,
        window: { start: input.start, end: input.end },
        totalSpans: samples.length,
        errorSpans,
        errorRate: samples.length === 0 ? 0 : errorSpans / samples.length,
        p95LatencyMs: sorted[p95Index] ?? 0,
        rejectedRows: page.rows.length - samples.length,
        truncated: page.nextCursor !== undefined,
        query: queryMetadata(response),
      };
    });
  }

  async searchCohortSpans(input: CohortComparisonSearch): Promise<CohortSpanSearchResult> {
    const search = CohortComparisonSearchSchema.parse(input);
    return this.observe("cohort_spans", async () => {
      const signal = AbortSignal.timeout(this.cohortTimeoutMs);
      const [baseline, candidate] = await Promise.all([
        this.fetchCohortSpanSet(search, search.baseline, signal),
        this.fetchCohortSpanSet(search, search.candidate, signal),
      ]);
      return { dimension: search.dimension, baseline, candidate };
    });
  }

  private async fetchCohortSpanSet(
    input: CohortComparisonSearch,
    value: string,
    signal: AbortSignal,
  ): Promise<CohortSpanSet> {
    const spans: TraceSpan[] = [];
    let rejectedRows = 0;
    let rawRowsSeen = 0;
    let cursor: string | undefined;
    let metadata: QueryExecutionMetadata = {};
    let pages = 0;

    do {
      const remaining = input.maxSpansPerCohort - rawRowsSeen;
      if (remaining <= 0) break;
      const response = parseRawResponse(
        await this.query(
          buildCohortSpansQuery(input, this.config.scope, value, {
            limit: Math.min(remaining, 1_000),
            ...(cursor ? { cursor } : {}),
          }),
          signal,
        ),
      );
      const page = rowsFrom(response);
      const normalized = page.rows.map(normalizeSpan).filter((span): span is TraceSpan => span !== undefined);
      spans.push(...normalized);
      rejectedRows += page.rows.length - normalized.length;
      rawRowsSeen += page.rows.length;
      metadata = addQueryMetadata(metadata, queryMetadata(response));
      cursor = page.nextCursor;
      pages += 1;
      if (page.rows.length === 0 || pages >= 20) break;
    } while (cursor && rawRowsSeen < input.maxSpansPerCohort);

    return {
      value,
      spans,
      rejectedRows,
      truncated: cursor !== undefined,
      query: metadata,
    };
  }

  private async observe<T>(operation: SigNozQueryOperation, query: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    let outcome: SigNozQueryOutcome = "success";
    signozAdapterRequests.add(1, buildSigNozMetricAttributes(operation));
    return tracer.startActiveSpan(
      "signoz.query_range",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "server.address": this.serverAddress,
          "http.request.method": "POST",
          "tracey.signoz.operation": operation,
          "tracey.content.capture": "none",
        },
      },
      async (span) => {
        try {
          const result = await query();
          const metadata =
            typeof result === "object" && result !== null && "query" in result
              ? (result as { query?: QueryExecutionMetadata }).query
              : undefined;
          if (metadata?.rowsScanned !== undefined) span.setAttribute("tracey.signoz.rows_scanned", metadata.rowsScanned);
          if (metadata?.bytesScanned !== undefined) span.setAttribute("tracey.signoz.bytes_scanned", metadata.bytesScanned);
          if (metadata?.durationMs !== undefined) span.setAttribute("tracey.signoz.server_duration_ms", metadata.durationMs);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          outcome = classifySigNozQueryError(error);
          signozAdapterErrors.add(1, buildSigNozMetricAttributes(operation, outcome));
          span.setAttribute("tracey.signoz.outcome", outcome);
          if (error instanceof SigNozAdapterError && error.statusCode !== undefined) {
            span.setAttribute("http.response.status_code", error.statusCode);
          }
          const exception = error instanceof Error ? error : new Error(String(error));
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR });
          emitOperationalLog("ERROR", "SigNoz adapter query failed", {
            "tracey.signoz.operation": operation,
            "tracey.signoz.outcome": outcome,
            "error.type": exception.name,
            ...(error instanceof SigNozAdapterError && error.statusCode !== undefined
              ? { "http.response.status_code": error.statusCode }
              : {}),
          });
          throw error;
        } finally {
          signozAdapterDuration.record(
            (performance.now() - startedAt) / 1_000,
            buildSigNozMetricAttributes(operation, outcome),
          );
          span.end();
        }
      },
    );
  }

  private async query(payload: unknown, totalSignal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "SIGNOZ-API-KEY": this.config.apiKey,
    };
    propagation.inject(context.active(), headers);
    let activePayload = payload;

    for (let attempt = 0; attempt <= traceSelectFields.length; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(activePayload),
          signal: totalSignal
            ? AbortSignal.any([totalSignal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new SigNozAdapterError("SigNoz query failed before a response was received", undefined, {
          cause: error,
          kind:
            error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
              ? "timeout"
              : "network_error",
        });
      }

      trace.getSpan(context.active())?.setAttribute("http.response.status_code", response.status);
      const text = await response.text();
      if (!response.ok) {
        const missingField = response.status === 400 ? missingSelectedField(text) : undefined;
        const reducedPayload = missingField ? withoutSelectedField(activePayload, missingField) : undefined;
        if (missingField && reducedPayload) {
          activePayload = reducedPayload;
          continue;
        }
        throw new SigNozAdapterError(`SigNoz query returned HTTP ${response.status}`, response.status, {
          kind: "http_error",
        });
      }

      try {
        return text.length === 0 ? null : JSON.parse(text) as unknown;
      } catch (error) {
        throw new SigNozAdapterError("SigNoz returned a non-JSON response", response.status, {
          cause: error,
          kind: "invalid_response",
        });
      }
    }
    throw new SigNozAdapterError("SigNoz query exceeded the bounded field-negotiation limit", 400, {
      kind: "http_error",
    });
  }
}
