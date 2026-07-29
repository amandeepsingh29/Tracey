import { z } from "zod";
import type { AgentSetupLanguage } from "@tracey/connectors";

export const AgentSetupRequestSchema = z.object({
  sourceId: z.string().trim().min(1).max(128),
  language: z.enum(["python", "node", "otlp"]),
  displayName: z.string().trim().min(1).max(128),
  serviceName: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_.\-/]+$/),
  environment: z.string().trim().min(1).max(128),
});

export type AgentSetupRequest = z.infer<typeof AgentSetupRequestSchema>;

export type GeneratedAgentSetup = {
  language: AgentSetupLanguage;
  languageName: string;
  endpoint: string;
  installCommands: string[];
  environment: string;
  code: string;
  runCommand: string;
  contractVersion: string;
  expectedSpans: string[];
};

function baseEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "").replace(/\/v1\/(?:traces|metrics|logs)$/, "");
}

function quoted(value: string) {
  return JSON.stringify(value);
}

function environmentBlock(input: AgentSetupRequest, endpoint: string, tenantId: string) {
  return [
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    `OTEL_SERVICE_NAME=${input.serviceName}`,
    `DEPLOYMENT_ENVIRONMENT=${input.environment}`,
    `TRACEY_AGENT_NAME=${input.displayName}`,
    "TRACEY_AGENT_VERSION=1.0.0",
    `TRACEY_TENANT_ID=${tenantId}`,
  ].join("\n");
}

function pythonCode() {
  return `import os
import time
import uuid
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status, StatusCode

resource = Resource.create({
    "service.name": os.environ["OTEL_SERVICE_NAME"],
    "deployment.environment.name": os.environ["DEPLOYMENT_ENVIRONMENT"],
    "tracey.tenant.id": os.environ["TRACEY_TENANT_ID"],
})
provider = TracerProvider(resource=resource)
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(
    endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"].rstrip("/") + "/v1/traces"
)))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("tracey.sample.python", "1.0.0")

prompt = "Summarize the active support queue"
run_id = "python-" + uuid.uuid4().hex
with tracer.start_as_current_span("agent.run") as run:
    run.set_attributes({
        "tracey.run.id": run_id,
        "tracey.agent.name": os.environ["TRACEY_AGENT_NAME"],
        "tracey.agent.version": os.environ["TRACEY_AGENT_VERSION"],
        "tracey.user.outcome": "resolved",
        "tracey.content.capture": "full",
        "tracey.content.input": prompt,
    })
    with tracer.start_as_current_span("retrieval support-knowledge") as retrieval:
        retrieval.set_attributes({
            "gen_ai.operation.name": "retrieval",
            "tracey.retriever.name": "support-knowledge",
            "tracey.result.count": 1,
            "tracey.result.max_score": 0.94,
        })
    with tracer.start_as_current_span("chat openai/gpt-5-mini") as model:
        model.set_attributes({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-5-mini",
            "gen_ai.response.model": "gpt-5-mini-2025-08-07",
            "gen_ai.usage.input_tokens": 18,
            "gen_ai.usage.output_tokens": 11,
            "tracey.cost.usd": 0.0000093,
            "tracey.content.capture": "full",
            "tracey.content.input": prompt,
            "tracey.content.output": "I should inspect the support queue.",
        })
    with tracer.start_as_current_span("execute_tool list_tickets") as tool:
        tool.set_attributes({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "list_tickets",
            "tracey.tool.side_effect": "read",
            "tracey.tool.result.class": "success",
            "tracey.content.capture": "full",
            "tracey.content.input": '{"status":"active"}',
            "tracey.content.output": '{"count":3}',
        })
    answer = "There are 3 active support tickets."
    run.set_attribute("tracey.content.output", answer)
    run.set_status(Status(StatusCode.OK))

provider.shutdown()
print(run_id)`;
}

function nodeCode() {
  return `import { trace, SpanStatusCode } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\\/$/, "");
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    "service.name": process.env.OTEL_SERVICE_NAME,
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT,
    "tracey.tenant.id": process.env.TRACEY_TENANT_ID,
  }),
  traceExporter: new OTLPTraceExporter({ url: \`\${endpoint}/v1/traces\` }),
});
sdk.start();
const tracer = trace.getTracer("tracey.sample.node", "1.0.0");
const runId = \`node-\${crypto.randomUUID()}\`;
const prompt = "Summarize the active support queue";

await tracer.startActiveSpan("agent.run", async (run) => {
  run.setAttributes({
    "tracey.run.id": runId,
    "tracey.agent.name": process.env.TRACEY_AGENT_NAME,
    "tracey.agent.version": process.env.TRACEY_AGENT_VERSION,
    "tracey.user.outcome": "resolved",
    "tracey.content.capture": "full",
    "tracey.content.input": prompt,
  });
  await tracer.startActiveSpan("retrieval support-knowledge", async (retrieval) => {
    retrieval.setAttributes({
      "gen_ai.operation.name": "retrieval",
      "tracey.retriever.name": "support-knowledge",
      "tracey.result.count": 1,
      "tracey.result.max_score": 0.94,
    });
    retrieval.end();
  });
  await tracer.startActiveSpan("chat openai/gpt-5-mini", async (model) => {
    model.setAttributes({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5-mini",
      "gen_ai.response.model": "gpt-5-mini-2025-08-07",
      "gen_ai.usage.input_tokens": 18,
      "gen_ai.usage.output_tokens": 11,
      "tracey.cost.usd": 0.0000093,
      "tracey.content.capture": "full",
      "tracey.content.input": prompt,
      "tracey.content.output": "I should inspect the support queue.",
    });
    model.end();
  });
  await tracer.startActiveSpan("execute_tool list_tickets", async (tool) => {
    tool.setAttributes({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "list_tickets",
      "tracey.tool.side_effect": "read",
      "tracey.tool.result.class": "success",
      "tracey.content.capture": "full",
      "tracey.content.input": '{"status":"active"}',
      "tracey.content.output": '{"count":3}',
    });
    tool.end();
  });
  run.setAttribute("tracey.content.output", "There are 3 active support tickets.");
  run.setStatus({ code: SpanStatusCode.OK });
  run.end();
});

await sdk.shutdown();
console.log(runId);`;
}

