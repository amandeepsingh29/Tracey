import type { InvestigatedCodexRun } from "@tracey/investigation";
import type { CodexForensicEvent, CodexForensicTurn } from "./codex-forensic-reader.js";

export type ExecutionGraphNodeKind =
  | "prompt"
  | "model"
  | "reasoning"
  | "decision"
  | "tool"
  | "result"
  | "final";

export type ExecutionGraphNode = {
  nodeId: string;
  kind: ExecutionGraphNodeKind;
  label: string;
  summary: string;
  timestamp: string;
  durationMs?: number;
  status: "succeeded" | "failed" | "observed";
  content?: string;
  sensitive: boolean;
  source: "codex_session" | "signoz";
  attributes: Record<string, unknown>;
};

export type ExecutionGraphEdge = {
  edgeId: string;
  from: string;
  to: string;
  relationship: "sequence" | "tool_result" | "approval";
  certainty: "observed" | "inferred";
};

export type CodexExecutionGraph = {
  executionId: string;
  runId: string;
  conversationId: string;
  turnIndex: number;
  status: InvestigatedCodexRun["status"];
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  contentSource: "local_session" | "telemetry_only";
  forensicModeAvailable: boolean;
  sensitiveValuesIncluded: boolean;
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
  evidence: InvestigatedCodexRun["evidence"];
  evidenceCompleteness: number;
  limitations: string[];
  analysis: InvestigatedCodexRun["analysis"];
  diagnosis: InvestigatedCodexRun["diagnosis"];
  rawEvents: Array<Record<string, unknown>>;
};

function statusForEvent(event: CodexForensicEvent): ExecutionGraphNode["status"] {
  if (event.kind !== "tool_result") return "observed";
  const content = event.content ?? "";
  const exitCode = content.match(/(?:process exited with code|exit code)\s+(-?\d+)/i)?.[1];
  if (exitCode !== undefined) return Number(exitCode) === 0 ? "succeeded" : "failed";
  return /command failed with (?:exit code|signal)|(?:^|\n)(?:fatal|uncaught error):/im.test(content)
    ? "failed"
    : "succeeded";
}

function kindForEvent(event: CodexForensicEvent): ExecutionGraphNodeKind {
  if (event.kind === "response") return event.phase === "final" ? "final" : "model";
  if (event.kind === "tool_call") return "tool";
  if (event.kind === "tool_result") return "result";
  return event.kind;
}

function summaryForEvent(event: CodexForensicEvent): string {
  const firstLine = event.content?.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 180) : event.label;
}

function graphFromForensicTurn(run: Pick<InvestigatedCodexRun, "spans">, turn: CodexForensicTurn): {
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
} {
  const toolSpans = run.spans.filter((span) => span.attributes["gen_ai.operation.name"] === "execute_tool");
  const modelSpans = run.spans.filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
  let toolIndex = 0;
  let modelIndex = 0;
  const nodes = turn.events.map((event): ExecutionGraphNode => {
    const span = event.kind === "tool_result"
      ? toolSpans[Math.min(toolIndex++, Math.max(0, toolSpans.length - 1))]
      : event.kind === "response"
        ? modelSpans[Math.min(modelIndex++, Math.max(0, modelSpans.length - 1))]
        : undefined;
    return {
      nodeId: event.id,
      kind: kindForEvent(event),
      label: event.label,
      summary: summaryForEvent(event),
      timestamp: event.timestamp,
      ...(span ? { durationMs: span.durationMs } : {}),
      status: span?.hasError ? "failed" : statusForEvent(event),
      ...(event.content ? { content: event.content } : {}),
      sensitive: event.sensitive,
      source: "codex_session",
      attributes: {
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.callId ? { callId: event.callId } : {}),
        ...(span ? span.attributes : {}),
        raw: event.raw,
      },
    };
  });
  const edges: ExecutionGraphEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = turn.events[index - 1]!;
    const current = turn.events[index]!;
    const matchedToolResult = previous.kind === "tool_call" && current.kind === "tool_result"
      && Boolean(previous.callId) && previous.callId === current.callId;
    edges.push({
      edgeId: `${nodes[index - 1]!.nodeId}->${nodes[index]!.nodeId}`,
      from: nodes[index - 1]!.nodeId,
      to: nodes[index]!.nodeId,
      relationship: matchedToolResult ? "tool_result" : "sequence",
      certainty: matchedToolResult ? "observed" : "inferred",
    });
  }
  return { nodes, edges };
}

