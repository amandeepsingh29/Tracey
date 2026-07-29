import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { z } from "zod";
import {
  buildAgentRunMetricsQuery,
  buildAgentRunsQuery,
  buildCodexConversationLogsQuery,
  buildCodexRecentLogsQuery,
  buildCohortSpansQuery,
  buildSigNozMetricAttributes,
  buildServiceSpansQuery,
  buildServiceHealthQuery,
  buildTraceLogsQuery,
  buildTraceSpansQuery,
  classifySigNozQueryError,
  SigNozAdapter,
  SigNozAdapterError,
} from "./signoz-adapter.js";

const scope = { tenantId: "tenant-a", environment: "test" };

describe("buildAgentRunsQuery", () => {
  it("builds the documented SigNoz v5 raw trace query", () => {
    const query = buildAgentRunsQuery({
      start: 1_700_000_000_000,
      end: 1_700_000_060_000,
      serviceName: "tracey-api",
      runId: "run_123",
      limit: 25,
      offset: 0,
    }, scope) as {
      requestType: string;
      compositeQuery: { queries: Array<{ spec: { signal: string; filter: { expression: string } } }> };
    };

    assert.equal(query.requestType, "raw");
    assert.equal(query.compositeQuery.queries[0]?.spec.signal, "traces");
    assert.equal(
      query.compositeQuery.queries[0]?.spec.filter.expression,
      "service.name = 'tracey-api' AND name = 'agent.run' AND parent_span_id = '' AND tracey.tenant.id = 'tenant-a' AND deployment.environment.name = 'test' AND tracey.run.id = 'run_123'",
    );
  });

  it("escapes filter literals instead of accepting arbitrary expressions", () => {
    const query = buildAgentRunsQuery({
      start: 1,
      end: 2,
      serviceName: "service' OR true",
      limit: 1,
      offset: 0,
    }, scope) as {
      compositeQuery: { queries: Array<{ spec: { filter: { expression: string } } }> };
    };

    assert.match(
      query.compositeQuery.queries[0]?.spec.filter.expression ?? "",
      /service\\' OR true/,
    );
  });

  it("uses only root-contract fields when discovering custom agents", () => {
    const query = buildAgentRunsQuery({
      start: 1,
      end: 2,
      serviceName: "sample-agent-api",
      limit: 1,
      offset: 0,
    }, scope, "custom_otel") as {
      compositeQuery: { queries: Array<{ spec: { selectFields: Array<{ name: string }> } }> };
    };
    const selected = query.compositeQuery.queries[0]?.spec.selectFields.map(({ name }) => name) ?? [];
    assert.ok(selected.includes("tracey.run.id"));
    assert.ok(selected.includes("tracey.agent.name"));
    assert.ok(selected.includes("tracey.user.outcome"));
    assert.ok(!selected.includes("gen_ai.tool.name"));
    assert.ok(!selected.includes("tracey.retriever.name"));
  });

  it("selects the native Claude Code root from the registered producer type", () => {
    const query = buildAgentRunsQuery({
      start: 1_700_000_000_000,
      end: 1_700_000_060_000,
      serviceName: "claude-code",
      runId: `claude:${"a".repeat(32)}`,
      limit: 25,
      offset: 0,
    }, scope, "claude_code") as {
      compositeQuery: { queries: Array<{ spec: { filter: { expression: string }; selectFields: Array<{ name: string }> } }> };
    };

    assert.equal(
      query.compositeQuery.queries[0]?.spec.filter.expression,
      `service.name = 'claude-code' AND name = 'claude_code.interaction' AND parent_span_id = '' AND tracey.tenant.id = 'tenant-a' AND deployment.environment.name = 'test' AND trace_id = '${"a".repeat(32)}'`,
    );
    const selected = query.compositeQuery.queries[0]?.spec.selectFields.map(({ name }) => name) ?? [];
    assert.ok(selected.includes("trace_id"));
    assert.ok(selected.includes("service.name"));
    assert.ok(!selected.includes("tracey.run.id"));
    assert.throws(
      () => buildAgentRunsQuery({
        start: 1,
        end: 2,
        serviceName: "claude-code",
        runId: "arbitrary-filter",
        limit: 1,
        offset: 0,
      }, scope, "claude_code"),
      z.ZodError,
    );
  });
});

