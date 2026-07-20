import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  tenantId: string;
  otlpEndpoint: string;
  headers?: Record<string, string>;
}

function signalUrl(endpoint: string, signal: "traces" | "metrics" | "logs"): string {
  const normalized = endpoint.replace(/\/$/, "");
  if (/\/v1\/(traces|metrics|logs)$/.test(normalized)) {
    return normalized.replace(/\/v1\/(traces|metrics|logs)$/, `/v1/${signal}`);
  }
  return `${normalized}/v1/${signal}`;
}

export async function startTelemetry(config: TelemetryConfig): Promise<() => Promise<void>> {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    "tracey.tenant.id": config.tenantId,
  });
  const exporterOptions = config.headers ? { headers: config.headers } : {};

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: signalUrl(config.otlpEndpoint, "logs"),
          ...exporterOptions,
        }),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: signalUrl(config.otlpEndpoint, "traces"),
      ...exporterOptions,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: signalUrl(config.otlpEndpoint, "metrics"),
        ...exporterOptions,
      }),
      exportIntervalMillis: 10_000,
    }),
  });

  sdk.start();

  return async () => {
    await Promise.all([sdk.shutdown(), loggerProvider.shutdown()]);
  };
}