function graphFromTelemetry(run: InvestigatedCodexRun): {
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
} {
  const spans = [...run.spans].sort((left, right) => left.startTimeMs - right.startTimeMs);
  const nodes = spans.map((span, index): ExecutionGraphNode => ({
    nodeId: `span:${span.spanId}`,
    kind: index === 0 ? "prompt"
      : span.name === "agent.tool_decision" ? "decision"
        : span.attributes["gen_ai.operation.name"] === "execute_tool" ? "tool"
          : "model",
    label: index === 0 ? "User prompt" : span.name,
    summary: index === 0
      ? "Prompt content was not available from the local Codex session connector."
      : span.name,
    timestamp: span.startedAt,
    durationMs: span.durationMs,
    status: span.hasError ? "failed" : span.statusCode === "STATUS_CODE_OK" ? "succeeded" : "observed",
    sensitive: false,
    source: "signoz",
    attributes: span.attributes,
  }));
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      edgeId: `${nodes[index]!.nodeId}->${node.nodeId}`,
      from: nodes[index]!.nodeId,
      to: node.nodeId,
      relationship: "sequence",
      certainty: "inferred",
    })),
  };
}

export function buildLocalCodexExecutionGraph(input: {
  forensicTurn: CodexForensicTurn;
  sensitiveValuesIncluded: boolean;
}): CodexExecutionGraph {
  const graph = graphFromForensicTurn({ spans: [] }, input.forensicTurn);
  const startedAt = input.forensicTurn.events[0]?.timestamp ?? new Date(0).toISOString();
  const endedAt = input.forensicTurn.events.at(-1)?.timestamp ?? startedAt;
  const hasFinalResponse = input.forensicTurn.events.some(({ kind, phase }) => kind === "response" && phase === "final");
  return {
    executionId: `codex:${input.forensicTurn.conversationId}:${input.forensicTurn.turnIndex}`,
    runId: `codex:${input.forensicTurn.conversationId}:${input.forensicTurn.turnIndex}`,
    conversationId: input.forensicTurn.conversationId,
    turnIndex: input.forensicTurn.turnIndex,
    status: hasFinalResponse ? "complete" : "incomplete",
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    contentSource: "local_session",
    forensicModeAvailable: true,
    sensitiveValuesIncluded: input.sensitiveValuesIncluded,
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: [],
    evidenceCompleteness: 1,
    limitations: ["SigNoz telemetry was not required; this graph was assembled directly from the local Codex session."],
    analysis: {
      rootSpanId: "",
      wallClockMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      totalSpanDurationMs: 0,
      criticalPathDurationMs: 0,
      criticalPathSpanIds: [],
      parallelSiblingOverlapMs: 0,
      exclusiveTimeMsBySpanId: {},
      orphanSpanIds: [],
      additionalRootSpanIds: [],
      completenessScore: 1,
    },
    diagnosis: {
      summary: "Execution sequence assembled from the local Codex session.",
      hypotheses: [],
      recommendations: [],
      evidenceCompleteness: 1,
    },
    rawEvents: input.forensicTurn.events.map((event) => event.raw),
  };
}

export function buildCodexExecutionGraph(input: {
  run: InvestigatedCodexRun;
  forensicTurn?: CodexForensicTurn;
  forensicModeAvailable: boolean;
  sensitiveValuesIncluded: boolean;
}): CodexExecutionGraph {
  const graph = input.forensicTurn
    ? graphFromForensicTurn(input.run, input.forensicTurn)
    : graphFromTelemetry(input.run);
  return {
    executionId: input.run.runId,
    runId: input.run.runId,
    conversationId: input.run.conversationId,
    turnIndex: input.run.turnIndex,
    status: input.run.status,
    ...(input.run.model ? { model: input.run.model } : {}),
    startedAt: input.run.startedAt,
    endedAt: input.run.endedAt,
    durationMs: input.run.durationMs,
    contentSource: input.forensicTurn ? "local_session" : "telemetry_only",
    forensicModeAvailable: input.forensicModeAvailable,
    sensitiveValuesIncluded: input.sensitiveValuesIncluded,
    nodes: graph.nodes,
    edges: graph.edges,
    evidence: input.run.evidence,
    evidenceCompleteness: input.run.evidenceCompleteness,
    limitations: input.run.limitations,
    analysis: input.run.analysis,
    diagnosis: input.run.diagnosis,
    rawEvents: input.forensicTurn?.events.map((event) => event.raw) ?? input.run.spans.map((span) => span.attributes),
  };
}
