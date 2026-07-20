import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesAdapter } from "@tracey/cloud-adapter";
import type { PostgresStore } from "@tracey/postgres-store";
import { buildExecutorServer } from "./server.js";

describe("restricted executor", () => {
  it("requires authentication and replays completed idempotent actions", async () => {
    let executions = 0;
    const store = {
      claimExecutorAction: async () => executions === 0
        ? { claimed: true, status: "executing" as const }
        : { claimed: false, status: "succeeded" as const, result: { accepted: true } },
      completeExecutorAction: async () => undefined,
      checkHealth: async () => undefined,
    } as unknown as PostgresStore;
    const kubernetes = {
      execute: async () => { executions += 1; return { accepted: true }; },
      checkMutationAccess: async () => undefined,
    } as unknown as KubernetesAdapter;
    const server = buildExecutorServer({
      tenantId: "tenant-a", bearerToken: "x".repeat(32), databaseUrl: "postgresql://unused",
      allowedNamespaces: ["production"], allowedWorkloads: ["sample-workload"],
    }, { store, kubernetes });
    const body = { proposalId: crypto.randomUUID(), action: { type: "restart_workload", namespace: "production", workload: "sample-workload" } };
    const unauthorized = await server.inject({ method: "POST", url: "/v1/actions/execute", payload: body, headers: { "idempotency-key": "action-1" } });
    assert.equal(unauthorized.statusCode, 401);
    const first = await server.inject({ method: "POST", url: "/v1/actions/execute", payload: body, headers: { authorization: `Bearer ${"x".repeat(32)}`, "idempotency-key": "action-1" } });
    const replay = await server.inject({ method: "POST", url: "/v1/actions/execute", payload: body, headers: { authorization: `Bearer ${"x".repeat(32)}`, "idempotency-key": "action-1" } });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.equal(executions, 1);
    await server.close();
  });
});
