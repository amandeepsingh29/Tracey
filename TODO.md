# Tracey Product TODO

Last updated: 2026-08-04

This is the single source of truth for unfinished Tracey product work. It lists
only remaining tasks. Completed and verified capabilities belong in the README
and Git history.

## Product goal

Tracey is a standalone reliability and operations product for production AI
agents. A team should be able to connect its telemetry and infrastructure,
understand an execution, investigate a failure, approve a corrective action,
verify the result, and recover when verification fails.

## P0 — Verify current implementation

- [x] Start a healthy PostgreSQL instance.
- [x] Apply migrations 15–17 to a clean database.
- [x] Verify website ownership records under tenant isolation.
- [x] Verify durable website scan leasing, retries, completion, and dead-letter
      handling against PostgreSQL.
- [x] Test the complete `/security` workflow through the browser.
- [x] Commit and push the current verified changes.

## P0 — Resumable background investigations

- [x] Create a durable `investigation_run` job.
- [x] Move investigation orchestration off the user request path into durable
      worker jobs.
- [x] Persist investigation steps and tool-call progress.
- [x] Add bounded retries, timeouts, and latency budgets for every tool.
- [x] Continue remaining investigation steps when one source fails.
- [x] Add investigation cancellation.
- [x] Recover expired investigation leases after worker failure.
- [x] Stream partial progress and completed steps to the chat UI.
- [x] Restore an active investigation after browser refresh.
- [x] Prevent responses that promise to continue without queued work.
- [x] Test API and worker restarts during an investigation.

Acceptance criteria:

- A user can leave and reopen an investigation without losing progress.
- A failed source is visible and does not silently stop unrelated work.
- Every technical claim links to returned evidence.
- Only a terminal job state ends the investigation.

## P0 — Agentic website security

- [x] Pass completed deterministic scanner findings into a Tracey
      investigation.
- [x] Generate an evidence-grounded security summary.
- [x] Rank findings using observed severity and application context.
- [x] Visually separate deterministic evidence from model interpretation.
- [x] Link every model claim to a stored scanner finding.
- [x] Reject unsupported or invented vulnerability claims.
- [x] Support follow-up questions about a completed scan.
- [x] Add an investigation link to each completed scan.
- [x] Define written authorization, scope, rate limits, and audit requirements
      before adding browser-driven checks.

Acceptance criteria:

- The model cannot create a finding without stored supporting evidence.
- Users can inspect the observation, interpretation, standard, and remediation.
- A scan never claims that a website is safe or vulnerability-free.

## P0 — Production workflow proof

- [ ] Deploy a controlled staging agent.
- [ ] Generate a genuine agent failure.
- [ ] Capture its OpenTelemetry data in SigNoz.
- [ ] Display the execution in Runs.
- [ ] Start an investigation from that execution.
- [ ] Produce an evidence-linked remediation proposal.
- [ ] Approve it through the web approval panel.
- [ ] Verify the executor performs exactly the persisted action.
- [ ] Verify Kubernetes readiness after execution.
- [ ] Compare before-and-after SigNoz evidence.
- [ ] Inject a failed verification result.
- [ ] Trigger rollback.
- [ ] Verify recovery through Kubernetes and SigNoz.
- [ ] Store the complete audit trail.

Acceptance criteria:

- The executor rejects any action whose persisted proposal or approval
  fingerprint changed.
- Success requires workload readiness and relevant telemetry evidence.
- Failed verification produces an explicit, verified recovery outcome.

## P1 — Remove incomplete product surfaces

- [ ] Audit every navigation item, control, and API route.
- [ ] Finish Incidents end to end or remove it.
- [ ] Finish pgvector investigation retrieval or remove it.
- [ ] Remove placeholder, hardcoded, fabricated, and simulated states.
- [ ] Remove controls that cannot perform their advertised action.
- [ ] Ensure unavailable integrations disappear or show an explicit setup
      state.
- [ ] Verify Codex-specific content never appears without a connected Codex
      source.

## P1 — Identity and security

- [ ] Test OIDC against a production-like identity provider.
- [ ] Verify viewer, analyst, operator, and administrator permissions across the
      UI and API.
- [ ] Add session revocation.
- [ ] Audit login, logout, refresh, denial, and role changes.
- [ ] Integrate an external secret manager.
- [ ] Add connector credential rotation.
- [ ] Verify tenant isolation for every new table and endpoint.
- [ ] Add API rate limits and request-size limits.

## P1 — Worker reliability

- [ ] Test multiple workers competing for the same jobs.
- [ ] Prove only one worker executes each active lease.
- [ ] Test lease expiry during forced worker termination.
- [ ] Add durable job cancellation.
- [ ] Add dead-letter inspection and retry controls to the UI.
- [ ] Export queue depth, retry count, job age, and failure metrics.
- [ ] Add graceful shutdown tests.
- [ ] Define worker concurrency and capacity limits.

## P1 — Connector reliability

- [ ] Add bounded exponential backoff to every external connector.
- [ ] Add connector-specific rate limits.
- [ ] Add circuit breakers.
- [ ] Display last success, last failure, latency, and freshness.
- [ ] Add diagnostics that never expose connector credentials.
- [ ] Test SigNoz, Kubernetes, Generic OpenTelemetry, MCP, Codex, and Claude
      independently.
- [ ] Document least-privilege permissions for every connector.

## P1 — Deployment readiness

- [ ] Publish versioned API, UI, worker, executor, and migration images.
- [ ] Sign and verify container images.
- [ ] Configure and verify production ingress, TLS, and DNS.
- [ ] Verify NetworkPolicies and namespace isolation.
- [ ] Document zero-downtime migration and rollback procedures.
- [ ] Test database backup restoration on a clean environment.
- [ ] Add dependency and container vulnerability gates.
- [ ] Add upgrade compatibility tests.
- [ ] Define API, worker, and investigation service-level objectives.

## P1 — Product quality

- [ ] Test onboarding with a user unfamiliar with Tracey.
- [ ] Improve empty, loading, partial, unavailable, and failure states.
- [ ] Verify responsive layouts on supported desktop and mobile sizes.
- [ ] Complete keyboard navigation and accessibility checks.
- [ ] Add user-facing audit and durable-job status pages.
- [ ] Add investigation and website-scan report export.
- [ ] Add browser end-to-end tests for critical workflows.

## P2 — Evaluation

- [ ] Build 30–50 genuine or controlled failure scenarios.
- [ ] Cover model, tool, agent, Kubernetes, telemetry, latency, and remediation
      failures.
- [ ] Measure diagnosis accuracy.
- [ ] Measure evidence precision and false-grounding rate.
- [ ] Measure unsafe-proposal rejection.
- [ ] Measure execution, verification, and rollback correctness.
- [ ] Measure investigation latency, token usage, and cost.
- [ ] Establish release thresholds.
- [ ] Generate a reproducible evaluation report for each release candidate.

## Private-alpha release gate

- [ ] A clean installation works without historical local state.
- [ ] A custom OpenTelemetry agent connects entirely through the UI.
- [ ] A real execution appears with an understandable execution graph.
- [ ] Tracey diagnoses a controlled failure with citable evidence.
- [ ] An administrator approves a typed remediation.
- [ ] The executor performs exactly the approved action.
- [ ] Kubernetes and SigNoz verify the outcome.
- [ ] A harmful result triggers and verifies rollback.
- [ ] Background investigations survive API and worker restarts.
- [ ] An authorized website scan completes through the UI.
- [ ] OIDC roles and tenant isolation are proven.
- [ ] Production security, backup, capacity, and upgrade gates pass.
