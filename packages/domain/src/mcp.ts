import { z } from "zod";

export const McpToolNameSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_.:/-]+$/);

export const McpToolCallRequestSchema = z.object({
  toolName: McpToolNameSchema,
  arguments: z.record(z.unknown()).default({}),
});

export type McpToolCallRequest = z.infer<typeof McpToolCallRequestSchema>;
