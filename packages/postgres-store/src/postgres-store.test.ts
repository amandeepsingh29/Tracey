import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PostgresStore,
  PostgresStoreError,
  actionApprovalFingerprint,
  authorizeExecutorAction,
  durableJobBackoffSeconds,
  type ActionProposal,
} from "./postgres-store.js";

describe("PostgreSQL control-plane store", () => {
  it("preserves intentional store errors while sanitizing database failures", async () => {
    const store = Object.create(PostgresStore.prototype) as unknown as {
      pool: { connect: () => Promise<{ query: (sql: string) => Promise<unknown>; release: () => void }> };
      withTenant: <T>(tenantId: string, operation: () => Promise<T>) => Promise<T>;
    };
    store.pool = {
      connect: async () => ({ query: async () => undefined, release: () => undefined }),
    };
    await assert.rejects(
      store.withTenant("tenant", async () => { throw new PostgresStoreError("Expected domain error"); }),
      /Expected domain error/,
    );
    await assert.rejects(
      store.withTenant("tenant", async () => { throw new Error("driver details"); }),
      /PostgreSQL operation failed/,
    );
  });
  it("rejects non-PostgreSQL connection schemes", () => {
    assert.throws(
      () => new PostgresStore({ connectionString: "https://database.invalid" }),
      PostgresStoreError,
    );
  });

  it("rejects incompatible embeddings before opening a database connection", async () => {
    const store = new PostgresStore({ connectionString: "postgresql://tracey:secret@127.0.0.1:1/tracey" });
    await assert.rejects(
      store.indexDiagnosis("tenant-a", {
        agentId: "019f697a-67d9-7a20-8956-98b8bb9fe7ed",
        traceId: "a".repeat(32),
        runId: "run-1",
        summary: "Evidence-bound summary",
        diagnosis: {},
        evidenceRefs: [],
        embedding: [1],
      }),
      /exactly 1536/,
    );
    await store.close();
  });

  it("authorizes only the exact persisted primary action", () => {
    const proposal = executorProposal("executing");
    proposal.approvalFingerprint = actionApprovalFingerprint(proposal);
    const authorized = authorizeExecutorAction(proposal, {
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      action: { workload: "sample-workload", namespace: "production", type: "restart_workload" },
    });
    assert.equal(authorized.phase, "execute");
    assert.match(authorized.actionHash, /^[a-f0-9]{64}$/);

    assert.throws(() => authorizeExecutorAction(proposal, {
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      action: { type: "restart_workload", namespace: "production", workload: "different-workload" },
    }), /exactly match/);
    assert.throws(() => authorizeExecutorAction({ ...proposal, target: "production/changed" }, {
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      action: proposal.remediationPlan!.action,
    }), /approval.*stale/i);
  });

  it("authorizes rollback only from the persisted reverting state", () => {
    const proposal = executorProposal("reverting");
    proposal.approvalFingerprint = actionApprovalFingerprint(proposal);
    const authorization = authorizeExecutorAction(proposal, {
      proposalId: proposal.proposalId,
      idempotencyKey: `${proposal.idempotencyKey}:rollback`,
      action: proposal.remediationPlan!.rollback!.action,
    });
    assert.equal(authorization.phase, "rollback");
    assert.throws(() => authorizeExecutorAction(proposal, {
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      action: proposal.remediationPlan!.action,
    }), /idempotency key/);
  });

  it("uses bounded exponential retry delays for durable jobs", () => {
    assert.equal(durableJobBackoffSeconds(1), 15);
    assert.equal(durableJobBackoffSeconds(2), 30);
    assert.equal(durableJobBackoffSeconds(5), 240);
    assert.equal(durableJobBackoffSeconds(20), 900);
  });
});

function executorProposal(status: "executing" | "reverting"): ActionProposal {
  return {
    proposalId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    actionType: "restart",
    target: "production/sample-workload",
    reason: "Observed readiness failure",
    parameters: { namespace: "production", workload: "sample-workload" },
    risk: "low",
    status,
    proposedBy: "operator-a",
    approvedBy: "admin-a",
    idempotencyKey: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    remediationPlan: {
      action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
      summary: "Restart sample workload",
      reason: "Observed readiness failure",
      confidence: 0.99,
      risk: "low",
      reversible: true,
      expectedImpact: "Restore readiness",
      blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 },
      evidenceRefs: [],
      verification: {
        serviceName: "sample-api",
        timeoutSeconds: 60,
        lookbackSeconds: 300,
        minimumSampleCount: 5,
        settleSeconds: 5,
        requireWorkloadReady: true,
        maxErrorRateIncrease: 0,
        maxLatencyIncreasePercent: 10,
      },
      rollback: {
        action: { type: "rollback_deployment", namespace: "production", workload: "sample-workload" },
        automatic: true,
      },
    },
  };
}