function otlpPayload(input: AgentSetupRequest, tenantId: string) {
  const now = Date.now() * 1_000_000;
  const end = now + 50_000_000;
  const traceId = "0123456789abcdef0123456789abcdef";
  const resource = [
    { key: "service.name", value: { stringValue: input.serviceName } },
    { key: "deployment.environment.name", value: { stringValue: input.environment } },
    { key: "tracey.tenant.id", value: { stringValue: tenantId } },
  ];
  const attrs = (values: Record<string, string | number>) => Object.entries(values).map(([key, value]) => ({
    key,
    value: typeof value === "number"
      ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
      : { stringValue: value },
  }));
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: resource },
      scopeSpans: [{
        scope: { name: "tracey.sample.otlp", version: "1.0.0" },
        spans: [
          {
            traceId, spanId: "0123456789abcdef", name: "agent.run",
            startTimeUnixNano: String(now), endTimeUnixNano: String(end),
            status: { code: 1 },
            attributes: attrs({
              "tracey.run.id": `otlp-${Date.now()}`,
              "tracey.agent.name": input.displayName,
              "tracey.agent.version": "1.0.0",
              "tracey.user.outcome": "resolved",
              "tracey.content.capture": "full",
              "tracey.content.input": "Summarize the active support queue",
              "tracey.content.output": "There are 3 active support tickets.",
            }),
          },
          {
            traceId, spanId: "3123456789abcdef", parentSpanId: "0123456789abcdef",
            name: "retrieval support-knowledge", startTimeUnixNano: String(now + 1_000_000),
            endTimeUnixNano: String(now + 4_000_000), status: { code: 1 },
            attributes: attrs({
              "gen_ai.operation.name": "retrieval",
              "tracey.retriever.name": "support-knowledge",
              "tracey.result.count": 1,
              "tracey.result.max_score": 0.94,
            }),
          },
          {
            traceId, spanId: "1123456789abcdef", parentSpanId: "0123456789abcdef",
            name: "chat openai/gpt-5-mini", startTimeUnixNano: String(now + 5_000_000),
            endTimeUnixNano: String(now + 25_000_000), status: { code: 1 },
            attributes: attrs({
              "gen_ai.operation.name": "chat",
              "gen_ai.provider.name": "openai",
              "gen_ai.request.model": "gpt-5-mini",
              "gen_ai.response.model": "gpt-5-mini-2025-08-07",
              "gen_ai.usage.input_tokens": 18,
              "gen_ai.usage.output_tokens": 11,
              "tracey.cost.usd": 0.0000093,
            }),
          },
          {
            traceId, spanId: "2123456789abcdef", parentSpanId: "0123456789abcdef",
            name: "execute_tool list_tickets", startTimeUnixNano: String(now + 28_000_000),
            endTimeUnixNano: String(now + 45_000_000), status: { code: 1 },
            attributes: attrs({
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": "list_tickets",
              "tracey.tool.side_effect": "read",
              "tracey.tool.result.class": "success",
            }),
          },
        ],
      }],
    }],
  }, null, 2);
}

export function generateAgentSetup(
  input: AgentSetupRequest,
  config: { otlpEndpoint: string; tenantId: string; contractVersion: string },
): GeneratedAgentSetup {
  const endpoint = baseEndpoint(config.otlpEndpoint);
  const shared = {
    endpoint,
    environment: environmentBlock(input, endpoint, config.tenantId),
    contractVersion: config.contractVersion,
    expectedSpans: ["agent.run", "retrieval <source>", "chat <model>", "execute_tool <tool>"],
  };
  if (input.language === "python") return {
    ...shared,
    language: "python",
    languageName: "Python",
    installCommands: ["python -m pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp-proto-http"],
    code: pythonCode(),
    runCommand: "python tracey_agent.py",
  };
  if (input.language === "node") return {
    ...shared,
    language: "node",
    languageName: "Node.js",
    installCommands: ["pnpm add @opentelemetry/api @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/sdk-node"],
    code: nodeCode(),
    runCommand: "node tracey-agent.mjs",
  };
  return {
    ...shared,
    language: "otlp",
    languageName: "Generic OTLP",
    installCommands: [],
    code: `curl --fail-with-body \\\n  -H "Content-Type: application/json" \\\n  --data-binary @tracey-run.json \\\n  ${quoted(`${endpoint}/v1/traces`)}\n\n# tracey-run.json\n${otlpPayload(input, config.tenantId)}`,
    runCommand: "Run the curl command above",
  };
}
