import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import dotenv from "dotenv";
import { PostgresStore, type DurableJob } from "@tracey/postgres-store";
import { WebsiteScanner } from "@tracey/website-scanner";
import { z } from "zod";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const config = z.object({
  DATABASE_URL: z.string().min(1),
  TRACEY_API_URL: z.string().url().default("http://api:3000"),
  TRACEY_API_BEARER_TOKEN: z.string().min(1),
  TRACEY_TENANT_ID: z.string().min(1).max(128).default("local"),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
  WORKER_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_JOB_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
}).parse(process.env);

const TriggerPollPayloadSchema = z.object({
  triggerId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string().min(1).max(200),
  kind: z.enum(["error_run", "latency"]),
  threshold: z.number().finite().nonnegative().optional(),
  lookbackMinutes: z.number().int().min(1).max(10_080),
  cooldownMinutes: z.number().int().min(1).max(10_080),
});
const ScheduledActionPayloadSchema = z.object({ proposalId: z.string().uuid() });
const WebsiteScanPayloadSchema = z.object({ scanId: z.string().uuid(), targetId: z.string().uuid() });
const InvestigationRunPayloadSchema = z.object({ runId: z.string().uuid(), sessionId: z.string().uuid() });

class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

const store = new PostgresStore({ connectionString: config.DATABASE_URL });
const websiteScanner = new WebsiteScanner();
const workerId = `worker:${randomUUID()}`;
const apiBase = config.TRACEY_API_URL.replace(/\/$/, "");
let stopped = false;
let wakeTimer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | undefined;
let lastCycle: string | undefined;
let lastError: string | undefined;
let queueStats: Record<DurableJob["status"], number> = { queued: 0, leased: 0, succeeded: 0, dead_letter: 0 };

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(125_000),
    headers: {
      authorization: `Bearer ${config.TRACEY_API_BEARER_TOKEN}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

function permanentHttpFailure(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

async function processTriggerPoll(job: DurableJob): Promise<void> {
  const trigger = TriggerPollPayloadSchema.parse(job.payload);
  const agent = await store.getAgent(config.TRACEY_TENANT_ID, trigger.agentId);
  if (!agent || agent.status !== "active") throw new PermanentJobError("Trigger agent is absent or paused");
  if (["codex_desktop", "codex_cli"].includes(agent.producerType)) return;

  const end = Date.now();
  const start = end - trigger.lookbackMinutes * 60_000;
  const runsResponse = await api(`/v1/agents/${agent.agentId}/runs?start=${start}&end=${end}&limit=20`);
  if (!runsResponse.ok) {
    if (permanentHttpFailure(runsResponse.status)) throw new PermanentJobError(`Agent run query returned HTTP ${runsResponse.status}`);
    throw new Error(`Agent run query returned HTTP ${runsResponse.status}`);
  }
  const body = await runsResponse.json() as { runs?: Array<{ traceId?: unknown }> };
  for (const run of body.runs ?? []) {
    const traceId = z.string().min(1).max(64).parse(run.traceId);
    const fireResponse = await api(`/v1/triggers/${trigger.triggerId}/fire`, {
      method: "POST",
      body: JSON.stringify({ correlationType: "trace", correlationId: traceId, start, end }),
    });
    if (fireResponse.ok || fireResponse.status === 409) continue;
    if (permanentHttpFailure(fireResponse.status)) throw new PermanentJobError(`Trigger fire returned HTTP ${fireResponse.status}`);
    throw new Error(`Trigger fire returned HTTP ${fireResponse.status}`);
  }
}

async function processScheduledAction(job: DurableJob): Promise<void> {
  const { proposalId } = ScheduledActionPayloadSchema.parse(job.payload);
  const response = await api(`/v1/actions/${proposalId}/execute`, { method: "POST", body: "{}" });
  if (response.ok || response.status === 409) return;
  if (permanentHttpFailure(response.status)) throw new PermanentJobError(`Scheduled action returned HTTP ${response.status}`);
  throw new Error(`Scheduled action returned HTTP ${response.status}`);
}

async function processWebsiteScan(job: DurableJob): Promise<void> {
  const { scanId, targetId } = WebsiteScanPayloadSchema.parse(job.payload);
  const [scan, target] = await Promise.all([
    store.startWebsiteScan(config.TRACEY_TENANT_ID, scanId),
    store.getWebsiteTarget(config.TRACEY_TENANT_ID, targetId),
  ]);
  if (!scan || !target) throw new PermanentJobError("Website scan or target does not exist");
  if (target.status !== "verified") throw new PermanentJobError("Website target ownership is not verified");
  const result = await websiteScanner.scan(target.origin);
  const completed = await store.completeWebsiteScan(
    config.TRACEY_TENANT_ID,
    scanId,
    result as unknown as Record<string, unknown>,
  );
  if (!completed) throw new Error("Website scan state changed before completion");
}

async function processInvestigationRun(job: DurableJob): Promise<void> {
  const { runId } = InvestigationRunPayloadSchema.parse(job.payload);
  const current = await store.getInvestigationRun(config.TRACEY_TENANT_ID, runId);
  if (!current) throw new PermanentJobError("Investigation run does not exist");
  if (current.status === "completed" || current.status === "cancelled") return;
  const response = await api(`/v1/internal/investigation-runs/${runId}/execute`, { method: "POST", body: "{}" });
  if (response.ok) return;
  if (permanentHttpFailure(response.status)) throw new PermanentJobError(`Investigation execution returned HTTP ${response.status}`);
  throw new Error(`Investigation execution returned HTTP ${response.status}`);
}

async function processJob(job: DurableJob): Promise<void> {
  let leaseTimer: NodeJS.Timeout | undefined;
  const renewEveryMs = Math.max(10_000, Math.floor(config.WORKER_JOB_LEASE_SECONDS * 500));
  const renew = async () => {
    try {
      const renewed = await store.renewDurableJobLease(
        config.TRACEY_TENANT_ID,
        job.jobId,
        workerId,
        config.WORKER_JOB_LEASE_SECONDS,
      );
      if (!renewed) throw new Error("Job lease ownership was lost");
    } catch (error) {
      console.error("Durable job lease renewal failed", {
        jobId: job.jobId,
        jobType: job.jobType,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };
  leaseTimer = setInterval(() => void renew(), renewEveryMs);
  leaseTimer.unref();
  try {
    if (job.jobType === "trigger_poll") await processTriggerPoll(job);
    else if (job.jobType === "execute_scheduled_action") await processScheduledAction(job);
    else if (job.jobType === "investigation_run") await processInvestigationRun(job);
    else if (job.jobType === "website_security_scan") await processWebsiteScan(job);
    else throw new PermanentJobError(`Worker does not support job type ${job.jobType}`);
    const completed = await store.completeDurableJob(config.TRACEY_TENANT_ID, job.jobId, workerId);
    if (!completed) throw new Error("Job lease ownership was lost before completion");
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    const failedJob = await store.failDurableJob(
      config.TRACEY_TENANT_ID,
      job.jobId,
      workerId,
      errorType,
      error instanceof PermanentJobError || error instanceof z.ZodError,
    );
    if (job.jobType === "website_security_scan") {
      const payload = WebsiteScanPayloadSchema.safeParse(job.payload);
      if (payload.success) {
        await store.recordWebsiteScanFailure(
          config.TRACEY_TENANT_ID,
          payload.data.scanId,
          errorType,
          failedJob?.status === "dead_letter",
        );
      }
    }
    if (job.jobType === "investigation_run") {
      const payload = InvestigationRunPayloadSchema.safeParse(job.payload);
      if (payload.success) {
        await store.recordInvestigationRunFailure(
          config.TRACEY_TENANT_ID,
          payload.data.runId,
          errorType,
          failedJob?.status === "dead_letter",
        );
      }
    }
    console.error("Durable job failed", { jobId: job.jobId, jobType: job.jobType, errorType });
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
  }
}

async function cycle(): Promise<void> {
  try {
    await store.enqueueDueJobs(config.TRACEY_TENANT_ID, 100);
    const jobs = await store.claimDurableJobs(config.TRACEY_TENANT_ID, workerId, {
      limit: config.WORKER_JOB_CONCURRENCY,
      leaseSeconds: config.WORKER_JOB_LEASE_SECONDS,
    });
    await Promise.all(jobs.map(processJob));
    queueStats = await store.durableJobStats(config.TRACEY_TENANT_ID);
    lastCycle = new Date().toISOString();
    lastError = undefined;
  } catch (error) {
    lastError = error instanceof Error ? error.name : "UnknownError";
    console.error("Durable worker cycle failed", { errorType: lastError });
  }
}

function scheduleNextCycle(delay = config.JOB_POLL_INTERVAL_MS): void {
  if (stopped) return;
  wakeTimer = setTimeout(() => {
    activeCycle = cycle().finally(() => scheduleNextCycle());
  }, delay);
  wakeTimer.unref();
}

const health = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/live") {
    response.writeHead(200);
    response.end(JSON.stringify({ status: "alive", component: "tracey-worker", workerId }));
    return;
  }
  if (request.url !== "/ready") {
    response.writeHead(404);
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  const dependencies: Record<string, "ready" | "unavailable"> = { postgres: "ready", api: "ready", scheduler: "ready" };
  try {
    await store.checkHealth();
  } catch {
    dependencies.postgres = "unavailable";
  }
  try {
    const apiHealth = await fetch(`${apiBase}/live`, { signal: AbortSignal.timeout(5_000) });
    if (!apiHealth.ok) dependencies.api = "unavailable";
  } catch {
    dependencies.api = "unavailable";
  }
  const staleAfter = Math.max(config.JOB_POLL_INTERVAL_MS * 5, 30_000);
  if (lastError || !lastCycle || Date.now() - Date.parse(lastCycle) > staleAfter) dependencies.scheduler = "unavailable";
  const ready = Object.values(dependencies).every((value) => value === "ready");
  response.writeHead(ready ? 200 : 503);
  response.end(JSON.stringify({
    status: ready ? "ready" : "not_ready",
    dependencies,
    workerId,
    lastCycle,
    lastError,
    queue: queueStats,
  }));
});

health.listen(config.WORKER_HEALTH_PORT, "0.0.0.0");
activeCycle = cycle().finally(() => scheduleNextCycle());

async function shutdown(): Promise<void> {
  stopped = true;
  if (wakeTimer) clearTimeout(wakeTimer);
  await activeCycle?.catch(() => undefined);
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await store.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
