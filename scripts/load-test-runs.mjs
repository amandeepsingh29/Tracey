#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  agentRunsToExecutions,
  pageExecutions,
} from "../apps/api/dist/execution-feed.js";

const executionCount = Number(process.env.TRACEY_RUNS_LOAD_EXECUTIONS ?? 10_000);
const pageSize = Number(process.env.TRACEY_RUNS_LOAD_PAGE_SIZE ?? 100);
const normalizationTargetMs = Number(process.env.TRACEY_RUNS_LOAD_NORMALIZATION_TARGET_MS ?? 2_000);
const paginationP95TargetMs = Number(process.env.TRACEY_RUNS_LOAD_PAGINATION_P95_TARGET_MS ?? 25);
const heapTargetMb = Number(process.env.TRACEY_RUNS_LOAD_HEAP_TARGET_MB ?? 256);

if (!Number.isInteger(executionCount) || executionCount < 1_000 || executionCount > 100_000) {
  throw new Error("TRACEY_RUNS_LOAD_EXECUTIONS must be an integer between 1,000 and 100,000");
}
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
  throw new Error("TRACEY_RUNS_LOAD_PAGE_SIZE must be an integer between 1 and 500");
}

function hex(value, length) {
  return value.toString(16).padStart(length, "0").slice(-length);
}

function buildDataset(count) {
  const runs = [];
  const spansByTraceId = new Map();
  const baseTime = Date.UTC(2026, 6, 29, 0, 0, 0);
  for (let index = 0; index < count; index += 1) {
    const traceId = hex(index + 1, 32);
    const rootSpanId = hex(index * 4 + 1, 16);
    const startedAt = new Date(baseTime - Math.floor(index / 3) * 10).toISOString();
    runs.push({
      traceId,
      runId: `load-run-${String(index).padStart(6, "0")}`,
      serviceName: "load-agent-api",
      outcome: index % 50 === 0 ? "failed" : "succeeded",
      startedAt,
      durationMs: 20 + index % 200,
    });
    spansByTraceId.set(traceId, [
      {
        traceId,
        spanId: rootSpanId,
        parentSpanId: null,
        name: "agent.run",
        serviceName: "load-agent-api",
        startedAt,
        startTimeMs: baseTime - index * 10,
        durationMs: 20 + index % 200,
        statusCode: index % 50 === 0 ? "STATUS_CODE_ERROR" : "STATUS_CODE_OK",
        hasError: index % 50 === 0,
        attributes: {
          "tracey.content.input": `Load-test prompt ${index}`,
          "tracey.content.output": `Load-test response ${index}`,
        },
      },
      {
        traceId,
        spanId: hex(index * 4 + 2, 16),
        parentSpanId: rootSpanId,
        name: "retrieval load-corpus",
        serviceName: "load-agent-api",
        startedAt,
        startTimeMs: baseTime - index * 10 + 1,
        durationMs: 3,
        attributes: { "gen_ai.operation.name": "retrieval" },
      },
      {
        traceId,
        spanId: hex(index * 4 + 3, 16),
        parentSpanId: rootSpanId,
        name: "chat gpt-5-mini",
        serviceName: "load-agent-api",
        startedAt,
        startTimeMs: baseTime - index * 10 + 4,
        durationMs: 12,
        attributes: {
          "gen_ai.response.model": "gpt-5-mini-2025-08-07",
          "gen_ai.usage.input_tokens": 18,
          "gen_ai.usage.output_tokens": 11,
          "tracey.cost.usd": 0.0000265,
        },
      },
      {
        traceId,
        spanId: hex(index * 4 + 4, 16),
        parentSpanId: rootSpanId,
        name: "execute_tool load_lookup",
        serviceName: "load-agent-api",
        startedAt,
        startTimeMs: baseTime - index * 10 + 17,
        durationMs: 2,
        attributes: { "gen_ai.tool.name": "load_lookup" },
      },
    ]);
  }
  return { runs, spansByTraceId };
}

const heapBefore = process.memoryUsage().heapUsed;
const dataset = buildDataset(executionCount);
const normalizeStartedAt = performance.now();
const executions = agentRunsToExecutions({
  sourceId: "agent:load",
  producerType: "custom_otel",
  producerName: "Runs load agent",
  serviceName: "load-agent-api",
  environment: "production",
  contractVersion: "1.0.0",
  runs: dataset.runs,
  spansByTraceId: dataset.spansByTraceId,
});
const normalizationMs = performance.now() - normalizeStartedAt;

const paginationStartedAt = performance.now();
const pageDurations = [];
let pagedCount = 0;
let previousStartedAt = Number.POSITIVE_INFINITY;
let previousExecutionId = "";
for (let offset = 0; offset < executions.length; offset += pageSize) {
  const pageStartedAt = performance.now();
  const page = pageExecutions(executions, { offset, limit: pageSize });
  pageDurations.push(performance.now() - pageStartedAt);
  for (const execution of page.executions) {
    const timestamp = Date.parse(execution.startedAt);
    if (timestamp > previousStartedAt) throw new Error("Runs ordering moved forward in time between pages");
    if (timestamp === previousStartedAt && previousExecutionId && execution.executionId < previousExecutionId) {
      throw new Error("Runs tie-break ordering changed between pages");
    }
    previousStartedAt = timestamp;
    previousExecutionId = execution.executionId;
    if (execution.contract.completeness !== 1) throw new Error(`Incomplete load execution ${execution.executionId}`);
    pagedCount += 1;
  }
}
const paginationMs = performance.now() - paginationStartedAt;
const orderedPageDurations = [...pageDurations].sort((left, right) => left - right);
const paginationP95Ms = orderedPageDurations[Math.max(0, Math.ceil(orderedPageDurations.length * 0.95) - 1)] ?? 0;
const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  executions: executionCount,
  spans: executionCount * 4,
  pageSize,
  pages: Math.ceil(executionCount / pageSize),
  normalizationMs: Number(normalizationMs.toFixed(2)),
  fullPaginationTraversalMs: Number(paginationMs.toFixed(2)),
  paginationP95Ms: Number(paginationP95Ms.toFixed(2)),
  heapDeltaMb: Number(heapDeltaMb.toFixed(2)),
  targets: { normalizationTargetMs, paginationP95TargetMs, heapTargetMb },
  assertions: {
    allExecutionsNormalized: executions.length === executionCount,
    allExecutionsPaged: pagedCount === executionCount,
    stableOrdering: true,
    completeContract: true,
    normalizationWithinTarget: normalizationMs <= normalizationTargetMs,
    paginationP95WithinTarget: paginationP95Ms <= paginationP95TargetMs,
    heapWithinTarget: heapDeltaMb <= heapTargetMb,
  },
};

const failed = Object.entries(report.assertions).filter(([, passed]) => !passed).map(([name]) => name);
await mkdir(resolve(".tracey/reports"), { recursive: true });
await writeFile(resolve(".tracey/reports/runs-load.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) throw new Error(`Runs load targets failed: ${failed.join(", ")}`);
