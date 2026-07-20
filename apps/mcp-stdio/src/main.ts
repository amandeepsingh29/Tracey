import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InvestigationService } from "@tracey/investigation";
import { createTraceyMcpServer } from "@tracey/mcp-server";
import { SigNozAdapter } from "@tracey/signoz-adapter";
import { startTelemetry } from "@tracey/telemetry";
import { z } from "zod";

const EnvironmentSchema = z.object({
  SIGNOZ_API_URL: z.string().url(),
  SIGNOZ_API_KEY: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  DEPLOYMENT_ENVIRONMENT: z.string().min(1).default("development"),
  TRACEY_AGENT_VERSION: z.string().min(1).default("0.1.0"),
  TRACEY_TENANT_ID: z.string().trim().min(1).max(128).default("local"),
  SIGNOZ_QUERY_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(5_000),
  SIGNOZ_COHORT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(25_000).default(25_000),
});

function loadEnvironment(): z.infer<typeof EnvironmentSchema> {
  const parsed = EnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      "Tracey MCP stdio server requires SIGNOZ_API_URL, SIGNOZ_API_KEY, and OTEL_EXPORTER_OTLP_ENDPOINT.\n",
    );
    process.exit(1);
  }
  return parsed.data;
}

const environment = loadEnvironment();
const shutdownTelemetry = await startTelemetry({
  serviceName: "tracey-mcp-server",
  serviceVersion: environment.TRACEY_AGENT_VERSION,
  environment: environment.DEPLOYMENT_ENVIRONMENT,
  tenantId: environment.TRACEY_TENANT_ID,
  otlpEndpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT,
});

const investigations = new InvestigationService(
  new SigNozAdapter({
    baseUrl: environment.SIGNOZ_API_URL,
    apiKey: environment.SIGNOZ_API_KEY,
    scope: {
      tenantId: environment.TRACEY_TENANT_ID,
      environment: environment.DEPLOYMENT_ENVIRONMENT,
    },
    timeoutMs: environment.SIGNOZ_QUERY_TIMEOUT_MS,
    cohortTimeoutMs: environment.SIGNOZ_COHORT_TIMEOUT_MS,
  }),
);
const server = createTraceyMcpServer(investigations);
const transport = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  await shutdownTelemetry();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("beforeExit", () => void shutdown());

try {
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`Tracey MCP stdio server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdownTelemetry();
  process.exitCode = 1;
}
