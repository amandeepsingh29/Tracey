import { z } from "zod";

export const TelemetryScopeSchema = z.object({
  tenantId: z.string().trim().min(1).max(128),
  environment: z.string().trim().min(1).max(128),
});

export type TelemetryScope = z.infer<typeof TelemetryScopeSchema>;
