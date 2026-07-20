import "dotenv/config";

const apiUrl = (process.env.TRACEY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiToken = process.env.TRACEY_API_BEARER_TOKEN;
const dimension = process.env.TRACEY_COHORT_DIMENSION;
const baseline = process.env.TRACEY_COHORT_BASELINE;
const candidate = process.env.TRACEY_COHORT_CANDIDATE;
const serviceName = process.env.TRACEY_COHORT_SERVICE_NAME;

for (const [name, value] of Object.entries({
  TRACEY_API_BEARER_TOKEN: apiToken,
  TRACEY_COHORT_DIMENSION: dimension,
  TRACEY_COHORT_BASELINE: baseline,
  TRACEY_COHORT_CANDIDATE: candidate,
  TRACEY_COHORT_SERVICE_NAME: serviceName,
})) {
  if (!value) throw new Error(`${name} is required for a caller-selected live cohort comparison`);
}

const end = process.env.TRACEY_COHORT_END ? Number(process.env.TRACEY_COHORT_END) : Date.now();
const start = process.env.TRACEY_COHORT_START
  ? Number(process.env.TRACEY_COHORT_START)
  : end - 60 * 60 * 1_000;
const response = await fetch(`${apiUrl}/v1/signoz/cohorts/compare`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    start,
    end,
    serviceName,
    dimension,
    baseline,
    candidate,
    maxSpansPerCohort: Number(process.env.TRACEY_COHORT_MAX_SPANS ?? 2_000),
    minSampleSize: Number(process.env.TRACEY_COHORT_MIN_SAMPLE ?? 30),
  }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Live cohort comparison failed with HTTP ${response.status}: ${await response.text()}`);
}

const result = await response.json();
if (!result?.comparison || !["sufficient", "insufficient_evidence"].includes(result.comparison.conclusion)) {
  throw new Error("Tracey returned an invalid cohort comparison contract");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
