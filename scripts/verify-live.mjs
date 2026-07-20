import "dotenv/config";

const apiUrl = (process.env.TRACEY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiToken = process.env.TRACEY_API_BEARER_TOKEN;
const serviceName = process.env.TRACEY_VERIFY_SERVICE_NAME;
const end = Number(process.env.TRACEY_VERIFY_END ?? Date.now());
const start = Number(process.env.TRACEY_VERIFY_START ?? end - 60 * 60 * 1_000);

if (!apiToken) throw new Error("TRACEY_API_BEARER_TOKEN is required");
if (!serviceName) {
  throw new Error("TRACEY_VERIFY_SERVICE_NAME is required; Tracey never launches a bundled agent workflow");
}
if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
  throw new Error("TRACEY_VERIFY_START and TRACEY_VERIFY_END must define a valid production telemetry window");
}

const authorization = { authorization: `Bearer ${apiToken}` };
const searchUrl = new URL(`${apiUrl}/v1/signoz/agent-runs`);
searchUrl.searchParams.set("start", String(start));
searchUrl.searchParams.set("end", String(end));
searchUrl.searchParams.set("serviceName", serviceName);
searchUrl.searchParams.set("limit", "20");
const searchResponse = await fetch(searchUrl, {
  headers: authorization,
  signal: AbortSignal.timeout(10_000),
});
if (!searchResponse.ok) {
  throw new Error(`Production run search failed with HTTP ${searchResponse.status}: ${await searchResponse.text()}`);
}
const search = await searchResponse.json();
const run = search.runs?.[0];
if (!run || typeof run.traceId !== "string" || !/^[a-f0-9]{32}$/i.test(run.traceId)) {
  throw new Error(`No native agent.run root was found for ${serviceName} in the selected window`);
}

const traceResponse = await fetch(
  `${apiUrl}/v1/signoz/traces/${run.traceId}?start=${start}&end=${end}`,
  { headers: authorization, signal: AbortSignal.timeout(15_000) },
);
if (!traceResponse.ok) {
  throw new Error(`Production trace investigation failed with HTTP ${traceResponse.status}: ${await traceResponse.text()}`);
}
const investigation = await traceResponse.json();
if (!Array.isArray(investigation.spans) || investigation.spans[0]?.name !== "agent.run") {
  throw new Error("The production trace did not normalize to a root agent.run graph");
}
if (!investigation.analysis || !investigation.diagnosis) {
  throw new Error("The production trace did not produce analysis and evidence-linked diagnosis contracts");
}

const metricsResponse = await fetch(
  `${apiUrl}/v1/signoz/metrics/agent-runs?start=${start}&end=${end}`,
  { headers: authorization, signal: AbortSignal.timeout(10_000) },
);
if (!metricsResponse.ok) {
  throw new Error(`Production metrics query failed with HTTP ${metricsResponse.status}: ${await metricsResponse.text()}`);
}
const metrics = await metricsResponse.json();

process.stdout.write(`${JSON.stringify({
  verification: "passed",
  serviceName,
  traceId: run.traceId,
  runId: run.runId,
  spanCount: investigation.spans.length,
  logCount: investigation.logs.length,
  evidenceComplete: investigation.evidence.complete,
  graphCompleteness: investigation.analysis.completenessScore,
  diagnosisEvidenceCompleteness: investigation.diagnosis.evidenceCompleteness,
  metricSeriesCount: Array.isArray(metrics.series) ? metrics.series.length : 0,
}, null, 2)}\n`);
