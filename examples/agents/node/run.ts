import { createHash, randomUUID } from "node:crypto";
import { startTelemetry } from "@tracey/telemetry";
import { instrumentModelCall, instrumentRetrieval, instrumentToolCall, withAgentRun } from "@tracey/instrumentation";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const serviceName = required("OTEL_SERVICE_NAME");
const environment = required("DEPLOYMENT_ENVIRONMENT");
const tenantId = required("TRACEY_TENANT_ID");
const agentName = required("TRACEY_AGENT_NAME");
const otlpEndpoint = required("OTEL_EXPORTER_OTLP_ENDPOINT");
const prompt = process.argv.slice(2).join(" ") || "Summarize the active support queue";
const answer = "There are 3 active support tickets.";
const runId = `node-${randomUUID()}`;
const stopTelemetry = await startTelemetry({
  serviceName,
  serviceVersion: "1.0.0",
  environment,
  tenantId,
  otlpEndpoint,
});

const result = await withAgentRun({
  runId,
  agentName,
  agentVersion: "1.0.0",
  tenantId,
  environment,
  inputHash: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
  content: { input: prompt, output: answer },
}, async () => {
  await instrumentRetrieval({
    retrieverName: "support-knowledge",
    retrieverVersion: "1.0.0",
    topK: 3,
  }, async () => ({
    value: ["queue policy"],
    telemetry: { resultCount: 1, maxScore: 0.94, contextTokens: 36 },
  }));
  await instrumentModelCall({
    providerName: "openai",
    requestModel: "gpt-5-mini",
    operationName: "chat",
    content: { input: prompt, output: "I should inspect the support queue." },
  }, async () => ({
    value: "I should inspect the support queue.",
    telemetry: {
      responseModel: "gpt-5-mini-2025-08-07",
      responseId: `response-${randomUUID()}`,
      inputTokens: 18,
      outputTokens: 11,
      finishReasons: ["tool_calls"],
    },
  }));
  await instrumentToolCall({
    toolName: "list_tickets",
    toolVersion: "1.0.0",
    transport: "in_process",
    sideEffect: "read",
    content: { input: "{\"status\":\"active\"}", output: "{\"count\":3}" },
  }, async () => ({ count: 3 }));
  return answer;
});

await stopTelemetry();
console.log(JSON.stringify({ runId, traceId: result.traceId, serviceName }));
