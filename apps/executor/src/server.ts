import { timingSafeEqual } from "node:crypto";
import { CloudActionSchema } from "@tracey/autonomy";
import { KubernetesAdapter } from "@tracey/cloud-adapter";
import { PostgresStore } from "@tracey/postgres-store";
import Fastify from "fastify";
import { z } from "zod";

export interface ExecutorConfig {
  tenantId: string;
  bearerToken: string;
  databaseUrl: string;
  allowedNamespaces: string[];
  allowedWorkloads: string[];
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function buildExecutorServer(config: ExecutorConfig, dependencies?: {
  store?: PostgresStore;
  kubernetes?: KubernetesAdapter;
}) {
  const server = Fastify({ logger: { redact: ["req.headers.authorization", "req.body"] }, bodyLimit: 256 * 1_024 });
  const store = dependencies?.store ?? new PostgresStore({ connectionString: config.databaseUrl });
  const kubernetes = dependencies?.kubernetes ?? new KubernetesAdapter({
    allowedNamespaces: config.allowedNamespaces,
    allowedWorkloads: config.allowedWorkloads,
  });

  server.addHook("onClose", async () => {
    if (!dependencies?.store) await store.close();
  });
  server.get("/health", async (_request, reply) => {
    try {
      await store.checkHealth();
      const namespace = config.allowedNamespaces[0];
      if (!namespace) return reply.code(503).send({ status: "not_ready", reason: "executor namespace scope is empty" });
      await kubernetes.checkMutationAccess(namespace);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  server.post("/v1/actions/execute", async (request, reply) => {
    if (!tokenMatches(request.headers.authorization, config.bearerToken)) return reply.code(401).send({ error: "Valid executor authentication is required" });
    const parsed = z.object({ proposalId: z.string().uuid(), action: CloudActionSchema }).safeParse(request.body);
    const idempotencyKey = z.string().min(1).max(255).safeParse(request.headers["idempotency-key"]);
    if (!parsed.success || !idempotencyKey.success) return reply.code(400).send({ error: "A valid typed action and idempotency key are required" });
    const claim = await store.claimExecutorAction(config.tenantId, {
      idempotencyKey: idempotencyKey.data,
      proposalId: parsed.data.proposalId,
      action: parsed.data.action,
    });
    if (!claim.claimed) {
      if (claim.status === "executing") return reply.code(409).send({ error: "Action is already executing" });
      return { status: claim.status, result: claim.result, replayed: true };
    }
    try {
      const result = await kubernetes.execute(parsed.data.action);
      await store.completeExecutorAction(config.tenantId, idempotencyKey.data, { status: "succeeded", result });
      return { status: "succeeded", result, replayed: false };
    } catch (error) {
      await store.completeExecutorAction(config.tenantId, idempotencyKey.data, {
        status: "failed",
        result: { errorType: error instanceof Error ? error.name : "UnknownError" },
      });
      request.log.error({
        errorType: error instanceof Error ? error.name : "UnknownError",
        statusCode: typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode) || undefined
          : undefined,
      }, "Restricted action failed");
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Action failed" });
    }
  });
  return server;
}
