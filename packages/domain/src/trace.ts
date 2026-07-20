import { z } from "zod";

const TimeRangeFields = {
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
};

export const TraceIdSchema = z.string().regex(/^[a-fA-F0-9]{32}$/, "traceId must be 32 hex characters");
export const SpanIdSchema = z.string().regex(/^[a-fA-F0-9]{16}$/, "spanId must be 16 hex characters");

export const TraceDetailsSearchSchema = z
  .object({
    ...TimeRangeFields,
    traceId: TraceIdSchema,
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(10_000).default(10_000),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export type TraceDetailsSearch = z.infer<typeof TraceDetailsSearchSchema>;

export const AgentRunMetricsSearchSchema = z
  .object({
    ...TimeRangeFields,
    serviceName: z.string().trim().min(1).max(128),
    stepInterval: z.number().int().min(10).max(3_600).default(60),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export type AgentRunMetricsSearch = z.infer<typeof AgentRunMetricsSearchSchema>;

export interface AgentRunSummary {
  traceId: string;
  runId: string;
  serviceName: string;
  agentName?: string;
  outcome?: string;
  startedAt: string;
  durationMs?: number;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  serviceName: string;
  startedAt: string;
  startTimeMs: number;
  durationMs: number;
  statusCode?: string;
  hasError?: boolean;
  attributes: Record<string, unknown>;
}

export interface QueryExecutionMetadata {
  rowsScanned?: number;
  bytesScanned?: number;
  durationMs?: number;
}

export interface AgentRunSearchResult {
  runs: AgentRunSummary[];
  rejectedRows: number;
  nextCursor?: string;
  query: QueryExecutionMetadata;
}

export interface TraceSpanSearchResult {
  spans: TraceSpan[];
  rejectedRows: number;
  nextCursor?: string;
  query: QueryExecutionMetadata;
}

export interface TraceLog {
  timestamp: string;
  traceId: string;
  spanId?: string;
  severity?: string;
  body: string;
  serviceName?: string;
  attributes: Record<string, unknown>;
}

export interface TraceLogSearchResult {
  logs: TraceLog[];
  rejectedRows: number;
  nextCursor?: string;
  query: QueryExecutionMetadata;
}

export interface MetricPoint {
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  attributes: Record<string, string | number | boolean>;
  points: MetricPoint[];
}

export interface AgentRunMetricsResult {
  series: MetricSeries[];
  query: QueryExecutionMetadata;
}
