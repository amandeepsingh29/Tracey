# Tracey Product TODO

Last updated: 2026-07-29

This is the single source of truth for unfinished Tracey product work. A checked
item means the capability exists and has verification at the stated scope. It
does not mean Tracey is ready for every deployment environment.

## Product goal

Tracey is a standalone reliability and operations product for production AI
agents. A team should be able to connect its existing telemetry and
infrastructure, understand what an agent execution did, investigate failures,
approve a corrective action, and verify the outcome without depending on Codex,
Claude Code, the Notes application, or any other bundled agent.

The target milestone is a private production alpha in which a new team can
complete this journey on a fresh installation:

```text
Install Tracey
  -> connect SigNoz and Kubernetes
  -> register any OpenTelemetry agent
  -> observe a real execution
  -> inspect its execution graph
  -> investigate a controlled failure
  -> approve a remediation
  -> execute and verify the change
  -> recover when verification fails
```

## What exists now

- [x] Standalone API, Next.js UI, worker, restricted executor, PostgreSQL with
      pgvector, policy engine, and connector framework.
- [x] Real SigNoz query adapter and OpenTelemetry ingestion path.
- [x] Kubernetes investigation and typed mutation adapters.
- [x] Registered-agent directory with telemetry identity verification.
- [x] Agent-neutral Runs page whose sources and filters come from active
      registrations and observed executions.
- [x] Execution detail graph for prompts, model activity, tool calls, results,
      and infrastructure spans when the producer emits that data.
- [x] Persistent evidence-bound investigations with follow-up chat.
- [x] Typed remediation proposals, deterministic policy evaluation, explicit
      approval, restricted execution, verification, and recovery state.
- [x] Observe, recommend, approval, guarded-autopilot, and full-autopilot policy
      modes.
- [x] In-product notifications and auditable action history.
- [x] Local lifecycle commands: `pnpm tracey:up`, `pnpm tracey:status`, and
      `pnpm tracey:down`.
- [x] Read-only Tracey MCP investigation tools.

## P0 — Private alpha completion

These items block calling Tracey a production alpha.

### 1. Prove a clean installation

- [ ] Create an automated clean-machine installation test.
- [ ] Start every required service from only documented configuration.
- [ ] Apply every PostgreSQL migration to an empty database.
- [ ] Verify startup failure messages for missing SigNoz, PostgreSQL, executor,
      and model-provider configuration.
- [ ] Prove `tracey:down` stops only Tracey-owned processes and containers.
- [ ] Publish a versioned local installation artifact or container set.

Acceptance criteria:

- A developer unfamiliar with the repository can start Tracey using the README.
- No manually seeded database rows or historical local data are required.
- The health page identifies each unavailable dependency and its corrective
  action.

### 2. Finish agent-agnostic onboarding

- [x] Remove the remaining hardcoded producer options from the Agents page.
- [x] Generate supported producer choices from the connector capability
      registry.
- [x] Make Codex and Claude disappear from every workflow when their connectors
      are not enabled.
- [x] Verify registration and telemetry observation as separate states.
- [x] Make generic OpenTelemetry the default onboarding source when telemetry is
      ready.
- [ ] Add a copyable OpenTelemetry setup generated from the selected agent
      language/framework.
- [ ] Test Python, Node.js, and one framework-neutral OTLP producer end to end.
- [ ] Publish `@tracey/instrumentation` only after its telemetry contract passes
      live compatibility verification.

Acceptance criteria:

- A custom agent is the default happy path.
- The UI contains no producer-specific page or fallback.
- Saving an agent registration never implies that telemetry has been observed.
- The first matching execution appears without restarting Tracey.

### 3. Make execution observability complete

- [ ] Define and version the minimum execution telemetry contract.
- [ ] Display contract completeness per agent and per execution.
- [ ] Preserve prompt, response, model, retrieval, tool, result, error, token,
      latency, and cost fields when emitted.
- [ ] Clearly distinguish absent producer data from query failures.
- [ ] Add live refresh or bounded polling to the Runs feed.
- [ ] Verify pagination and stable ordering with high execution volume.
- [ ] Add saved filters and shareable execution URLs.
- [ ] Ensure every execution row routes to the correct source-specific detail
      resolver without source-specific list-page behavior.

Acceptance criteria:

- A user can start from an agent filter and find a specific recent execution.
- The graph explains the ordered path from user input to agent action.
- Missing content is attributed to the producer contract, not reported as an
  empty successful query.

### 4. Harden investigations

- [ ] Test investigations across custom OpenTelemetry, Kubernetes, and SigNoz
      evidence without relying on Codex data.
- [ ] Ensure a failed tool never stops the remaining investigation plan.
- [ ] Add visible per-source success, failure, and freshness states.
- [ ] Add deterministic retry limits and latency budgets for every tool.
- [ ] Validate that every technical claim links to returned evidence.
- [ ] Add report export with the same evidence references shown in the UI.
- [ ] Measure unsupported-question and false-grounding rates.

Acceptance criteria:

- Tracey completes the current response instead of promising to continue later.
- Partial investigations identify exactly which source failed.
- An evidence-bound label is shown only when the response contains usable
  evidence.

### 5. Prove remediation safety and recovery

- [ ] Run the full approval workflow from the production web UI on a freshly
      linked custom agent deployment.
- [ ] Verify immutable proposal parameters and approval fingerprints.
- [ ] Verify idempotency across API, worker, and executor restarts.
- [ ] Exercise restart, rollback, scale, resource, HPA, Job, CronJob, apply,
      patch, and delete actions against controlled staging workloads.
