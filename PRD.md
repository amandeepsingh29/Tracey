# Tracey Product Requirements

## Product definition

Tracey is a production AI-agent reliability and cloud-operations control plane. SigNoz remains the telemetry backend. Tracey adds agent semantics, evidence-backed diagnosis, remediation planning, deterministic policy evaluation, restricted execution, verification, recovery, and an auditable operator experience.

Tracey is agent-agnostic: Codex, Claude Code, and custom OpenTelemetry agents can be registered when they emit Tracey's documented telemetry contract.

Tracey is a standalone product. Its repository owns the API, UI, worker, policy engine, authenticated executor, PostgreSQL/pgvector persistence, and connector framework. It does not contain or deploy connected agent applications. SigNoz, Kubernetes clusters, Codex, Claude Code, custom agents, and MCP servers remain external systems connected through adapters.

## Primary outcomes

1. Investigate agent and service failures using real traces, logs, metrics, Kubernetes state, and registered-agent metadata.
2. Produce evidence-linked remediation plans without exposing sensitive application content to model providers.
3. Operate in `observe`, `recommend`, `approval`, `guarded_autopilot`, or `full_autopilot` mode.
4. Execute allowlisted cloud actions through a restricted identity after deterministic policy evaluation.
5. Verify every action against workload and SigNoz health, then recover automatically when permitted.
6. Preserve a tenant-scoped record of every plan, decision, approval, action, verification, notification, and rollback.

## Architecture

```text
Agent telemetry -> OpenTelemetry Collector -> SigNoz
                                            |
Operator/trigger -> Investigator -> Planner -> Policy Engine
                                            |       |
                                      approval   auto-approved
                                            \       /
                                      Restricted Executor
                                               |
                                            Verifier
                                               |
                                      success or Recovery
```

The model may choose read tools and prepare remediation plans. It cannot call infrastructure adapters directly. The policy engine and executor are deterministic application components.

## Autonomy modes

- `observe`: read-only investigation; mutations are denied.
- `recommend`: plans are stored but cannot execute.
- `approval`: an administrator must approve every mutation.
- `guarded_autopilot`: reversible, allowlisted actions can execute within configured confidence, risk, scope, cooldown, and concurrency limits.
- `full_autopilot`: broader allowlisted execution, still bounded by prohibited actions and infrastructure scope.

Production defaults to approval mode. A tenant may enable autopilot for purpose-built actions, but generic Kubernetes apply, patch, and delete operations always pause for explicit administrator confirmation.

## Roles

- Viewer: view tenant-scoped evidence, policies, actions, and notifications.
- Analyst: create and use investigations and receive recommendations.
- Operator: create triggers, submit remediation plans, and operate within permitted guarded policies.
- Admin: approve actions, change high-risk policy, configure executors, and use audited break-glass controls.

## Non-negotiable controls

- No arbitrary shell tool.
- No Kubernetes secret values.
- No cluster-wide destructive role.
- No direct LLM-to-cloud-adapter call.
- No mutation without policy evaluation.
- No success claim based only on API acceptance.
- No raw credentials, prompts, tool payloads, or personal data sent to OpenRouter.
- No fake operational results or placeholder runtime evidence.

## Implemented tool catalog

Kubernetes investigation tools: `list_pods`, `describe_pod`, `get_pod_status`, `get_pod_logs`, `get_container_restarts`, `get_k8s_events`, `get_deployment_config`, `get_deployment_rollout_status`, `get_replica_set_history`, `get_resource_usage`, `get_node_health`, `get_service_endpoints`, `get_ingress_status`, `get_hpa_status`, `get_pdb_status`, and `get_recent_changes`.

Kubernetes remediation actions: `restart_workload`, `rollback_deployment`, `scale_deployment`, `update_resource_limits`, `update_hpa`, `retry_job`, `suspend_cronjob`, `resume_cronjob`, strict non-secret `apply_config_patch`, and `restore_previous_config`.

Observability tools: `search_traces`, `inspect_trace`, `query_metrics`, redacted `query_logs`, `inspect_exceptions`, `compare_before_after`, `calculate_error_rate`, `calculate_latency_change`, `determine_affected_services`, and `verify_incident_recovery`.

## Action risk and policy examples

- Low: restart one allowlisted workload, retry a Job, or suspend/resume a CronJob.
- Medium: bounded scaling, resource-limit changes, HPA changes, rollback, or rollout configuration changes.
- High/critical: wide blast radius, non-standard configuration, or actions outside normal operating bounds; these require admin approval or are denied.
- Generic Kubernetes resource apply, merge-patch, and delete: always require admin approval regardless of autopilot mode.
- Always prohibited: secret reads, namespace deletion, database deletion, and arbitrary shell execution.

A production policy explicitly identifies environments, namespaces, workloads, allowed and automatic actions, confidence, maximum automatic risk, replica/blast-radius limits, concurrent-action limits, cooldown, and optional maintenance windows. `guarded_autopilot` may automatically restart or roll back one allowlisted workload; environment-variable and network-policy changes are not part of the automatic patch schema.

Admins can activate a tenant-scoped break-glass policy for 5–60 minutes with a written reason. It is persisted, notified, automatically expires, can be revoked, and cannot remove mandatory prohibitions.

## Action lifecycle

Actions follow the durable lifecycle defined in `GOAL.md`. State transitions and supporting evidence are stored in PostgreSQL with tenant row-level security and append-only action events.

An incident begins with a user chat or trigger. The investigator gathers bounded evidence, the planner proposes a typed remediation, and the policy engine returns deny, recommend, require approval, or auto-execute. The executor claims an idempotency key, mutates only its allowlisted resource, and the verifier waits for Kubernetes readiness plus SigNoz error/latency evidence. A regression enters recovery; `reverted` is recorded only after the rollback and post-rollback Kubernetes/SigNoz verification both pass.

## Deployment and onboarding

Tracey ships local, staging, and production Kubernetes overlays for Tracey-owned services only. The API investigator, executor, UI, worker, Collector, and PostgreSQL have explicit identities and network paths. Production operators replace registry placeholders, supply Secret objects through their secret manager, run every tracked migration, and configure ingress/TLS and managed PostgreSQL backups.

A custom agent remains independently deployed. It adds OpenTelemetry SDK/framework instrumentation, emits a stable `service.name`, environment and Tracey agent attributes, sends OTLP to the privacy-safe Collector, and registers that identity with Tracey. Prompt/message capture is disabled; raw telemetry stays in SigNoz. Codex and Claude Code use producer-specific normalization without pretending their native event shapes are identical.

The connector registry must expose integration identity, capabilities, required configuration, documentation, and honest runtime readiness. Telemetry connectivity never implies infrastructure mutation authority; Kubernetes access requires separate scoped investigator/executor credentials and an explicit tenant policy.

## Verification evidence

The kind reference path has live evidence for least-privilege RBAC, PostgreSQL RLS isolation, approval non-execution, a successful guarded restart, a controlled error-rate regression, automatic rollback, post-rollback readiness and SigNoz recovery, UI/API integration, and internal notifications. Exact action IDs are recorded in `IMPLEMENTATION_PLAN.md` and the live status in `GOAL.md`.

## Supported platform direction

Kubernetes and SigNoz are the first production adapters. AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub must plug into the typed tool/executor registry without changing the agent loop.

Those provider adapters are not currently advertised as implemented. Each remains future work until its schemas, least-privilege identity, policy controls, verification, rollback, tests, and genuine provider evidence exist.

## Product completion

The authoritative completion gates and live implementation status are maintained in `GOAL.md`. A feature is complete only when implementation and scope-matched verification both exist.
