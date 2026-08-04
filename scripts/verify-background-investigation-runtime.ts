import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { Pool } from "pg";
import { PostgresStore } from "../packages/postgres-store/src/index.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import { buildServer } from "../apps/api/src/server.ts";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
const tenantId = `investigation-runtime-${randomUUID()}`;
const bearerToken = `runtime-${randomUUID()}`;
const headers = { authorization: `Bearer ${bearerToken}` };
const store = new PostgresStore({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl });

async function expireLease(jobId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('tracey.tenant_id',$1,true)", [tenantId]);
    await client.query("UPDATE tracey.durable_jobs SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND job_id=$2", [tenantId, jobId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const modelServer = createHttpServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.once("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const websiteSelection = body.includes("Select and order only the stored finding IDs");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "tracey-runtime-verifier",
      choices: [{ message: { role: "assistant", content: websiteSelection
        ? JSON.stringify({ rankedFindingIds: ["stored-csp", "invented-sql-injection"] })
        : "The background investigation completed without making unsupported technical claims." } }],
    }));
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const address = modelServer.address();
  if (!address || typeof address === "string") throw new Error("Local model verifier did not bind a TCP port");
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    DEPLOYMENT_ENVIRONMENT: "verification",
    LOG_LEVEL: "fatal",
    OPENROUTER_API_KEY: "local-verifier-only",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}`,
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    SIGNOZ_API_URL: "http://127.0.0.1:3301",
    SIGNOZ_API_KEY: "local-verifier-only",
    TRACEY_AGENT_MODEL: "tracey-runtime-verifier",
    TRACEY_AGENT_TIMEOUT_MS: "5000",
    TRACEY_AGENT_TOOL_TIMEOUT_MS: "2000",
    TRACEY_API_BEARER_TOKEN: bearerToken,
    TRACEY_TENANT_ID: tenantId,
  });
  let server = buildServer(config);
  try {
    const sessionResponse = await server.inject({
      method: "POST",
      url: "/v1/investigations",
      headers,
      payload: { title: "Runtime persistence proof" },
    });
    assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
    const session = sessionResponse.json<{ sessionId: string }>();

    const queuedResponse = await server.inject({
      method: "POST",
      url: `/v1/investigations/${session.sessionId}/messages`,
      headers,
      payload: { content: "Explain only what can be supported by available evidence." },
    });
    assert.equal(queuedResponse.statusCode, 202, queuedResponse.body);
    const queued = queuedResponse.json<{ run: { runId: string; status: string } }>();
    assert.equal(queued.run.status, "queued");

    const [abandonedJob] = await store.claimDurableJobs(tenantId, "crashed-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(abandonedJob?.jobType, "investigation_run");
    await server.close();
    await expireLease(abandonedJob!.jobId);
    server = buildServer(config);

    const streamResponse = server.inject({
      method: "GET",
      url: `/v1/investigation-runs/${queued.run.runId}/events`,
      headers: { ...headers, accept: "text/event-stream" },
    });
    const [job] = await store.claimDurableJobs(tenantId, "runtime-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(job?.jobType, "investigation_run");
    assert.equal(job?.attempts, 2);
    const executionResponse = await server.inject({
      method: "POST",
      url: `/v1/internal/investigation-runs/${queued.run.runId}/execute`,
      headers,
      payload: {},
    });
    assert.equal(executionResponse.statusCode, 200, executionResponse.body);
    assert.equal(await store.completeDurableJob(tenantId, job!.jobId, "runtime-worker"), true);

    const streamed = await Promise.race([
      streamResponse,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Progress stream did not terminate")), 5_000)),
    ]);
    assert.equal(streamed.statusCode, 200, streamed.body);
    assert.match(streamed.headers["content-type"] ?? "", /text\/event-stream/);
    assert.match(streamed.body, /"status":"completed"/);
    assert.match(streamed.body, /"kind":"synthesis"/);

    const restored = await server.inject({ method: "GET", url: `/v1/investigation-runs/${queued.run.runId}`, headers });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json<{ run: { status: string } }>().run.status, "completed");
    const messages = await server.inject({ method: "GET", url: `/v1/investigations/${session.sessionId}/messages`, headers });
    assert.equal(messages.statusCode, 200, messages.body);
    assert.deepEqual(messages.json<{ messages: Array<{ role: string }> }>().messages.map(({ role }) => role), ["user", "assistant"]);

    const target = await store.createWebsiteTarget(tenantId, "https://security.example.test/", "runtime-analyst");
    const verified = await store.verifyWebsiteTargetToken(tenantId, target.target.targetId, target.verificationToken!, "runtime-analyst");
    assert.equal(verified?.status, "verified");
    const scan = await store.createWebsiteScan(tenantId, target.target.targetId, "runtime-analyst");
    const [scanJob] = await store.claimDurableJobs(tenantId, "runtime-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(scanJob?.jobType, "website_security_scan");
    await store.startWebsiteScan(tenantId, scan!.scanId);
    await store.completeWebsiteScan(tenantId, scan!.scanId, {
      origin: target.target.origin, scannedAt: new Date().toISOString(), statusCode: 200, finalUrl: target.target.origin,
      responseBytes: 100, bodySha256: "a".repeat(64), summary: { high: 0, medium: 1, low: 0, info: 0 },
      scope: { requestsMade: 1, methods: ["GET"], activePayloads: false, sameOriginOnly: true },
      findings: [{ findingId: "stored-csp", title: "Content Security Policy is missing", severity: "medium", category: "headers", evidence: "The response has no Content-Security-Policy header.", remediation: "Deploy a restrictive CSP header.", standard: "OWASP WSTG-CONF-12" }],
    });
    await store.completeDurableJob(tenantId, scanJob!.jobId, "runtime-worker");
    const websiteResponse = await server.inject({ method: "POST", url: `/v1/security/website-scans/${scan!.scanId}/investigation`, headers, payload: {} });
    assert.equal(websiteResponse.statusCode, 202, websiteResponse.body);
    const websiteSession = websiteResponse.json<{ investigation: { session: { sessionId: string } } }>().investigation.session;
    const [websiteJob] = await store.claimDurableJobs(tenantId, "runtime-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(websiteJob?.jobType, "investigation_run");
    const websiteExecution = await server.inject({ method: "POST", url: `/v1/internal/investigation-runs/${String(websiteJob!.payload.runId)}/execute`, headers, payload: {} });
    assert.equal(websiteExecution.statusCode, 200, websiteExecution.body);
    await store.completeDurableJob(tenantId, websiteJob!.jobId, "runtime-worker");
    const websiteMessages = await server.inject({ method: "GET", url: `/v1/investigations/${websiteSession.sessionId}/messages`, headers });
    assert.equal(websiteMessages.statusCode, 200, websiteMessages.body);
    const websiteAnswer = websiteMessages.json<{ messages: Array<{ role: string; content: string; evidenceRefs: Array<{ sourceId?: string }> }> }>().messages.at(-1)!;
    assert.match(websiteAnswer.content, /Deterministic scanner evidence/);
    assert.match(websiteAnswer.content, /Content Security Policy is missing/);
    assert.doesNotMatch(websiteAnswer.content, /invented-sql-injection|SQL injection/i);
    assert.ok(websiteAnswer.evidenceRefs.some(({ sourceId }) => sourceId?.endsWith(":stored-csp")));
    const followUp = await server.inject({ method: "POST", url: `/v1/investigations/${websiteSession.sessionId}/messages`, headers, payload: { content: "Which stored finding should be fixed first?" } });
    assert.equal(followUp.statusCode, 202, followUp.body);
    const [followUpJob] = await store.claimDurableJobs(tenantId, "runtime-worker", { limit: 1, leaseSeconds: 30 });
    assert.equal(followUpJob?.jobType, "investigation_run");
    const followUpExecution = await server.inject({ method: "POST", url: `/v1/internal/investigation-runs/${String(followUpJob!.payload.runId)}/execute`, headers, payload: {} });
    assert.equal(followUpExecution.statusCode, 200, followUpExecution.body);
    await store.completeDurableJob(tenantId, followUpJob!.jobId, "runtime-worker");
    const followedMessages = await server.inject({ method: "GET", url: `/v1/investigations/${websiteSession.sessionId}/messages`, headers });
    assert.equal(followedMessages.statusCode, 200, followedMessages.body);
    const followUpAnswer = followedMessages.json<{ messages: Array<{ role: string; content: string }> }>().messages.at(-1)!;
    assert.match(followUpAnswer.content, /Content Security Policy is missing/);
    assert.doesNotMatch(followUpAnswer.content, /invented-sql-injection|SQL injection/i);

    console.log(JSON.stringify({ status: "passed", queue: "durable", apiRestart: "recovered", workerLease: "recovered", execution: "worker-endpoint", stream: "terminal", restored: true, websiteGrounding: "validated-finding-ids" }, null, 2));
  } finally {
    await store.clearInvestigationHistory(tenantId).catch(() => undefined);
    await server.close();
    await store.close();
    await pool.end();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : "Background investigation runtime verification failed");
  process.exitCode = 1;
});
