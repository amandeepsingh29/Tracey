import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "../packages/postgres-store/src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const tenantId = `jobs-${randomUUID()}`;
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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
try {
  const agent = await store.registerAgent(tenantId, {
    displayName: "Durable queue verifier",
    serviceName: `durable-queue-${randomUUID()}`,
    producerType: "custom_otel",
    environment: "verification",
    normalizationProfile: "generic-otel-v1",
    telemetryContractVersion: "1.0",
  });
  await store.createTriggerRule(tenantId, {
    agentId: agent.agentId,
    name: "Failure polling",
    kind: "error_run",
    lookbackMinutes: 5,
    cooldownMinutes: 5,
  });

  const enqueued = await store.enqueueDueJobs(tenantId);
  assert.equal(enqueued.triggerPolls, 1);
  const [leased] = await store.claimDurableJobs(tenantId, "worker-a", { limit: 1, leaseSeconds: 30 });
  assert.ok(leased);
  assert.equal(leased.status, "leased");
  assert.equal(leased.attempts, 1);
  assert.equal((await store.claimDurableJobs(tenantId, "worker-b", { limit: 1, leaseSeconds: 30 })).length, 0);

  const retry = await store.failDurableJob(tenantId, leased.jobId, "worker-a", "TransientNetworkError");
  assert.equal(retry?.status, "queued");
  assert.ok(Date.parse(retry!.availableAt) > Date.now());

  const completion = await store.enqueueJob(tenantId, {
    jobType: "investigation_run",
    dedupeKey: `completion:${randomUUID()}`,
    payload: { sessionId: randomUUID() },
  });
  assert.ok(completion);
  const completionLease = (await store.claimDurableJobs(tenantId, "worker-a", { limit: 1, leaseSeconds: 30 }))[0];
  assert.equal(completionLease?.jobId, completion.jobId);
  assert.equal(await store.completeDurableJob(tenantId, completion.jobId, "worker-a"), true);

  const deadLetter = await store.enqueueJob(tenantId, {
    jobType: "investigation_run",
    dedupeKey: `dead:${randomUUID()}`,
    payload: { sessionId: randomUUID() },
    maxAttempts: 1,
  });
  const deadLease = (await store.claimDurableJobs(tenantId, "worker-a", { limit: 1, leaseSeconds: 30 }))[0];
  assert.equal(deadLease?.jobId, deadLetter?.jobId);
  const dead = await store.failDurableJob(tenantId, deadLease!.jobId, "worker-a", "PermanentInputError");
  assert.equal(dead?.status, "dead_letter");

  const recovery = await store.enqueueJob(tenantId, {
    jobType: "investigation_run",
    dedupeKey: `recovery:${randomUUID()}`,
    payload: { sessionId: randomUUID() },
    maxAttempts: 2,
  });
  const abandoned = (await store.claimDurableJobs(tenantId, "worker-a", { limit: 1, leaseSeconds: 30 }))[0];
  assert.equal(abandoned?.jobId, recovery?.jobId);
  await tenantSql(
    "UPDATE tracey.durable_jobs SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2",
    [tenantId, recovery!.jobId],
  );
  const recovered = (await store.claimDurableJobs(tenantId, "worker-b", { limit: 1, leaseSeconds: 30 }))[0];
  assert.equal(recovered?.jobId, recovery?.jobId);
  assert.equal(recovered?.attempts, 2);
  assert.equal(recovered?.leaseOwner, "worker-b");

  const stats = await store.durableJobStats(tenantId);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.dead_letter, 1);
  assert.ok(stats.leased >= 1);
  console.log(JSON.stringify({ status: "passed", tenantId, enqueued, stats }, null, 2));
} finally {
  await tenantSql("DELETE FROM tracey.agent_integrations WHERE tenant_id=$1", [tenantId]).catch(() => undefined);
  await tenantSql("DELETE FROM tracey.durable_jobs WHERE tenant_id=$1", [tenantId]).catch(() => undefined);
  await Promise.all([store.close(), pool.end()]);
}
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Durable job verification failed");
  process.exitCode = 1;
});