describe("adapter telemetry classification", () => {
  it("maps failures to a bounded outcome vocabulary", () => {
    assert.equal(
      classifySigNozQueryError(
        new SigNozAdapterError("request timed out", undefined, { kind: "timeout" }),
      ),
      "timeout",
    );
    assert.equal(
      classifySigNozQueryError(new SigNozAdapterError("bad gateway", 502, { kind: "http_error" })),
      "http_error",
    );
    const invalid = z.string().safeParse(42);
    assert.equal(invalid.success, false);
    if (!invalid.success) assert.equal(classifySigNozQueryError(invalid.error), "invalid_request");
    assert.equal(classifySigNozQueryError(new Error("unexpected")), "internal_error");
  });

  it("uses only bounded operation and outcome metric dimensions", () => {
    const attributes = buildSigNozMetricAttributes("trace_spans", "invalid_response");
    assert.deepEqual(attributes, {
      "tracey.signoz.operation": "trace_spans",
      "tracey.signoz.outcome": "invalid_response",
    });
    assert.ok(!Object.keys(attributes).some((key) => /key|credential|payload|body|query/i.test(key)));
  });

  it("records real adapter metrics for locally rejected input without issuing a network request", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    const adapter = new SigNozAdapter({
      baseUrl: "https://signoz.invalid",
      apiKey: "not-exported",
      scope,
    });

    await assert.rejects(
      adapter.searchAgentRuns({
        start: 2,
        end: 1,
        serviceName: "tracey-api",
        limit: 1,
        offset: 0,
      }),
      z.ZodError,
    );
    await provider.forceFlush();

    const exported = exporter.getMetrics();
    const metricData = exported.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) => scope.metrics),
    );
    assert.ok(metricData.some((metric) => metric.descriptor.name === "tracey.signoz.adapter.requests"));
    assert.ok(metricData.some((metric) => metric.descriptor.name === "tracey.signoz.adapter.errors"));
    assert.ok(metricData.some((metric) => metric.descriptor.name === "tracey.signoz.adapter.duration"));
    const attributeSets = metricData.flatMap((metric) => metric.dataPoints.map((point) => point.attributes));
    assert.ok(attributeSets.some((attributes) => attributes["tracey.signoz.outcome"] === "invalid_request"));
    assert.ok(attributeSets.every((attributes) => !Object.values(attributes).includes("not-exported")));
    await provider.shutdown();
  });
});

