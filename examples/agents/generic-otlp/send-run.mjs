import { randomBytes, randomUUID } from "node:crypto";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const attribute = (key, value) => ({
  key,
  value: typeof value === "number"
    ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    : { stringValue: value },
});
const attrs = (values) => Object.entries(values).map(([key, value]) => attribute(key, value));
const serviceName = required("OTEL_SERVICE_NAME");
const environment = required("DEPLOYMENT_ENVIRONMENT");
const tenantId = required("TRACEY_TENANT_ID");
const agentName = required("TRACEY_AGENT_NAME");
const endpoint = required("OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/+$/, "");
const traceId = randomBytes(16).toString("hex");
const rootSpanId = randomBytes(8).toString("hex");
const modelSpanId = randomBytes(8).toString("hex");
const toolSpanId = randomBytes(8).toString("hex");
const retrievalSpanId = randomBytes(8).toString("hex");
const runId = `otlp-${randomUUID()}`;
const started = BigInt(Date.now()) * 1_000_000n;
const nano = (offsetMs) => String(started + BigInt(offsetMs) * 1_000_000n);
const payload = {
  resourceSpans: [{
    resource: { attributes: attrs({
      "service.name": serviceName,
      "service.version": "1.0.0",
      "deployment.environment.name": environment,
      "tracey.tenant.id": tenantId,
    }) },
    scopeSpans: [{
      scope: { name: "tracey.sample.generic-otlp", version: "1.0.0" },
      spans: [
        {
          traceId, spanId: rootSpanId, name: "agent.run",
          startTimeUnixNano: nano(0), endTimeUnixNano: nano(55), status: { code: 1 },
          attributes: attrs({
            "tracey.run.id": runId,
            "tracey.agent.name": agentName,
            "tracey.agent.version": "1.0.0",
            "tracey.user.outcome": "resolved",
            "tracey.content.capture": "full",
            "tracey.content.input": "Summarize the active support queue",
            "tracey.content.output": "There are 3 active support tickets.",
          }),
        },
        {
          traceId, spanId: retrievalSpanId, parentSpanId: rootSpanId, name: "retrieval support-knowledge",
          startTimeUnixNano: nano(2), endTimeUnixNano: nano(4), status: { code: 1 },
          attributes: attrs({
            "gen_ai.operation.name": "retrieval",
            "tracey.retriever.name": "support-knowledge",
            "tracey.result.count": 1,
            "tracey.result.max_score": 0.94,
          }),
        },
        {
          traceId, spanId: modelSpanId, parentSpanId: rootSpanId, name: "chat openai/gpt-5-mini",
          startTimeUnixNano: nano(5), endTimeUnixNano: nano(28), status: { code: 1 },
          attributes: attrs({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-5-mini",
            "gen_ai.response.model": "gpt-5-mini-2025-08-07",
            "gen_ai.usage.input_tokens": 18,
            "gen_ai.usage.output_tokens": 11,
            "tracey.cost.usd": 0.0000093,
            "tracey.content.capture": "full",
            "tracey.content.input": "Summarize the active support queue",
            "tracey.content.output": "I should inspect the support queue.",
          }),
        },
        {
          traceId, spanId: toolSpanId, parentSpanId: rootSpanId, name: "execute_tool list_tickets",
          startTimeUnixNano: nano(31), endTimeUnixNano: nano(49), status: { code: 1 },
          attributes: attrs({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "list_tickets",
            "tracey.tool.side_effect": "read",
            "tracey.tool.result.class": "success",
            "tracey.content.capture": "full",
            "tracey.content.input": '{"status":"active"}',
            "tracey.content.output": '{"count":3}',
          }),
        },
      ],
    }],
  }],
};
const response = await fetch(`${endpoint}/v1/traces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
if (!response.ok) throw new Error(`OTLP export failed: ${response.status} ${await response.text()}`);
console.log(JSON.stringify({ runId, traceId, serviceName }));
