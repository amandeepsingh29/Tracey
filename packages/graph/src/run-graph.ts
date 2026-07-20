import type { TraceSpan } from "@tracey/domain";

export interface RunGraphNode {
  span: TraceSpan;
  children: string[];
}

export interface RunGraph {
  traceId: string;
  nodes: Map<string, RunGraphNode>;
  rootSpanIds: string[];
  orphanSpanIds: string[];
  completenessScore: number;
}

export interface LatencyAnalysis {
  rootSpanId: string;
  wallClockMs: number;
  totalSpanDurationMs: number;
  criticalPathDurationMs: number;
  criticalPathSpanIds: string[];
  parallelSiblingOverlapMs: number;
  exclusiveTimeMsBySpanId: Record<string, number>;
  orphanSpanIds: string[];
  additionalRootSpanIds: string[];
  completenessScore: number;
}

export class RunGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunGraphError";
  }
}

function spanEnd(span: TraceSpan): number {
  return span.startTimeMs + span.durationMs;
}

function clippedChildIntervals(parent: TraceSpan, children: TraceSpan[]): Array<[number, number]> {
  const parentEnd = spanEnd(parent);
  return children
    .map((child): [number, number] => [
      Math.max(parent.startTimeMs, child.startTimeMs),
      Math.min(parentEnd, spanEnd(child)),
    ])
    .filter(([start, end]) => end > start)
    .sort(([a], [b]) => a - b);
}

function unionDuration(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  let total = 0;
  let [currentStart, currentEnd] = intervals[0] ?? [0, 0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  return total + currentEnd - currentStart;
}

export function buildRunGraph(spans: TraceSpan[]): RunGraph {
  if (spans.length === 0) throw new RunGraphError("Cannot build a run graph without spans");
  const traceId = spans[0]?.traceId;
  if (!traceId) throw new RunGraphError("The first span has no trace ID");

  const nodes = new Map<string, RunGraphNode>();
  for (const span of spans) {
    if (span.traceId !== traceId) throw new RunGraphError("All spans in a run graph must share one trace ID");
    if (nodes.has(span.spanId)) throw new RunGraphError(`Duplicate span ID: ${span.spanId}`);
    if (span.durationMs < 0 || !Number.isFinite(span.durationMs)) {
      throw new RunGraphError(`Invalid duration for span ${span.spanId}`);
    }
    nodes.set(span.spanId, { span, children: [] });
  }

  const rootSpanIds: string[] = [];
  const orphanSpanIds: string[] = [];
  let resolvedEdges = 0;
  for (const span of spans) {
    if (!span.parentSpanId) {
      rootSpanIds.push(span.spanId);
      continue;
    }
    const parent = nodes.get(span.parentSpanId);
    if (!parent) {
      orphanSpanIds.push(span.spanId);
      continue;
    }
    parent.children.push(span.spanId);
    resolvedEdges += 1;
  }

  for (const node of nodes.values()) {
    node.children.sort((left, right) => {
      const leftSpan = nodes.get(left)?.span;
      const rightSpan = nodes.get(right)?.span;
      return (leftSpan?.startTimeMs ?? 0) - (rightSpan?.startTimeMs ?? 0);
    });
  }

  const expectedEdges = Math.max(0, spans.length - 1);
  const completenessScore = expectedEdges === 0 ? 1 : resolvedEdges / expectedEdges;
  return { traceId, nodes, rootSpanIds, orphanSpanIds, completenessScore };
}

interface CriticalResult {
  durationMs: number;
  spanIds: string[];
}

function analyzeNode(
  graph: RunGraph,
  spanId: string,
  exclusiveTime: Record<string, number>,
  visiting: Set<string>,
): CriticalResult {
  if (visiting.has(spanId)) throw new RunGraphError(`Cycle detected at span ${spanId}`);
  const node = graph.nodes.get(spanId);
  if (!node) throw new RunGraphError(`Missing graph node ${spanId}`);
  visiting.add(spanId);

  const childSpans = node.children
    .map((childId) => graph.nodes.get(childId)?.span)
    .filter((span): span is TraceSpan => span !== undefined);
  const intervals = clippedChildIntervals(node.span, childSpans);
  const ownTime = Math.max(0, node.span.durationMs - unionDuration(intervals));
  exclusiveTime[spanId] = ownTime;

  const candidates = node.children
    .map((childId) => {
      const child = graph.nodes.get(childId)?.span;
      if (!child) return undefined;
      const result = analyzeNode(graph, childId, exclusiveTime, visiting);
      return {
        start: Math.max(node.span.startTimeMs, child.startTimeMs),
        end: Math.min(spanEnd(node.span), spanEnd(child)),
        result,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.end - right.end || left.start - right.start);

  const best: CriticalResult[] = [{ durationMs: 0, spanIds: [] }];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    let predecessor = -1;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if ((candidates[previous]?.end ?? Number.POSITIVE_INFINITY) <= candidate.start) {
        predecessor = previous;
        break;
      }
    }
    const preceding = best[predecessor + 1] ?? { durationMs: 0, spanIds: [] };
    const include = {
      durationMs: preceding.durationMs + candidate.result.durationMs,
      spanIds: [...preceding.spanIds, ...candidate.result.spanIds],
    };
    const exclude = best[index] ?? { durationMs: 0, spanIds: [] };
    best.push(include.durationMs > exclude.durationMs ? include : exclude);
  }

  visiting.delete(spanId);
  const selected = best.at(-1) ?? { durationMs: 0, spanIds: [] };
  return {
    durationMs: ownTime + selected.durationMs,
    spanIds: [spanId, ...selected.spanIds],
  };
}

export function analyzeLatency(graph: RunGraph, preferredRootSpanId?: string): LatencyAnalysis {
  const rootSpanId =
    preferredRootSpanId ??
    graph.rootSpanIds.find((id) => graph.nodes.get(id)?.span.name === "agent.run") ??
    graph.rootSpanIds[0];
  if (!rootSpanId) throw new RunGraphError("No root span is available for latency analysis");
  if (!graph.nodes.has(rootSpanId)) throw new RunGraphError(`Unknown root span ${rootSpanId}`);

  const exclusiveTimeMsBySpanId: Record<string, number> = {};
  const critical = analyzeNode(graph, rootSpanId, exclusiveTimeMsBySpanId, new Set());
  let parallelSiblingOverlapMs = 0;
  for (const node of graph.nodes.values()) {
    const childSpans = node.children
      .map((childId) => graph.nodes.get(childId)?.span)
      .filter((span): span is TraceSpan => span !== undefined);
    const intervals = clippedChildIntervals(node.span, childSpans);
    const summed = intervals.reduce((total, [start, end]) => total + end - start, 0);
    parallelSiblingOverlapMs += Math.max(0, summed - unionDuration(intervals));
  }

  const root = graph.nodes.get(rootSpanId)?.span;
  if (!root) throw new RunGraphError(`Missing root span ${rootSpanId}`);
  return {
    rootSpanId,
    wallClockMs: root.durationMs,
    totalSpanDurationMs: [...graph.nodes.values()].reduce((total, node) => total + node.span.durationMs, 0),
    criticalPathDurationMs: critical.durationMs,
    criticalPathSpanIds: critical.spanIds,
    parallelSiblingOverlapMs,
    exclusiveTimeMsBySpanId,
    orphanSpanIds: graph.orphanSpanIds,
    additionalRootSpanIds: graph.rootSpanIds.filter((id) => id !== rootSpanId),
    completenessScore: graph.completenessScore,
  };
}
