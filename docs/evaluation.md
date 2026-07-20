# Diagnosis evaluation

Tracey evaluates the production graph and diagnosis code against labeled traces captured from the configured SigNoz deployment. Evaluation data is never used as a runtime API response.

## Seven required scenarios

The capture plan covers the seven PRD controls:

1. CRM timeout followed by a successful retry.
2. Empty retrieval.
3. Incorrect tool selection from an explicit deterministic routing label.
4. Provider failure followed by a fallback model.
5. Retrieved context truncation.
6. Tool schema mismatch.
7. Negative feedback correlated through trace and span IDs.

The diagnosis engine only claims facts represented by telemetry. For example, an empty retrieval result proves that no sources were returned; it does not prove that the final answer hallucinated. That requires a separate groundedness evaluation.

## Capture real traces

Copy `evaluation/capture-plan.v1.json`, replace each placeholder trace ID and time window, and add cases until the PRD minimum of 30 traces is reached. Keep at least one case for every scenario. Then run:

```bash
TRACEY_API_URL=http://localhost:3000 \
TRACEY_API_TOKEN=... \
TRACEY_EVAL_TENANT_ID=... \
TRACEY_EVAL_PLAN=evaluation/capture-plan.v1.json \
TRACEY_EVAL_DATASET=evaluation/captured/production-baseline.v1.json \
pnpm eval:capture
```

The capture command calls the authenticated Tracey trace endpoint, which queries live SigNoz with the server's fixed tenant and environment scope. It refuses malformed IDs, invalid time windows, rejected rows, pagination, empty traces, and an existing output path. The tenant identifier is stored only as a SHA-256 provenance hash. Each captured span/log payload receives an integrity hash.

## Score the dataset

```bash
TRACEY_EVAL_DATASET=evaluation/captured/production-baseline.v1.json pnpm eval:report
```

The report includes:

- root-cause top-1 accuracy;
- top-3 recall;
- required-category recall;
- evidence citation precision based on resolvable trace/span references;
- false causal claim rate against each case's reviewed category allowlist;
- dataset size, integrity, and seven-scenario coverage gates.

The command exits nonzero when there are fewer than 30 captured cases, any scenario is absent, or a payload hash no longer matches. Accuracy thresholds are intentionally not invented: the implementation plan requires publishing the first baseline before agreeing thresholds.

The checked-in capture plan is a labeling template, not an evaluation dataset. A completed dataset remains pending until the seven faults have been observed in reviewed incidents or induced through approved staging controls and captured from the production SigNoz contract.
