import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const apiUrl = (process.env.TRACEY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiToken = process.env.TRACEY_API_TOKEN;
const tenantId = process.env.TRACEY_EVAL_TENANT_ID;
const planPath = resolve(process.env.TRACEY_EVAL_PLAN ?? "evaluation/capture-plan.v1.json");
const outputPath = resolve(process.env.TRACEY_EVAL_DATASET ?? "evaluation/captured/production-baseline.v1.json");

if (!apiToken) throw new Error("TRACEY_API_TOKEN is required");
if (!tenantId) throw new Error("TRACEY_EVAL_TENANT_ID is required to create a non-reversible provenance hash");

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.schemaVersion !== "1.0" || !Array.isArray(plan.cases) || plan.cases.length === 0) {
  throw new Error("Evaluation capture plan must use schemaVersion 1.0 and contain cases");
}

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const capturedCases = [];
for (const planned of plan.cases) {
  if (!/^[a-fA-F0-9]{32}$/.test(planned.traceId ?? "")) {
    throw new Error(`${planned.caseId ?? "unknown case"} requires a real 32-character traceId`);
  }
  if (!Number.isInteger(planned.start) || !Number.isInteger(planned.end) || planned.start >= planned.end) {
    throw new Error(`${planned.caseId} requires an exact start/end window containing the live trace`);
  }
  const url = new URL(`${apiUrl}/v1/signoz/traces/${planned.traceId}`);
  url.searchParams.set("start", String(planned.start));
  url.searchParams.set("end", String(planned.end));
  url.searchParams.set("limit", "10000");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Capture ${planned.caseId} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const investigation = await response.json();
  if (!Array.isArray(investigation.spans) || investigation.spans.length === 0 || !Array.isArray(investigation.logs)) {
    throw new Error(`Capture ${planned.caseId} returned an invalid trace investigation`);
  }
  if (investigation.evidence?.complete !== true || investigation.evidence?.nextCursor || investigation.evidence?.rejectedSpanRows > 0 || investigation.evidence?.rejectedLogRows > 0) {
    throw new Error(`Capture ${planned.caseId} is incomplete; evaluation datasets cannot silently accept truncated or rejected telemetry`);
  }
  const payload = { spans: investigation.spans, logs: investigation.logs };
  capturedCases.push({
    caseId: planned.caseId,
    scenario: planned.scenario,
    traceId: planned.traceId.toLowerCase(),
    capture: {
      kind: "signoz_query_v5",
      capturedAt: new Date().toISOString(),
      deployment: plan.deployment,
      environment: plan.environment,
      tenantIdHash: sha256(tenantId),
      queryStart: planned.start,
      queryEnd: planned.end,
      payloadSha256: sha256(JSON.stringify(payload)),
    },
    ...payload,
    expected: {
      primaryCategory: planned.primaryCategory,
      requiredCategories: planned.requiredCategories ?? [planned.primaryCategory],
      allowedCategories: planned.allowedCategories,
    },
  });
}

const dataset = {
  schemaVersion: "1.0",
  datasetId: plan.datasetId,
  createdAt: new Date().toISOString(),
  cases: capturedCases,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ outputPath, cases: capturedCases.length }, null, 2)}\n`);
