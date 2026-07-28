import { z } from "zod";

const OptionalUrlSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const OptionalStringSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DEPLOYMENT_ENVIRONMENT: z.string().min(1).default("development"),
  TRACEY_TENANT_ID: z.string().trim().min(1).max(128).default("local"),
  TRACEY_API_BEARER_TOKEN: OptionalStringSchema,
  TRACEY_API_TOKEN_ID: z.string().trim().min(1).max(64).default("primary"),
  TRACEY_CONNECTOR_ENCRYPTION_KEY: OptionalStringSchema,
  OIDC_ISSUER_URL: OptionalUrlSchema,
  OIDC_JWKS_URL: OptionalUrlSchema,
  OIDC_AUDIENCE: OptionalStringSchema,
  OIDC_TENANT_CLAIM: z.string().trim().min(1).max(128).default("tenant_id"),
  OIDC_ROLES_CLAIM: z.string().trim().min(1).max(128).default("roles"),
  TRACEY_AGENT_VERSION: z.string().min(1).default("0.1.0"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  SIGNOZ_API_URL: OptionalUrlSchema,
  SIGNOZ_API_KEY: OptionalStringSchema,
  SIGNOZ_QUERY_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(5_000),
  SIGNOZ_COHORT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(25_000).default(25_000),
  DATABASE_URL: OptionalStringSchema,
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  POSTGRES_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  OPENROUTER_API_KEY: OptionalStringSchema,
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  TRACEY_AGENT_MODEL: z.string().trim().min(1).max(200).default("tencent/hy3:free"),
  TRACEY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(60_000),
  TRACEY_ACTION_WEBHOOK_URL: OptionalUrlSchema,
  TRACEY_ACTION_WEBHOOK_TOKEN: OptionalStringSchema,
  TRACEY_EXECUTOR_URL: OptionalUrlSchema,
  TRACEY_EXECUTOR_BEARER_TOKEN: OptionalStringSchema,
  TRACEY_KUBERNETES_EXECUTOR_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  TRACEY_KUBERNETES_INVESTIGATOR_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
  TRACEY_KUBERNETES_ALLOWED_NAMESPACES: z.string().default(""),
  TRACEY_KUBERNETES_ALLOWED_WORKLOADS: z.string().default(""),
  MCP_SERVER_URL: OptionalUrlSchema,
  MCP_SERVER_NAME: z.string().min(1).max(128).default("configured-mcp"),
  MCP_BEARER_TOKEN: OptionalStringSchema,
  MCP_ALLOWED_READ_TOOLS: z.string().default(""),
  MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(10_000),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(250).max(120_000).default(15_000),
  TRACEY_MCP_BEARER_TOKEN: OptionalStringSchema,
  TRACEY_MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
  TRACEY_CODEX_SESSIONS_DIR: OptionalStringSchema,
  TRACEY_LOCAL_FORENSIC_MODE: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse(environment);
}
