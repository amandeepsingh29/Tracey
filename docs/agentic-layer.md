# Agentic investigation and automation

Tracey's model layer is a bounded investigator and remediation planner above deterministic SigNoz and Kubernetes adapters. OpenRouter can select server-owned investigation tools and one `propose_remediation` tool. The loop permits at most eight model iterations and twelve tool calls. Tool results are projected to evidence-safe summaries, tool arguments are persisted only as SHA-256 audit hashes, and citations not present in returned evidence are removed.

The operator UI is available at `/agent`. Sessions and user/assistant messages are stored in PostgreSQL; raw tool results and model reasoning are not stored. The default model is `tencent/hy3:free`. A final synthesis call disables reasoning so reasoning tokens cannot consume the answer budget.

## Authentication and roles

Local operation accepts `TRACEY_API_BEARER_TOKEN` as an admin credential. Production can configure `OIDC_ISSUER_URL`, `OIDC_JWKS_URL`, and `OIDC_AUDIENCE`. Tokens must contain the configured tenant claim matching this deployment's `TRACEY_TENANT_ID` and one or more roles: `viewer`, `analyst`, `operator`, or `admin`.

- viewer: authenticated read routes
- analyst: create and use investigation chats
- operator: create/fire triggers and propose actions
- admin: agent registration, action approval, and approved action execution

## Triggers and distributed polling

`trace_webhook` triggers accept either an exact trace ID or Codex conversation ID. `error_run` and `latency` triggers are polled by `@tracey/worker`. Multiple workers claim due rules with row locks, `SKIP LOCKED`, and two-minute leases, so replicas do not poll the same rule concurrently. Each trace can execute a trigger once. Codex scheduled enumeration is intentionally unsupported because its native contract requires an exact conversation ID; connect a SigNoz alert webhook with that ID instead.

Completed trigger investigations create tenant-scoped notifications in Tracey's internal inbox. Operators use `/notifs` to view unread and historical findings, open the linked investigation session, and mark notifications read. Tracey does not push findings to Slack, email, or PagerDuty by default.

## Confirmation-first cloud actions

Tracey never gives the model direct infrastructure access. A remediation proposal is validated, policy-evaluated, persisted, and shown in Change Control. In the default approval mode, an admin must approve or reject every mutation in a separate API call. Only an approved proposal can reach the authenticated executor, and every request carries a stable idempotency key.

The Kubernetes executor supports both purpose-built recovery actions and generic apply, merge-patch, and delete operations for permitted resources. Generic mutations are confirmation-only at the policy-engine level, even if a tenant switches to an autopilot mode. Pre-action identity, executor receipt, post-action resource identity, actor, policy decision, and state transitions remain in PostgreSQL.

Endpoints:

- `POST /v1/investigations`
- `POST /v1/investigations/{sessionId}/messages`
- `POST /v1/triggers` and `POST /v1/triggers/{triggerId}/fire`
- `POST /v1/actions`
- `POST /v1/actions/{proposalId}/decision`
- `POST /v1/actions/{proposalId}/execute`

## Deployment

`infra/deploy/Dockerfile` builds both API and worker. `compose.production.yaml` declares two API and two worker replicas. `kubernetes.yaml` contains separate replicated deployments, services, health probes, resource limits, and secret/config references. Production uses managed PostgreSQL/pgvector and an independently deployed OpenTelemetry Collector; secrets must not be baked into the image.
