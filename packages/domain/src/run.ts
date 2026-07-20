import { z } from "zod";

export const AgentFeedbackRequestSchema = z.object({
  traceId: z.string().regex(/^[a-fA-F0-9]{32}$/),
  spanId: z.string().regex(/^[a-fA-F0-9]{16}$/),
  runId: z.string().trim().min(1).max(128),
  source: z.enum(["thumbs_up", "thumbs_down", "support_ticket", "evaluator", "human_review"]),
  label: z.enum(["hallucination", "wrong_tool", "slow", "unsafe", "helpful"]),
  score: z.number().min(-1).max(1).optional(),
  reference: z.string().trim().min(1).max(256).optional(),
});

export type AgentFeedbackRequest = z.infer<typeof AgentFeedbackRequestSchema>;
