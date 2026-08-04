import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "../packages/postgres-store/src/index.ts";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const tenantA = `website-a-${randomUUID()}`;
const tenantB = `website-b-${randomUUID()}`;
const origin = `https://${randomUUID()}.example.test`;
const store = new PostgresStore({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl });

async function tenantQuery<T>(tenantId: string, sql: string, values: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('tracey.tenant_id',$1,true)", [tenantId]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(): Promise<void> {
  await tenantQuery(tenantA, "DELETE FROM tracey.website_scans WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
  await tenantQuery(tenantA, "DELETE FROM tracey.durable_jobs WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
  await tenantQuery(tenantA, "DELETE FROM tracey.website_targets WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
}

async function main(): Promise<void> {
  try {
    const created = await store.createWebsiteTarget(tenantA, origin, "verification-admin");
    assert.ok(created.verificationToken?.startsWith("tracey-verify-"));
    assert.equal(created.target.status, "pending_verification");
    assert.equal((await store.listWebsiteTargets(tenantB)).length, 0);

    await assert.rejects(
      store.verifyWebsiteTargetToken(tenantA, created.target.targetId, `${created.verificationToken}wrong`, "verification-admin"),
      /does not match/,
    );
    const verified = await store.verifyWebsiteTargetToken(
      tenantA,
      created.target.targetId,
      created.verificationToken!,
      "verification-admin",
    );
    assert.equal(verified?.status, "verified");

    const scan = await store.createWebsiteScan(tenantA, created.target.targetId, "verification-operator");
    assert.ok(scan);
    const [job] = await store.claimDurableJobs(tenantA, "website-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(job?.jobType, "website_security_scan");
    assert.deepEqual(job?.payload, { scanId: scan.scanId, targetId: created.target.targetId });
    assert.equal((await store.claimDurableJobs(tenantA, "competing-worker", { limit: 1, leaseSeconds: 30 })).length, 0);

    const running = await store.startWebsiteScan(tenantA, scan.scanId);
    assert.equal(running?.status, "running");
    const result = {
      origin,
      scannedAt: new Date().toISOString(),
      statusCode: 200,
      finalUrl: `${origin}/`,
      responseBytes: 42,
      bodySha256: "a".repeat(64),
      findings: [{
        findingId: "finding-verified",
        title: "Verification finding",
        severity: "low",
        category: "headers",
        evidence: "A bounded response header was absent.",
        remediation: "Add the response header.",
        standard: "OWASP WSTG-CONF-14",
      }],
      summary: { info: 0, low: 1, medium: 0, high: 0 },
      scope: { requestsMade: 1, methods: ["GET"], activePayloads: false, sameOriginOnly: true },
    };
    const completedScan = await store.completeWebsiteScan(tenantA, scan.scanId, result);
    assert.equal(completedScan?.status, "completed");
    assert.deepEqual(completedScan?.result, result);
    assert.equal(await store.completeDurableJob(tenantA, job!.jobId, "website-worker"), true);
    assert.equal((await store.listWebsiteScans(tenantB)).length, 0);

    const unscoped = await pool.query("SELECT count(*)::int AS count FROM tracey.website_targets");
    assert.equal(unscoped.rows[0].count, 0);
    let crossTenantWriteDenied = false;
    try {
      await tenantQuery(
        tenantB,
        `INSERT INTO tracey.website_targets
          (tenant_id,target_id,origin,status,verification_token_hash,created_by)
         VALUES ($1,$2,$3,'pending_verification',$4,'cross-tenant-test')`,
        [tenantA, randomUUID(), `https://${randomUUID()}.example.test`, "b".repeat(64)],
      );
    } catch (error) {
      crossTenantWriteDenied = (error as { code?: string }).code === "42501";
    }
    assert.equal(crossTenantWriteDenied, true);

    console.log(JSON.stringify({
      status: "passed",
      migrationCount: 17,
      ownership: "verified",
      durableJob: "succeeded",
      storedFindings: completedScan.result?.findings instanceof Array ? completedScan.result.findings.length : 0,
      tenantIsolation: { tenantBVisibleTargets: 0, tenantBVisibleScans: 0, unscopedRowsVisible: 0, crossTenantWriteDenied },
    }, null, 2));
  } finally {
    await cleanup();
    await Promise.all([store.close(), pool.end()]);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Website security verification failed");
  process.exitCode = 1;
});
