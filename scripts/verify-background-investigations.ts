import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "../packages/postgres-store/src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
const tenantId = `investigations-${randomUUID()}`;
const store = new PostgresStore({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl });

async function tenantSql(sql: string, values: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('tracey.tenant_id',$1,true)", [tenantId]);
    await client.query(sql, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const sessionIds: string[] = [];
  try {
    const session = await store.createInvestigationSession(tenantId, "Background verifier");
    sessionIds.push(session.sessionId);
    const queued = await store.enqueueInvestigationRun(tenantId, {
      sessionId: session.sessionId,
      content: "Inspect the production agent failure.",
      actorSubject: "verification-analyst",
      actorRoles: ["analyst"],
    });
    assert.equal(queued.run.status, "queued");
    assert.equal(queued.message.role, "user");
    await assert.rejects(
      store.enqueueInvestigationRun(tenantId, {
        sessionId: session.sessionId,
        content: "Concurrent turn",
        actorSubject: "verification-analyst",
        actorRoles: ["analyst"],
      }),
      /already running/,
    );

    const [job] = await store.claimDurableJobs(tenantId, "investigation-worker-a", { limit: 1, leaseSeconds: 30 });
    assert.equal(job?.jobType, "investigation_run");
    assert.equal((await store.claimDurableJobs(tenantId, "investigation-worker-b", { limit: 1, leaseSeconds: 30 })).length, 0);
    const running = await store.startInvestigationRun(tenantId, queued.run.runId);
    assert.equal(running?.status, "running");
    await store.recordInvestigationRunStep(tenantId, queued.run.runId, { kind: "model", name: "Model reasoning", status: "completed", stage: "reasoning", progress: 30 });
    await store.recordInvestigationRunStep(tenantId, queued.run.runId, { kind: "tool", name: "inspect_trace", status: "completed", stage: "tool:inspect_trace", progress: 70, detail: { evidenceRefs: 2 } });
    const answer = await store.appendInvestigationMessage(tenantId, { sessionId: session.sessionId, role: "assistant", content: "The bounded verification completed.", evidenceRefs: [], model: "verification-model", grounding: "tool_grounded", toolCallCount: 1 });
    const completed = await store.completeInvestigationRun(tenantId, queued.run.runId, answer.messageId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.progress, 100);
    assert.equal(await store.completeDurableJob(tenantId, job!.jobId, "investigation-worker-a"), true);
    const steps = await store.listInvestigationRunSteps(tenantId, queued.run.runId);
    assert.deepEqual(steps.map(({ kind }) => kind), ["queued", "model", "tool", "complete"]);

    const cancellation = await store.enqueueInvestigationRun(tenantId, { sessionId: session.sessionId, content: "Cancel this run.", actorSubject: "verification-analyst", actorRoles: ["analyst"] });
    const cancellationJob = (await store.claimDurableJobs(tenantId, "investigation-worker-a", { limit: 1, leaseSeconds: 30 }))[0];
    await store.startInvestigationRun(tenantId, cancellation.run.runId);
    const cancelled = await store.cancelInvestigationRun(tenantId, cancellation.run.runId);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(await store.completeDurableJob(tenantId, cancellationJob!.jobId, "investigation-worker-a"), true);

    const retry = await store.enqueueInvestigationRun(tenantId, { sessionId: session.sessionId, content: "Retry this run.", actorSubject: "verification-analyst", actorRoles: ["analyst"] });
    const retryJob = (await store.claimDurableJobs(tenantId, "investigation-worker-a", { limit: 1, leaseSeconds: 30 }))[0];
    await store.startInvestigationRun(tenantId, retry.run.runId);
    await store.recordInvestigationRunFailure(tenantId, retry.run.runId, "TemporaryProviderError", false);
    const retriedJob = await store.failDurableJob(tenantId, retryJob!.jobId, "investigation-worker-a", "TemporaryProviderError");
    assert.equal(retriedJob?.status, "queued");
    assert.equal((await store.getInvestigationRun(tenantId, retry.run.runId))?.stage, "retrying");

    const migrationCount = await pool.query("SELECT count(*)::int AS count FROM tracey.schema_migrations");
    console.log(JSON.stringify({ status: "passed", migrationCount: migrationCount.rows[0].count, exclusiveLease: true, concurrentTurnRejected: true, persistedSteps: steps.length, cancellation: "cancelled", retry: "queued" }, null, 2));
  } finally {
    for (const sessionId of sessionIds) await tenantSql("DELETE FROM tracey.investigation_sessions WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]).catch(() => undefined);
    await tenantSql("DELETE FROM tracey.durable_jobs WHERE tenant_id=$1", [tenantId]).catch(() => undefined);
    await Promise.all([store.close(), pool.end()]);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Background investigation verification failed");
  process.exitCode = 1;
});
