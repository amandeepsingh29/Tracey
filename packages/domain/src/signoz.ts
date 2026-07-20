import { z } from "zod";

const TimeRangeFields = {
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
};

export const TimeRangeSchema = z
  .object(TimeRangeFields)
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export const TraceSearchSchema = z
  .object({
    ...TimeRangeFields,
    serviceName: z.string().trim().min(1).max(128),
    runId: z.string().trim().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export type TraceSearch = z.infer<typeof TraceSearchSchema>;
