# Tracey Production Autonomy Goal

Transform Tracey into a production-grade autonomous cloud/SRE agent with configurable autonomy modes, a larger structured toolset, strict execution policies, complete auditing, and post-action verification.

Work with full ownership. Inspect the current code before modifying it. Preserve working SigNoz, PostgreSQL/pgvector, notifications, agent chat, triggers, external-agent connectors, and existing investigation capabilities. Do not replace real integrations with mocks, fake results, hardcoded workflows, or demo-only behavior.

## Live progress

Last updated: 2026-07-19

| Goal area | Status | Current evidence | Still required |
| --- | --- | --- | --- |
| Autonomy modes and policy engine | Complete | `@tracey/autonomy` implements and tests all five modes plus persisted scope, role, risk, confidence, blast-radius, cooldown, concurrency, maintenance-window, replica-limit, reversibility, and verification controls | None |
| Investigator/planner/policy/executor separation | Complete | Model tools can only submit a structured remediation plan; policy evaluation and a separately deployed restricted executor own every mutation | None |
| Expanded Kubernetes tools | Complete | The registry contains purpose-built remediation operations plus generic apply, merge-patch, and delete for permitted Kubernetes resource kinds; generic mutations are hard-wired to require administrator confirmation | Provider-specific cloud adapters remain documented future integrations |
| Natural-language discovery defaults | Complete | Recent Codex activity uses a dedicated bounded log-search tool, and namespace-free pod questions enumerate either configured allowlists or an explicit cluster-wide `*` scope without guessing | Kubernetes RBAC still defines the maximum visible scope |
| Durable action lifecycle | Complete | Migrations `007`–`009` are applied to live PostgreSQL; proposals, transitions, events, snapshots, results, recovery, idempotency receipts, break-glass overrides, and notifications are persisted | None |
| Verification and automatic recovery | Complete | Live action `3f704d7a-705a-4c6c-ab92-1cfd2d0f08d2` detected a 0.2445 error-rate increase, rolled revision 23 back to 22, then verified workload readiness and zero recovery error-rate increase | None |
| Authentication and roles | Complete | OIDC/static-token auth, viewer/analyst/operator/admin authorization, operator policy restrictions, approval gating, live tenant-RLS isolation, and a durable time-limited break-glass override are verified | External IdP provisioning is deployment-specific |
| Privacy and credentials | Complete | Secret-bearing build inputs are excluded; Kubernetes values and tool/OpenRouter payloads are bounded/redacted; exact-value, generic credential-shape, and live cluster-log scans are clean | The owner must still rotate credentials previously pasted into chat, as documented |
| SRE interface | Complete | The deployed product workspace provides overview health, connector setup, external-agent registration, grounded investigations, structured policy and trigger management, action approval/recovery timelines, and an internal notification inbox. Browser authentication fields were removed; the UI uses a dedicated server-side service credential. | External IdP remains a later deployment capability |
| Kubernetes/deployment hardening | Complete | Separate SAs, a standalone authenticated executor, two distributed worker replicas, NetworkPolicies, probes, resources, non-root contexts, PDBs, pinned images, and local/staging/production Kustomize overlays pass server dry-run. Executor RBAC is intentionally broad for operator-confirmed workload/platform operations but excludes credentials, identity, RBAC, and namespaces | Cloud registry names must be replaced for an actual target account |
| Documentation | Complete | `PRD.md`, `IMPLEMENTATION_PLAN.md`, `README.md`, and this status document the architecture, modes, tools, risk, policies, operations, deployment, onboarding, lifecycle, recovery, evidence, and future providers | None |
| Standalone product boundary | Complete | Tracey owns only its API, UI, worker, policy engine, restricted executor, PostgreSQL, Collector, and typed connector framework; the Notes deployment assets now live in the Notes repository and `/v1/connectors` reports six external integrations | None |
| Full verification | Complete | Full workspace test/typecheck/lint/build, Notes tests/compile, nine migrations, local deployment script, three overlays, server dry-run, live pods, RLS, RBAC, UI, SigNoz success/recovery, source-secret, and cluster-log gates pass | None |

### Live completion evidence

- Guarded success: action `3fa0e741-26c3-46aa-80c2-90faf52985c4` completed policy evaluation, restricted execution, rollout readiness, and SigNoz comparison.
- Verified recovery: action `3f704d7a-705a-4c6c-ab92-1cfd2d0f08d2` entered `reverting` after an observed regression and reached `reverted` only after rollback readiness and SigNoz recovery passed.
- Approval gate: action `267ba390-9589-4d64-851e-58a5db376ff0` remained `awaiting_approval` with an unchanged Deployment until an admin rejected it.
- Confirmation-first generic control: action `8d774e28-96f3-4413-817c-87588cf62c64` could not execute before approval (HTTP 409), then applied and verified a ConfigMap after admin confirmation. Cleanup action `2de40047-9a50-46f2-999e-202df5960856` independently paused for approval, deleted it, and verified resource absence.
- Break glass: override `ea5d4ec0-b5ec-4df4-94ff-8f1ba3c0ebf7` temporarily selected an approval policy, preserved mandatory prohibitions, produced an audited decision, and was revoked.
- Tenant isolation: a non-superuser RLS probe saw 13 local action records and zero records after switching to an isolated tenant.
- Deployment: local, staging, and production overlays render; local and production passed Kubernetes server-side dry-run; investigator/executor authorization denials were checked live.
- Standalone boundary: Tracey API, UI, executor, Worker, Collector, and PostgreSQL are healthy in `production`; the external reference agent is healthy in its own namespace with separately installed scoped connector RBAC.
- UI: the deployed Streamlit interface authenticated to the in-cluster API and rendered the guarded policy, action histories, approval state, verification/recovery data, and `/notifs`.

