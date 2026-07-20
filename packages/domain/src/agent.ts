import { z } from "zod";

export const AgentProducerTypeSchema = z.enum([
  "codex_desktop",
  "codex_cli",
  "claude_code",
  "custom_otel",
]);

export const AgentStatusSchema = z.enum(["active", "paused"]);

const BoundedNameSchema = z.string().trim().min(1).max(128);
const ServiceNameSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.\-/]+$/);
const ContractVersionSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.@+-]+$/);

export const AgentRegistrationRequestSchema = z.object({
  displayName: BoundedNameSchema,
  serviceName: ServiceNameSchema,
  producerType: AgentProducerTypeSchema,
  environment: BoundedNameSchema,
  normalizationProfile: ContractVersionSchema,
  telemetryContractVersion: ContractVersionSchema,
});

export const AgentRegistrationSchema = AgentRegistrationRequestSchema.extend({
  agentId: z.string().uuid(),
  status: AgentStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AgentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const RegisteredAgentRunSearchSchema = z
  .object({
    agentId: z.string().uuid(),
    start: z.coerce.number().int().nonnegative(),
    end: z.coerce.number().int().positive(),
    runId: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export type AgentProducerType = z.infer<typeof AgentProducerTypeSchema>;
export type AgentRegistrationRequest = z.infer<typeof AgentRegistrationRequestSchema>;
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
export type RegisteredAgentRunSearch = z.infer<typeof RegisteredAgentRunSearchSchema>;
