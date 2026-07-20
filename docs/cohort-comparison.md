# Cohort comparison

Tracey compares prompt versions, requested models, or tool versions using real spans queried from the configured SigNoz deployment. It does not create synthetic samples, estimate missing values, or claim causality from correlation.

## Required telemetry

The selected dimension must be present on the relevant spans:

- `prompt_version` -> `tracey.prompt.version`
- `model` -> `gen_ai.request.model`
- `tool_version` -> `tracey.tool.version`

Prompt name/version must come from the observed production agent. Tracey does not treat unversioned user input as a managed prompt release and does not inject prompt metadata into an external agent's telemetry.

## Query and calculations

Baseline and candidate are queried independently and concurrently so one cohort cannot crowd the other out of a result page. Each query is constrained by service, fixed tenant, fixed environment, seven-day maximum range, cursor pagination, per-request timeout, 25-second total comparison timeout, and a maximum of 10,000 raw spans per cohort.

For each cohort, Tracey calculates:

- sample size and configured sufficiency threshold;
- error count/rate and Wilson 95% interval;
- mean, p50, and p95 span duration;
- total and mean input/output tokens;
- total and mean exactly attributed USD cost, plus unresolved-cost sample count;
- up to 20 trace IDs as evidence references.

The response includes candidate-minus-baseline absolute and relative deltas. Relative delta is `null` when the baseline is zero. Cost delta is `null` unless both cohorts contain exact attribution from the versioned pricing catalog; unresolved spans remain visible and are never assigned a guessed price.

`conclusion` is `insufficient_evidence` if either sample is too small, pagination reaches the configured cap, or any returned row fails normalization. Even a `sufficient` result describes observed association, not proof that the selected version caused the difference.

## HTTP API

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "start": 1784160000000,
    "end": 1784163600000,
    "serviceName": "your-agent-service",
    "dimension": "prompt_version",
    "baseline": "support@41",
    "candidate": "support@42",
    "maxSpansPerCohort": 2000,
    "minSampleSize": 30
  }' \
  http://localhost:3000/v1/signoz/cohorts/compare
```

The values above illustrate the request shape; use actual timestamps, service, and deployed version identifiers from your environment.

## MCP

The same operation is available as the read-only `tracey_compare_agent_cohorts` MCP tool. Its input and result limits match the HTTP service.

## Live verification

The verifier requires the operator to choose real cohorts:

```bash
TRACEY_COHORT_DIMENSION=prompt_version \
TRACEY_COHORT_BASELINE='your-real-baseline' \
TRACEY_COHORT_CANDIDATE='your-real-candidate' \
TRACEY_COHORT_SERVICE_NAME='your-real-service' \
pnpm verify:cohort
```

TODO: Run this verifier after the production SigNoz instance contains two genuine version cohorts. No repository fixture is used as a runtime response.