describe("multi-signal query contracts", () => {
  const traceSearch = {
    start: 1_700_000_000_000,
    end: 1_700_000_060_000,
    traceId: "a".repeat(32),
    limit: 100,
  };

  it("uses bounded builder queries for trace spans and logs", () => {
    const spans = buildTraceSpansQuery(traceSearch, scope) as {
      compositeQuery: { queries: Array<{ spec: { signal: string; limit: number; filter: { expression: string }; selectFields: Array<{ name: string }> } }> };
    };
    const logs = buildTraceLogsQuery(traceSearch, scope) as {
      compositeQuery: { queries: Array<{ spec: { signal: string; limit: number; filter: { expression: string }; selectFields: Array<{ name: string }> } }> };
    };

    assert.equal(spans.compositeQuery.queries[0]?.spec.signal, "traces");
    assert.equal(spans.compositeQuery.queries[0]?.spec.limit, 100);
    assert.equal(logs.compositeQuery.queries[0]?.spec.signal, "logs");
    assert.equal(logs.compositeQuery.queries[0]?.spec.limit, 100);
    const spanFields = spans.compositeQuery.queries[0]?.spec.selectFields.map(({ name }) => name) ?? [];
    assert.ok(spanFields.includes("tracey.result.count"));
    assert.ok(spanFields.includes("tracey.context.truncated"));
    assert.ok(spanFields.includes("tracey.decision.correct"));
    assert.ok(spanFields.includes("tracey.model.route"));
    assert.ok(spanFields.includes("tracey.tool.schema.version"));
    const logFields = logs.compositeQuery.queries[0]?.spec.selectFields.map(({ name }) => name) ?? [];
    assert.ok(logFields.includes("tracey.feedback.source"));
    assert.ok(logFields.includes("tracey.feedback.label"));
    assert.ok(logFields.includes("tracey.feedback.score"));
    for (const query of [spans, logs]) {
      const expression = query.compositeQuery.queries[0]?.spec.filter.expression ?? "";
      assert.match(expression, /tracey\.tenant\.id = 'tenant-a'/);
      assert.match(expression, /deployment\.environment\.name = 'test'/);
    }
  });

  it("queries all spans for one registered service with the configured scope", () => {
    const query = buildServiceSpansQuery({
      serviceName: "notes-agent-api",
      start: traceSearch.start,
      end: traceSearch.end,
      limit: 500,
    }, scope) as {
      compositeQuery: { queries: Array<{ spec: {
        signal: string;
        limit: number;
        filter: { expression: string };
        selectFields: Array<{ name: string }>;
      } }> };
    };
    const spec = query.compositeQuery.queries[0]?.spec;

    assert.equal(spec?.signal, "traces");
    assert.equal(spec?.limit, 500);
    assert.equal(
      spec?.filter.expression,
      "service.name = 'notes-agent-api' AND tracey.tenant.id = 'tenant-a' AND deployment.environment.name = 'test'",
    );
    const fields = spec?.selectFields.map(({ name }) => name) ?? [];
    assert.ok(fields.includes("trace_id"));
    assert.ok(fields.includes("tracey.content.input"));
    assert.ok(fields.includes("tracey.content.output"));
    assert.ok(fields.includes("gen_ai.usage.input_tokens"));
    assert.ok(fields.includes("tracey.cost.usd"));
  });

  it("builds cohort queries from enumerated dimensions with fixed scope", () => {
    const query = buildCohortSpansQuery(
      {
        start: traceSearch.start,
        end: traceSearch.end,
        serviceName: "tracey-api",
        dimension: "prompt_version",
        baseline: "support@1",
        candidate: "support@2",
        maxSpansPerCohort: 2_000,
        minSampleSize: 30,
      },
      scope,
      "support@2",
      { limit: 1_500 },
    ) as {
      compositeQuery: { queries: Array<{ spec: { limit: number; filter: { expression: string } } }> };
    };
    const spec = query.compositeQuery.queries[0]?.spec;
    assert.equal(spec?.limit, 1_000);
    assert.match(spec?.filter.expression ?? "", /tracey\.prompt\.version = 'support@2'/);
    assert.match(spec?.filter.expression ?? "", /tracey\.tenant\.id = 'tenant-a'/);
    assert.match(spec?.filter.expression ?? "", /deployment\.environment\.name = 'test'/);
  });

  it("builds a bounded Codex conversation query without identity or content fields", () => {
    const query = buildCodexConversationLogsQuery({
      start: traceSearch.start,
      end: traceSearch.end,
      conversationId: "019f692d-ffde-77d1-a3e0-14b849467fdd",
      serviceName: "Codex Desktop",
      limit: 5_000,
    }, scope) as {
      compositeQuery: {
        queries: Array<{ spec: { limit: number; filter: { expression: string }; selectFields: Array<{ name: string }> } }>;
      };
    };
    const spec = query.compositeQuery.queries[0]?.spec;
    assert.equal(spec?.limit, 1_000);
    assert.match(spec?.filter.expression ?? "", /conversation\.id = '019f692d-ffde-77d1-a3e0-14b849467fdd'/);
    assert.match(spec?.filter.expression ?? "", /tracey\.tenant\.id = 'tenant-a'/);
    const fields = spec?.selectFields.map(({ name }) => name) ?? [];
    assert.ok(fields.includes("event.name"));
    assert.ok(fields.includes("input_token_count"));
    assert.ok(fields.includes("tool_name"));
    assert.ok(!fields.includes("user.email"));
    assert.ok(!fields.includes("user.account_id"));
    assert.ok(!fields.includes("prompt"));
    assert.ok(!fields.includes("output"));
  });

  it("builds a privacy-safe recent Codex log query without requiring a conversation ID", () => {
    const query = buildCodexRecentLogsQuery({
      start: traceSearch.start,
      end: traceSearch.end,
      serviceName: "codex-app-server",
      limit: 500,
    }, scope) as {
      compositeQuery: { queries: Array<{ spec: { limit: number; filter: { expression: string }; selectFields: Array<{ name: string }> } }> };
    };
    const spec = query.compositeQuery.queries[0]!.spec;
    assert.equal(spec.limit, 500);
    assert.match(spec.filter.expression, /service\.name = 'codex-app-server'/);
    assert.doesNotMatch(spec.filter.expression, /conversation\.id/);
    assert.match(spec.filter.expression, /tracey\.tenant\.id = 'tenant-a'/);
    const fields = spec.selectFields.map(({ name }) => name);
    assert.ok(fields.includes("conversation.id"));
    assert.ok(fields.includes("tool_name"));
    assert.ok(!fields.includes("prompt"));
    assert.ok(!fields.includes("output"));
  });

  it("queries the emitted agent run counter instead of returning placeholder values", () => {
    const metrics = buildAgentRunMetricsQuery({
      start: traceSearch.start,
      end: traceSearch.end,
      serviceName: "tracey-api",
      stepInterval: 60,
    }, scope) as {
      compositeQuery: {
        queries: Array<{
          spec: {
            signal: string;
            aggregations: Array<{ metricName: string; timeAggregation: string }>;
            filter: { expression: string };
          };
        }>;
      };
    };

    assert.equal(metrics.compositeQuery.queries[0]?.spec.signal, "metrics");
    assert.equal(metrics.compositeQuery.queries[0]?.spec.aggregations[0]?.metricName, "tracey.agent.runs");
    assert.equal(metrics.compositeQuery.queries[0]?.spec.aggregations[0]?.timeAggregation, "increase");
    const expression = metrics.compositeQuery.queries[0]?.spec.filter.expression ?? "";
    assert.match(expression, /tracey\.tenant\.id = 'tenant-a'/);
    assert.match(expression, /deployment\.environment\.name = 'test'/);
  });

  it("builds a bounded, tenant-scoped service health query", () => {
    const query = buildServiceHealthQuery({
      start: traceSearch.start,
      end: traceSearch.end,
      serviceName: "sample-api' OR true",
    }, scope) as { compositeQuery: { queries: Array<{ spec: { limit: number; filter: { expression: string }; selectFields: Array<{ name: string }> } }> } };
    const spec = query.compositeQuery.queries[0]?.spec;
    assert.equal(spec?.limit, 1_000);
    assert.match(spec?.filter.expression ?? "", /sample-api\\' OR true/);
    assert.match(spec?.filter.expression ?? "", /tracey\.tenant\.id = 'tenant-a'/);
    assert.deepEqual(spec?.selectFields.map(({ name }) => name).slice(0, 3), ["duration_nano", "status_code", "has_error"]);
  });

  it("computes error rate and p95 from real SigNoz rows", async (context) => {
    context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
      status: "success",
      data: { type: "raw", data: { results: [{ queryName: "A", rows: [
        { timestamp: "2026-07-18T00:00:00Z", data: { duration_nano: "1000000", has_error: false } },
        { timestamp: "2026-07-18T00:00:01Z", data: { duration_nano: "3000000", has_error: true } },
        { timestamp: "2026-07-18T00:00:02Z", data: { duration_nano: "2000000", status_code: "OK" } },
      ] }] }, meta: { rowsScanned: 3 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new SigNozAdapter({ baseUrl: "https://signoz.invalid", apiKey: "secret", scope });
    const snapshot = await adapter.getServiceHealthSnapshot({
      serviceName: "sample-api", start: traceSearch.start, end: traceSearch.end,
    });
    assert.equal(snapshot.totalSpans, 3);
    assert.equal(snapshot.errorSpans, 1);
    assert.equal(snapshot.errorRate, 1 / 3);
    assert.equal(snapshot.p95LatencyMs, 3);
    assert.equal(snapshot.truncated, false);
  });
});
