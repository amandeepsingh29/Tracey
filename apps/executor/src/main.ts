import { z } from "zod";
import { buildExecutorServer } from "./server.js";

const environment = z.object({
  EXECUTOR_PORT: z.coerce.number().int().min(1).max(65_535).default(3_002),
  TRACEY_TENANT_ID: z.string().min(1).max(128),
  TRACEY_EXECUTOR_BEARER_TOKEN: z.string().min(32),
  DATABASE_URL: z.string().url(),
  TRACEY_KUBERNETES_ALLOWED_NAMESPACES: z.string().min(1),
  TRACEY_KUBERNETES_ALLOWED_WORKLOADS: z.string().min(1),
}).parse(process.env);

const server = buildExecutorServer({
  tenantId: environment.TRACEY_TENANT_ID,
  bearerToken: environment.TRACEY_EXECUTOR_BEARER_TOKEN,
  databaseUrl: environment.DATABASE_URL,
  allowedNamespaces: environment.TRACEY_KUBERNETES_ALLOWED_NAMESPACES.split(",").map((value) => value.trim()).filter(Boolean),
  allowedWorkloads: environment.TRACEY_KUBERNETES_ALLOWED_WORKLOADS.split(",").map((value) => value.trim()).filter(Boolean),
});

await server.listen({ host: "0.0.0.0", port: environment.EXECUTOR_PORT });
