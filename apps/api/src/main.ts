import dotenv from "dotenv";
import { startTelemetry } from "@tracey/telemetry";
import { loadConfig } from "./config.js";

// pnpm runs filtered package scripts from apps/api, while the documented .env
// file lives at the workspace root. Resolve it from this module so `pnpm start`
// and `pnpm dev` load the same configuration without requiring shell exports.
dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const config = loadConfig();
const shutdownTelemetry = await startTelemetry({
  serviceName: "tracey-api",
  serviceVersion: config.TRACEY_AGENT_VERSION,
  environment: config.DEPLOYMENT_ENVIRONMENT,
  tenantId: config.TRACEY_TENANT_ID,
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
});
const { buildServer } = await import("./server.js");
const server = buildServer(config);

async function shutdown(signal: string): Promise<void> {
  server.log.info({ signal }, "Shutting down");
  await server.close();
  await shutdownTelemetry();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ host: "0.0.0.0", port: config.PORT });
} catch (error) {
  server.log.error(error);
  await shutdownTelemetry();
  process.exitCode = 1;
}