- [ ] Add failure-injection tests for executor timeout, Kubernetes rejection,
      rollout timeout, SigNoz outage, and rollback failure.
- [ ] Prove before/after health comparison for every automatic action type.
- [ ] Keep arbitrary shell, pod exec, secret access, RBAC mutation, and namespace
      deletion outside the normal executor.

Acceptance criteria:

- No model-selected tool can mutate infrastructure directly.
- An approved action cannot execute if any persisted parameter changes.
- Success requires workload readiness and relevant observability evidence.
- A failed verification produces an explicit recovery outcome.

## P1 — Production deployment

### Identity and tenant security

- [ ] Integrate a real OIDC identity provider.
- [ ] Replace the shared UI service identity with per-user sessions.
- [ ] Enforce viewer, analyst, operator, and administrator permissions end to
      end.
- [ ] Prove tenant isolation across PostgreSQL, SigNoz credentials, connector
      configuration, investigations, and actions.
- [ ] Add session expiry, revocation, and security-event auditing.
- [ ] Add an external secret manager for production connector credentials.

### Deployment and operations

- [ ] Publish signed API, web, worker, executor, and migration images.
- [ ] Replace registry placeholders in staging and production overlays.
- [ ] Add ingress, TLS, DNS, and network-policy verification.
- [ ] Document managed PostgreSQL backup, restore, retention, and disaster
      recovery.
- [ ] Add zero-downtime migration and rollback procedures.
- [ ] Define capacity targets and run API, worker, database, and Runs-feed load
      tests.
- [ ] Add Tracey self-observability dashboards and alerts.
- [ ] Add upgrade compatibility tests for the previous supported release.
- [ ] Run a production dependency and container vulnerability gate in CI.

### Product reliability

- [ ] Define API and worker service-level objectives.
- [ ] Add distributed worker lease and failover tests.
- [ ] Add connector rate limiting, backoff, and circuit breakers.
- [ ] Add retention policies for investigations, audit events, and embeddings.
- [ ] Add data export and tenant deletion workflows.
- [ ] Verify browser accessibility and responsive layouts after each major UI
      change.

## P1 — Evaluation and proof

- [ ] Build a reviewed dataset of 30–50 genuine incidents or controlled staging
      faults.
- [ ] Cover agent errors, tool failures, model failures, latency regressions,
      Kubernetes failures, telemetry gaps, and bad remediations.
- [ ] Measure diagnosis accuracy, evidence precision, false-grounding rate,
      remediation acceptance, unsafe-plan rejection, verification accuracy,
      latency, token usage, and cost.
- [ ] Establish release thresholds for each metric.
- [ ] Store evaluation inputs and expected outcomes without returning fixtures
      from production APIs.
- [ ] Publish a reproducible evaluation report for every release candidate.

## P2 — Additional adapters

Kubernetes and SigNoz are the current supported operational adapters. Do not
advertise another provider until its real integration, least-privilege identity,
policy checks, verification, recovery, and tests are complete.

- [ ] AWS.
- [ ] GCP.
- [ ] Azure.
- [ ] Argo CD.
- [ ] Helm.
- [ ] Terraform.
- [ ] GitHub.
- [ ] Additional Kubernetes workload mappings: StatefulSet, DaemonSet, Job, and
      CronJob.
- [ ] Serverless, virtual-machine, and managed-service resource mappings.
- [ ] External notification delivery such as Slack, email, and PagerDuty.

## Explicit non-goals for the private alpha

- Bundling or deploying customer agent applications.
- Making Codex the default or required producer.
- Claiming that registration alone proves telemetry connectivity.
- Fabricated runs, incidents, metrics, connector health, or execution results.
- Unrestricted shell access through the ordinary Tracey executor.
- Returning Kubernetes Secret values or stored connector credentials.
- Advertising unverified cloud-provider adapters.
- Building broad generic chat that is unrelated to agent reliability and
  operations.

## Release gate

Tracey reaches private production alpha only when all of the following are
checked:

- [ ] A clean installation completes without repository-specific local state.
- [ ] A new custom OpenTelemetry agent is connected entirely through the UI.
- [ ] Its real execution appears in Runs with an understandable graph.
- [ ] Tracey diagnoses a controlled failure with citable evidence.
- [ ] An administrator approves a typed Kubernetes remediation.
- [ ] The executor performs exactly the approved action.
- [ ] Kubernetes and SigNoz verification determine the final state.
- [ ] A deliberately harmful result triggers and verifies recovery.
- [ ] OIDC identities and tenant isolation are proven.
- [ ] Production deployment, backup, security, load, and upgrade gates pass.
- [ ] The evaluation dataset meets the defined release thresholds.

## Progress log

Update this table only when verification evidence exists.

| Date | Change | Verification |
| --- | --- | --- |
| 2026-07-29 | Agent onboarding now comes from enabled connector capabilities, defaults to generic OpenTelemetry, and keeps registration separate from observed telemetry | Connector, API, and web tests plus live API and browser verification |
| 2026-07-29 | Runs sources and filters now follow active registered agents; Codex has no dedicated list-page behavior | API tests, web tests, production builds, and live browser inspection |
| 2026-07-28 | Agent registration can be linked to a discovered Kubernetes Deployment | API tests and live Deployment lookup |
| 2026-07-28 | Repository-owned runtime lifecycle commands added | Runtime tests and complete local start/status/stop verification |
