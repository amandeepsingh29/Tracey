import { z } from "zod";

export const CodexConversationIdSchema = z.string().uuid();

export const CodexConversationSearchSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    conversationId: CodexConversationIdSchema,
    serviceName: z.string().trim().min(1).max(128).default("codex-app-server"),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(5_000).default(5_000),
  })
  .refine(({ start, end }) => start < end, "start must be before end")
  .refine(
    ({ start, end }) => end - start <= 7 * 24 * 60 * 60 * 1_000,
    "time range cannot exceed seven days",
  );

export type CodexConversationSearch = z.infer<typeof CodexConversationSearchSchema>;
