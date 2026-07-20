# Tracey Implementation Plan

This plan implements the requirements in `GOAL.md`. Progress is recorded in the live progress table in that file.

## Phase 1 — Control-plane safety foundation — Complete

- Implement typed actions, remediation plans, autonomy policies, and deterministic decisions.
- Remove direct model access to infrastructure mutations and arbitrary shell execution.
- Add privacy-safe Kubernetes evidence projections and strict resource validation.
- Persist policies, lifecycle state, snapshots, results, and append-only events.

Exit gate: all five modes have tests; model mutation calls cannot reach the Kubernetes adapter; the database migration captures the required lifecycle evidence.

## Phase 2 — Restricted execution and recovery — Complete

- Deploy the executor separately from the investigator using its own ServiceAccount.
- Add authenticated, idempotent executor requests and workload allowlists.
- Complete typed Kubernetes remediation operations.
- Implement workload rollout verification and automatic compensating actions.

Exit evidence: kind action `3f704d7a-705a-4c6c-ab92-1cfd2d0f08d2` detected a SigNoz regression, rolled revision 23 back to 22, and verified both workload readiness and a zero recovery error-rate increase.

## Phase 3 — Observability verification — Complete

- Implement bounded SigNoz metric/log/exception tools.
- Capture before/after error rate and latency baselines.
- Require workload and observability checks before success.
- Add redaction tests around every OpenRouter-bound result.

Exit gate: Tracey never marks remediation successful without Kubernetes readiness and SigNoz comparison evidence.

## Phase 4 — Operator product surface — Complete

- Complete `/agent`, `/notifs`, and SRE control-plane workflows.
- Display mode, policy, evidence, plan, risk, approval, action timeline, verification, and recovery.
- Support role-appropriate policy editing and break-glass operations.

Exit evidence: the deployed Streamlit UI authenticated with a temporary integration credential and rendered the live guarded policy, action histories, approval rejection, verification, recovery, and `/notifs`; the normal credential was restored afterward.

## Phase 5 — Production deployment — Complete for the Kubernetes/SigNoz adapter

- Complete local/staging/production overlays, NetworkPolicies, security contexts, probes, resources, PDBs, and pinned images.
- Run all migrations through a reliable migration job.
- Validate least-privilege RBAC using Kubernetes authorization checks.
- Add distributed executor workers, claims, cooldowns, and idempotency tests.

Exit evidence: replicated services run on kind with pgvector and SigNoz Cloud; namespace RBAC denials, RLS tenant isolation, NetworkPolicies, server-side manifest dry-run, nine tracked migrations, idempotency, and restricted executor behavior are verified. A target organization supplies its managed database, registry, ingress, and secret manager.

## Phase 6 — Provider expansion — Future integrations

- Add AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub adapters behind the same typed registry.
- Require provider-specific policy, identity, verification, and recovery contracts.

Exit gate: each advertised adapter has real integration evidence; unavailable adapters remain clearly documented as future work.

## Phase 7 — Standalone product and connector boundary — Complete

- Introduce `@tracey/connectors` as the typed catalog for SigNoz, Kubernetes, Codex, Claude Code, generic OpenTelemetry, and MCP integrations.
- Expose authenticated connector discovery through `GET /v1/connectors` and the UI.
- Remove the reference agent deployment, credentials, image wiring, and workload defaults from Tracey-owned Kubernetes overlays and scripts.
- Export the reference Notes application's deployment assets to its own repository.
- Require external telemetry namespaces to opt in explicitly, without granting mutation authority.

Exit gate: all Tracey overlays render without an application workload, the catalog contains only external-system connectors, and the independently owned Notes manifest passes Kubernetes dry-run from its own repository.

## Final audit — Complete

The full workspace test, typecheck, lint, and build gates pass. External-agent isolation tests and Python compilation pass. Local/staging/production overlays render, local and production server dry-runs pass, the complete local deployment script applies all nine tracked migrations, and live pod, RBAC, RLS, UI/API, recovery, repository-secret, and cluster-log checks pass.

The product UI is deployed as two healthy replicas and all seven workspace surfaces pass Streamlit application tests against the live API. UI visitors are not asked to authenticate; a dedicated server-side secret carries the temporary shared control-plane credential without exposing it in browser state.
