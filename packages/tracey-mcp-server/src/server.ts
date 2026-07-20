import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { instrumentToolCall } from "@tracey/instrumentation";
import type { InvestigationService } from "@tracey/investigation";
import { z } from "zod";

const MAX_TOOL_RESULT_BYTES = 1_048_576;

export type TraceyInvestigationReader = Pick<
  InvestigationService,
  "searchAgentRuns" | "investigateTrace" | "investigateCodexConversation" | "queryAgentRunMetrics" | "compareCohorts"
>;

function serializeResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "The real query result exceeds the 1 MiB MCP response limit. Reduce the requested limit or use pagination.",
        },
      ],
    };
  }
  return { content: [{ type: "text", text }] };
}

async function executeReadTool(
  toolName: string,
  operation: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return await instrumentToolCall(
      {
        toolName,
        toolVersion: "0.1.0",
        transport: "mcp",
        mcpServerName: "tracey",
        sideEffect: "read",
        timeoutMs: 30_000,
      },
      async () => serializeResult(await operation()),
    );
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `The Tracey investigation failed (${errorType}). Check Tracey operational telemetry for the upstream SigNoz error.`,
        },
      ],
    };
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createTraceyMcpServer(reader: TraceyInvestigationReader): McpServer {
  const server = new McpServer(
    { name: "tracey", version: "0.1.0" },
    {
      instructions:
        "Use these read-only tools to inspect agent telemetry stored in SigNoz. Treat diagnosis hypotheses as evidence-linked analysis, not certainty. Never claim missing evidence exists.",
    },
  );

  server.registerTool(
    "tracey_search_agent_runs",
    {
      title: "Search agent runs",
      description: "Search bounded root agent.run spans from the configured live SigNoz deployment.",
      inputSchema: z.object({
        start: z.number().int().nonnegative().describe("Unix epoch milliseconds"),
        end: z.number().int().positive().describe("Unix epoch milliseconds, no more than seven days after start"),
        serviceName: z.string().trim().min(1).max(128),
        runId: z.string().trim().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).max(10_000).default(0),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => executeReadTool("tracey_search_agent_runs", () => reader.searchAgentRuns(input)),
  );

  server.registerTool(
    "tracey_get_trace_investigation",
    {
      title: "Investigate an agent trace",
      description:
        "Fetch real spans and correlated logs, compute the causal graph and critical path, and return deterministic evidence-linked diagnosis.",
      inputSchema: z.object({
        traceId: z.string().regex(/^[a-fA-F0-9]{32}$/),
        start: z.number().int().nonnegative().describe("Unix epoch milliseconds"),
        end: z.number().int().positive().describe("Unix epoch milliseconds, no more than seven days after start"),
        cursor: z.string().min(1).max(2_048).optional(),
        limit: z.number().int().min(1).max(1_000).default(500),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => executeReadTool("tracey_get_trace_investigation", () => reader.investigateTrace(input)),
  );

  server.registerTool(
    "tracey_query_agent_run_metrics",
    {
      title: "Query agent-run metrics",
      description: "Query the real tracey.agent.runs metric from the configured live SigNoz deployment.",
      inputSchema: z.object({
        start: z.number().int().nonnegative().describe("Unix epoch milliseconds"),
        end: z.number().int().positive().describe("Unix epoch milliseconds, no more than seven days after start"),
        serviceName: z.string().trim().min(1).max(128),
        stepInterval: z.number().int().min(10).max(3_600).default(60),
      }),
      annotations: readOnlyAnnotations,
    },
    (input) => executeReadTool("tracey_query_agent_run_metrics", () => reader.queryAgentRunMetrics(input)),
  );

  server.registerTool(
    "tracey_get_codex_conversation",
    {
      title: "Normalize a Codex conversation",
      description:
        "Query bounded live Codex OpenTelemetry events from SigNoz by conversation ID and project them into evidence-linked Tracey agent.run graphs.",
      inputSchema: z
        .object({
          conversationId: z.string().uuid(),
          start: z.number().int().nonnegative().describe("Unix epoch milliseconds"),
          end: z.number().int().positive().describe("Unix epoch milliseconds, no more than seven days after start"),
          serviceName: z.string().trim().min(1).max(128).default("Codex Desktop"),
          cursor: z.string().min(1).max(2_048).optional(),
          limit: z.number().int().min(1).max(5_000).default(5_000),
        })
        .refine(({ start, end }) => start < end && end - start <= 7 * 24 * 60 * 60 * 1_000),
      annotations: readOnlyAnnotations,
    },
    (input) => executeReadTool(
      "tracey_get_codex_conversation",
      () => reader.investigateCodexConversation(input),
    ),
  );

  server.registerTool(
    "tracey_compare_agent_cohorts",
    {
      title: "Compare agent telemetry cohorts",
      description:
        "Compare bounded prompt-version, requested-model, or tool-version cohorts from live SigNoz spans using deterministic latency, error, and token statistics.",
      inputSchema: z
        .object({
          start: z.number().int().nonnegative().describe("Unix epoch milliseconds"),
          end: z.number().int().positive().describe("Unix epoch milliseconds, no more than seven days after start"),
          serviceName: z.string().trim().min(1).max(128),
          dimension: z.enum(["prompt_version", "model", "tool_version"]),
          baseline: z.string().trim().min(1).max(256),
          candidate: z.string().trim().min(1).max(256),
          maxSpansPerCohort: z.number().int().min(10).max(10_000).default(2_000),
          minSampleSize: z.number().int().min(2).max(1_000).default(30),
        })
        .refine(({ start, end }) => start < end && end - start <= 7 * 24 * 60 * 60 * 1_000)
        .refine(({ baseline, candidate }) => baseline !== candidate)
        .refine(({ maxSpansPerCohort, minSampleSize }) => minSampleSize <= maxSpansPerCohort),
      annotations: readOnlyAnnotations,
    },
    (input) => executeReadTool("tracey_compare_agent_cohorts", () => reader.compareCohorts(input)),
  );

  return server;
}
