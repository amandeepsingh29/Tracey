import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: ".env", quiet: true });

const apiBase = process.env.TRACEY_API_URL ?? "http://127.0.0.1:3000";
const token = process.env.TRACEY_API_BEARER_TOKEN;
const collector = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const environment = process.env.DEPLOYMENT_ENVIRONMENT ?? "development";
const tenantId = process.env.TRACEY_TENANT_ID ?? "default";
if (!token) throw new Error("TRACEY_API_BEARER_TOKEN is required");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const request = async (path, init = {}) => {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${payload.error ?? "unknown error"}`);
  return payload;
};
const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0
    ? resolve(stdout.trim())
    : reject(new Error(`${command} exited ${code}: ${(stderr || stdout).trim()}`)));
});

const suffix = Date.now().toString(36);
const producers = [
  {
    language: "node",
    displayName: "Tracey E2E Node",
    serviceName: `tracey-e2e-node-${suffix}`,
    command: "pnpm",
    args: ["--filter", "@tracey/example-node-agent", "exec", "tsx", "run.ts"],
  },
  {
    language: "python",
    displayName: "Tracey E2E Python",
    serviceName: `tracey-e2e-python-${suffix}`,
    command: ".tracey/python-e2e/bin/python",
    args: ["examples/agents/python/run.py"],
  },
  {
    language: "otlp",
    displayName: "Tracey E2E Generic OTLP",
    serviceName: `tracey-e2e-otlp-${suffix}`,
    command: "node",
    args: ["examples/agents/generic-otlp/send-run.mjs"],
  },
];

for (const producer of producers) {
  const generated = await request("/v1/agents/setup", {
    method: "POST",
    body: JSON.stringify({
      sourceId: "generic-otel",
      language: producer.language,
      displayName: producer.displayName,
      serviceName: producer.serviceName,
      environment,
    }),
  });
  if (generated.endpoint.replace(/\/$/, "") !== collector.replace(/\/v1\/traces$/, "").replace(/\/$/, "")) {
    throw new Error(`${producer.language} setup did not use the configured collector`);
  }
  producer.registration = await request("/v1/agents", {
    method: "POST",
    body: JSON.stringify({
      sourceId: "generic-otel",
      displayName: producer.displayName,
      serviceName: producer.serviceName,
      environment,
    }),
  });
}

const beforeEnd = Date.now();
const before = await request(`/v1/executions?start=${beforeEnd - 3_600_000}&end=${beforeEnd}&limit=500`);
for (const producer of producers) {
  const sourceId = `agent:${producer.registration.agentId}`;
  if (before.executions.some((execution) => execution.sourceId === sourceId)) {
    throw new Error(`${producer.language} had telemetry before its sample executed`);
  }
}

for (const producer of producers) {
  const output = await run(producer.command, producer.args, {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector,
    OTEL_SERVICE_NAME: producer.serviceName,
    DEPLOYMENT_ENVIRONMENT: environment,
    TRACEY_TENANT_ID: tenantId,
    TRACEY_AGENT_NAME: producer.displayName,
    TRACEY_AGENT_VERSION: "1.0.0",
  });
  producer.emission = JSON.parse(output.split("\n").at(-1));
}

const deadline = Date.now() + 180_000;
let observed = new Map();
while (Date.now() < deadline) {
  const end = Date.now();
  const feed = await request(`/v1/executions?start=${end - 3_600_000}&end=${end}&limit=500`);
  observed = new Map(producers.map((producer) => {
    const sourceId = `agent:${producer.registration.agentId}`;
    return [producer.language, feed.executions.find((execution) =>
      execution.sourceId === sourceId && execution.traceId === producer.emission.traceId)];
  }));
  if ([...observed.values()].every(Boolean)) break;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

const requiredFields = ["prompt", "response", "model", "retrieval", "tools", "errors", "tokens", "cost", "latency"];
const result = producers.map((producer) => {
  const execution = observed.get(producer.language);
  if (!execution) throw new Error(`${producer.language} execution was not observed before the deadline`);
  const missing = requiredFields.filter((field) => !execution.contract.fields[field]);
  if (missing.length) throw new Error(`${producer.language} is missing contract evidence: ${missing.join(", ")}`);
  if (!execution.model || !execution.tools.includes("list_tickets") || !execution.inputTokens || !execution.outputTokens || !execution.costUsd) {
    throw new Error(`${producer.language} execution metadata is incomplete`);
  }
  return {
    language: producer.language,
    agentId: producer.registration.agentId,
    serviceName: producer.serviceName,
    runId: execution.runId,
    traceId: execution.traceId,
    status: execution.status,
    completeness: execution.contract.completeness,
    model: execution.model,
    tools: execution.tools,
    tokens: (execution.inputTokens ?? 0) + (execution.outputTokens ?? 0),
    costUsd: execution.costUsd,
    durationMs: execution.durationMs,
  };
});

console.log(JSON.stringify({
  verifiedAt: new Date().toISOString(),
  traceyRestartedAfterRegistration: false,
  registrationsInitiallyUnobserved: true,
  producers: result,
}, null, 2));