Status rules:

- `Complete` means the requirement is implemented and verified at its full stated scope.
- `In progress` means useful code exists but at least one completion criterion remains unproven.
- The project goal remains active until every completion criterion at the end of this file is proven.

## 1. Autonomy modes

Implement these configurable modes:

- `observe`: read-only investigation.
- `recommend`: investigation plus remediation plans.
- `approval`: all mutations require authorized human approval.
- `guarded_autopilot`: automatically execute allowlisted and reversible actions.
- `full_autopilot`: broader autonomous execution within explicit policy boundaries.

Approval mode is the default operator posture. Autopilot modes remain available for purpose-built actions, while generic Kubernetes apply/patch/delete operations always require explicit administrator confirmation.

Support global defaults and per-agent/per-service policy overrides. Persist policies in PostgreSQL rather than hardcoding them.

## 2. Required architecture

Separate the agentic system into:

- Investigator: gathers evidence using read-only tools.
- Remediation Planner: creates a structured plan with evidence, confidence, risk, expected impact, verification steps, and rollback steps.
- Policy Engine: determines `deny`, `recommend`, `require_approval`, or `auto_execute`.
- Executor: performs only validated structured actions.
- Verifier: checks SigNoz and Kubernetes health after execution.
- Recovery Manager: reverts an action when verification fails or health deteriorates.

The LLM must never call infrastructure adapters directly. Every mutation must pass through the policy engine and executor.

## 3. Expand the tool system

Add structured, typed tools for the following areas.

### Kubernetes investigation

- `list_pods`
- `describe_pod`
- `get_pod_status`
- `get_pod_logs` with privacy filtering
- `get_container_restarts`
- `get_k8s_events`
- `get_deployment_config` without secret values
- `get_deployment_rollout_status`
- `get_replica_set_history`
- `get_resource_usage`
- `get_node_health`
- `get_service_endpoints`
- `get_ingress_status`
- `get_hpa_status`
- `get_pdb_status`
- `get_recent_changes`

### Kubernetes remediation

- `restart_workload`
- `rollback_deployment`
- `scale_deployment`
- `update_resource_limits`
- `update_hpa`
- `retry_job`
- `suspend_cronjob`
- `resume_cronjob`
- `apply_config_patch`
- `restore_previous_config`

### SigNoz and observability

- `search_traces`
- `inspect_trace`
- `query_metrics`
- `query_logs` with redaction
- `inspect_exceptions`
- `compare_before_after`
- `calculate_error_rate`
- `calculate_latency_change`
- `determine_affected_services`
- `verify_incident_recovery`

Do not expose arbitrary shell execution.

Design the tool registry so AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub adapters can be added later without rewriting the agent loop.

## 4. Policy and safety controls

Every mutation must validate:

- Tenant.
- Environment.
- Namespace.
- Workload/resource allowlist.
- Autonomy mode.
- Action allowlist.
- User role.
- Risk level.
- Confidence threshold.
- Blast radius.
- Cooldown.
- Concurrent-action limit.
- Maintenance window.
- Resource-specific limits.
- Reversibility.
- Availability of a verification plan.

Expected behavior:

- Restart one unhealthy pod: requires confirmation in the default approval policy.
- Roll back to a known healthy revision: requires confirmation in the default approval policy.
- Scale within configured limits: requires confirmation in the default approval policy.
- Edit environment variables: require approval by default.
- Modify network policy: require approval.
- Read Kubernetes secrets: prohibited.
- Delete namespace or database: prohibited.
- Execute arbitrary shell commands: prohibited.

## 5. Kubernetes authorization

Use separate identities:

- A read-only investigator ServiceAccount.
- A separate authenticated executor ServiceAccount with broad workload/platform mutation access.

Do not grant access to Secrets, service accounts, RBAC roles/bindings, or namespaces. Broad non-credential resource mutation is permitted only through durable approved actions.

Eliminate shell-based `kubectl` execution. Use the Kubernetes API with strict DNS-label validation and namespace/workload allowlists.

## 6. Action lifecycle

Implement a durable state machine:

```text
proposed
-> policy_evaluated
-> awaiting_approval or approved_for_auto_execution
-> executing
-> verifying
-> succeeded or failed
-> reverting
-> reverted or revert_failed
```

Persist:

- Action ID.
- Investigation/session ID.
- Triggering evidence.
- Proposed action.
- Policy decision and explanation.
- Requester/model identity.
- Approver identity.
- Exact validated parameters.
- Pre-action snapshot.
- Execution result.
- Verification result.
- Rollback result.
- Timestamps and idempotency key.

Use PostgreSQL migrations and pgvector where semantic retrieval is useful. Do not introduce Qdrant.

## 7. Verification and recovery

No action is successful merely because the Kubernetes API accepted it.

After each mutation:

- Wait for the relevant rollout or workload condition.
- Compare SigNoz error rate, latency, traces, and relevant logs before and after.
- Confirm Kubernetes readiness.
- Persist verification evidence.
- Revert automatically when policy permits and health becomes worse.
- Notify `/notifs` about proposal, approval, execution, verification, failure, and rollback.

## 8. Authentication and roles

Preserve OIDC and tenant isolation.

Enforce:

- Viewer: read-only results.
- Analyst: investigations and remediation recommendations.
- Operator: action proposals and permitted guarded-autopilot configuration.
- Admin: approvals, high-risk policy changes, executor configuration, and break-glass operations.

An analyst chat must not bypass policy enforcement.

## 9. Privacy and credential remediation

Immediately remove the committed bearer token from scripts and documentation. Replace it with environment-based configuration and document that the exposed credential must be rotated.

Before sending tool results to OpenRouter:

- Redact credentials, tokens, cookies, authorization headers, personal information, prompt contents, and secret-like environment variables.
- Never return Kubernetes secret values.
- Bound log, event, and configuration output.
- Use allowlisted structured fields.
- Persist hashes or safe summaries instead of raw sensitive tool payloads.

Harden the Kubernetes OTel Collector using the existing privacy-safe collector configuration.

Do not print or reproduce any existing secret values during implementation or testing.

## 10. SRE interface

Repair the SRE UI:

- Use `TRACEY_API_URL` instead of localhost.
- Implement proper authenticated API access.
- Remove subprocess-based simulation.
- Remove undefined functions.
- Show autonomy mode and active policy.
- Show investigation evidence.
- Show remediation plan and risk.
- Show approval controls when required.
- Show execution and verification progress.
- Show rollback status.
- Link events to `/notifs`.

The UI must not contain embedded shared admin credentials.

## 11. Deployment hardening

Make Kubernetes manifests production-shaped:

- Pinned image versions.
- Readiness and liveness probes.
- Resource requests and realistic limits.
- Security contexts.
- Multiple replicas where supported.
- PodDisruptionBudgets.
- NetworkPolicies.
- Namespace-scoped RBAC.
- Secrets through Kubernetes Secret references.
- No machine-specific paths.
- No `imagePullPolicy: Never` in production manifests.
- Separate local/staging and production overlays.

Update deployment scripts to run every PostgreSQL migration and fail clearly instead of silently ignoring failed infrastructure installation.

## 12. Documentation

Restore and update `PRD.md` and `IMPLEMENTATION_PLAN.md`.

Document:

- Tracey's investigator/planner/policy/executor/verifier architecture.
- Autonomy modes.
- Tool catalog.
- Action risk classification.
- Policy examples.
- Supported and prohibited operations.
- Deployment model.
- Custom-agent onboarding.
- Incident lifecycle.
- Verification and recovery behavior.
- Remaining provider integrations.

Remove language presenting Tracey as a demo. Clearly distinguish completed features from future integrations.

## 13. Testing requirements

Add:

- Unit tests for tool schemas and resource-name validation.
- Policy-engine decision tests for every autonomy mode.
- RBAC and tenant-isolation tests.
- Prompt-injection and shell-injection tests.
- Sensitive-data redaction tests.
- Action state-machine tests.
- Idempotency and concurrency tests.
- Executor failure tests.
- Verification and automatic-revert tests.
- UI/API integration tests.
- Kubernetes integration tests using kind.

Use real local PostgreSQL, Kubernetes/kind, OpenTelemetry, and SigNoz where available. If an external provider cannot be tested honestly, leave a clear TODO rather than fabricating success.

## 14. Completion criteria

The work is complete only when:

- Typecheck, lint, build, and all tests pass.
- No credential is hardcoded.
- No arbitrary shell mutation exists.
- The LLM cannot bypass the policy engine.
- Broad executor RBAC is limited to non-credential, non-identity, non-namespace resources and every generic mutation is confirmation-gated.
- All actions are durable and auditable.
- Guarded Autopilot can safely diagnose, remediate, verify, and revert a controlled Kubernetes failure.
- Approval mode prevents execution until an authorized admin approves.
- Observe and recommend modes cannot mutate infrastructure.
- Privacy tests prove secrets and raw sensitive data are not sent to OpenRouter.
- The SRE UI works against the deployed API.
- Documentation matches the implemented behavior.

First produce a concise implementation plan based on the current repository, then implement it phase by phase. Do not stop after planning or scaffolding. Continue through testing and verification, and report any genuine external blocker clearly.
