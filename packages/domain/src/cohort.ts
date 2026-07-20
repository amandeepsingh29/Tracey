import { z } from "zod";
import type { QueryExecutionMetadata, TraceSpan } from "./trace.js";

const TimeRangeFields = {
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
};

export const CohortDimensionSchema = z.enum(["prompt_version", "model", "tool_version"]);
export type CohortDimension = z.infer<typeof CohortDimensionSchema>;

export const CohortDimensionAttribute: Record<CohortDimension, string> = {
  prompt_version: "tracey.prompt.version",
  model: "gen_ai.request.model",
  tool_version: "tracey.tool.version",
};

export const CohortComparisonSearchSchema = z
  .object({
    ...TimeRangeFields,
    serviceName: z.string().trim().min(1).max(128),
    dimension: CohortDimensionSchema,
    baseline: z.string().trim().min(1).max(256),
    candidate: z.string().trim().min(1).max(256),
    maxSpansPerCohort: z.number().int().min(10).max(10_000).default(2_000),
    minSampleSize: z.number().int().min(2).max(1_000).default(30),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  )
  .refine(({ baseline, candidate }) => baseline !== candidate, "baseline and candidate must differ")
  .refine(
    ({ maxSpansPerCohort, minSampleSize }) => minSampleSize <= maxSpansPerCohort,
    "minSampleSize cannot exceed maxSpansPerCohort",
  );

export type CohortComparisonSearch = z.infer<typeof CohortComparisonSearchSchema>;

export interface CohortSpanSet {
  value: string;
  spans: TraceSpan[];
  rejectedRows: number;
  truncated: boolean;
  query: QueryExecutionMetadata;
}

export interface CohortSpanSearchResult {
  dimension: CohortDimension;
  baseline: CohortSpanSet;
  candidate: CohortSpanSet;
}
