# Tracey

[![CI](https://github.com/amandeepsingh29/Tracey/actions/workflows/ci.yml/badge.svg)](https://github.com/amandeepsingh29/Tracey/actions/workflows/ci.yml)

Tracey is a production-agent observability control plane built on OpenTelemetry and SigNoz. Production agents remain independently deployed and export telemetry through an OpenTelemetry Collector. Tracey queries SigNoz out of band, reconstructs agent-run graphs, computes critical paths and cost, produces evidence-linked diagnoses, and exposes the same bounded investigation contract through HTTP and MCP.

Tracey also includes an evidence-bound agentic investigator, persistent chat, production triggers, leased background jobs, an in-product notification center at `/notifs`, OIDC/RBAC, five autonomy modes, a deterministic policy engine, a separately deployed authenticated executor, verified recovery, and ownership-verified website security reviews. The default operator posture is approval-first: Tracey can prepare broad cloud changes, but pauses every mutation for confirmation. See [docs/agentic-layer.md](docs/agentic-layer.md).

Read the current [product TODO](TODO.md), the [connector documentation](docs/connectors/README.md), and the [contribution guide](CONTRIBUTING.md).

## Product boundary

Tracey is one standalone product with independently deployable API, UI, worker, restricted executor, PostgreSQL/pgvector storage, policy engine, and connector framework. Agent applications and infrastructure platforms are external systems: Tracey never vendors their source code, owns their deployment, or silently grants itself mutation access.

The connector catalog is available at authenticated `GET /v1/connectors` and currently describes SigNoz, Kubernetes, Codex, Claude Code, generic OpenTelemetry agents, and MCP. Connector state is derived from runtime configuration, so an unavailable integration is reported as `needs_configuration` rather than presented as working. See [docs/connectors/README.md](docs/connectors/README.md).

```text
Tracey core
├── API                         apps/api
├── UI (Next.js)                apps/web
├── Worker                      apps/worker
├── Policy engine               packages/autonomy
├── Restricted executor         apps/executor
├── PostgreSQL + pgvector        packages/postgres-store, infra/postgres
├── Website security scanner     packages/website-scanner
└── Connector framework         packages/connectors
    ├── SigNoz                  packages/signoz-adapter
    ├── Kubernetes              packages/cloud-adapter
    ├── Codex                   packages/codex-normalizer
    ├── Claude Code             producer normalization profile
    ├── Generic OpenTelemetry   packages/instrumentation
    └── MCP                     packages/mcp-client, packages/tracey-mcp-server
```

```text
Codex / Claude Code / custom OTel agents
                  |
                  v
       OpenTelemetry Collector
                  |
                  v
               SigNoz
                  |
                  v
 Investigator -> Planner -> Policy Engine
                                |
                   approval or auto-execute
                                v
                    Restricted Executor
                                |
                    Verifier -> Recovery
                                |
             PostgreSQL + pgvector audit store
```

SigNoz is the system of record for traces, logs, and metrics. PostgreSQL stores Tracey-owned registrations, policies, investigations, triggers, notifications, action lifecycles, executor receipts, temporary break-glass overrides, and semantic indexes over bounded summaries. Tracey does not duplicate raw SigNoz telemetry or execute customer agents.

## Verified production path

The live path `Codex Desktop/custom agent -> OTel Collector -> SigNoz Cloud -> Tracey` is verified. An independently deployed reference agent was used to prove policy evaluation, restricted Kubernetes execution, readiness checks, before/after SigNoz error-rate and latency comparison, automatic rollback, and post-rollback recovery verification on kind. That reference application is not part of Tracey.

Claude Code native trace discovery and framework-neutral custom `agent.run` discovery are implemented through registered producer profiles. A live Claude Code capture remains an environment-specific onboarding check; the adapter does not fabricate verification when telemetry is absent.

## Prerequisites

- Node.js 22 or newer
- pnpm
- PostgreSQL 17 with pgvector 0.8.2 or a compatible managed PostgreSQL service
- A running OpenTelemetry Collector configured from `infra/otel/`
- A SigNoz Cloud or self-hosted instance
- A SigNoz Service Account key for bounded query access
- An OpenRouter-compatible key when agentic chat, autonomous triggers, or remediation planning are enabled
- Kubernetes when using cloud investigation, execution, verification, or recovery

No model-provider key is required for deterministic telemetry queries or stored diagnoses. OpenRouter is used by the optional agentic layer for chat, tool selection, and structured remediation planning; it never receives infrastructure mutation authority, and all tool results are redacted before transmission.

The Website security page at `/security` accepts only HTTPS websites whose ownership has been proven through a one-time file. Its worker performs bounded, read-only checks using GET requests, follows same-origin redirects only, rejects private and reserved network destinations, caps response size, and stores evidence-linked findings. It does not send exploit payloads or claim to replace an authorized penetration test. See [docs/website-security.md](docs/website-security.md).

## Configuration

```bash
cp .env.example .env
```

Set the SigNoz, OTLP, API-authentication, and PostgreSQL values. Keep `.env` outside source control and use a deployment secret manager in production.

Start PostgreSQL locally when needed:

```bash
POSTGRES_PASSWORD='replace-me' docker compose -f infra/postgres/compose.yaml up -d
./scripts/migrate.sh
```

The migration runner applies every numbered migration, records checksums, fails on drift, and runs each migration outside a wrapping transaction so concurrent indexes remain valid.

Start the pinned production collector locally:

```bash
docker compose -f infra/otel/compose.yaml up -d
curl --fail http://127.0.0.1:13133/
```

The collector binds OTLP and health ports only to loopback, applies content and identity redaction before export, and restarts unless explicitly stopped.

Install and build:

```bash
corepack enable
pnpm install
pnpm build
```

Start the complete local product:

```bash
pnpm tracey:up
```

The runtime manager validates `.env`, checks required ports, starts repository-owned PostgreSQL and OpenTelemetry Collector containers, applies checksum-verified migrations, builds Tracey, starts each configured service, waits for real health endpoints, and prints the UI/API URLs. It does not treat an unconfigured collector or executor as healthy.

Inspect or stop the same runtime:

```bash
pnpm tracey:status
pnpm tracey:down
```

Runtime process metadata and logs live under ignored `.tracey/`. Shutdown signals only the recorded Tracey process groups and uses fixed Compose project identities; it preserves PostgreSQL volumes and external telemetry. The executor starts only when its enable flag, dedicated token, namespace scope, and workload scope are all configured.

## Onboard a production agent

Enable an agent-producer connector, then register the telemetry identity Tracey should expect. The connector supplies the producer type, normalizer, and telemetry contract; clients cannot override those values. Tenant scope comes from authenticated server context and is never accepted from the request body.

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "sourceId":"generic-otel",
    "displayName":"Support Agent",
    "serviceName":"support-agent-api",
    "environment":"production"
  }' \
  http://localhost:3000/v1/agents
```

List the current tenant's registered agents:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  http://localhost:3000/v1/agents
```

Query a registered agent without allowing the client to choose its SigNoz service or native root span:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  "http://localhost:3000/v1/agents/<agent-id>/runs?start=$start&end=$end"
```

Tracey returns onboarding sources from the enabled connector registry. Generic OpenTelemetry is the default when the telemetry path is ready; Codex and Claude Code do not appear until their connectors are explicitly enabled. Tracey loads the tenant-scoped registration from PostgreSQL and selects the fixed producer normalizer. Claude Code maps `claude_code.interaction` roots to stable `claude:<trace-id>` run IDs without changing the native spans stored in SigNoz. Codex is conversation-event based, so its registered identity is normalized without pretending it emits native `agent.run` roots.

PostgreSQL row-level security and parameterized queries provide a second tenant boundary beneath the API scope. See [docs/postgres-storage.md](docs/postgres-storage.md).

### Link an agent to its Kubernetes Deployment

After registration, open the agent in the UI and choose **Link deployment**. Tracey discovers namespaces and Deployments from the configured Kubernetes connector; users do not type an unverified workload identity. Saving a mapping performs a live Deployment read and optionally validates the selected container.

The agent page then combines the telemetry identity with live desired, ready, updated, available and unavailable replicas, selected container image, matching pods, container readiness, and restart counts. Investigations use the validated mapping as the authoritative target when resolving application health or preparing a remediation. The mapping never bypasses the policy or approval workflow.

The current mapping contract intentionally supports Kubernetes `Deployment` workloads only. StatefulSets, DaemonSets, Jobs, serverless platforms, virtual machines, and cloud-resource relationships remain unavailable until each has equivalent discovery, health, action, and verification semantics.

## Query production telemetry

Search native `agent.run` roots from an instrumented service:

```bash
end=$(date +%s)000
start=$((end - 3600000))
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  "http://localhost:3000/v1/signoz/agent-runs?start=$start&end=$end&serviceName=your-agent-service"
```

Fetch correlated spans, logs, graph completeness, critical path, and diagnosis:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  "http://localhost:3000/v1/signoz/traces/<trace-id>?start=$start&end=$end"
```

Codex native OTel logs can be discovered over a bounded recent time window or queried and normalized by exact conversation ID as documented in [docs/codex-integration.md](docs/codex-integration.md). Agentic chat routes general requests such as `tell me about recent logs of codex app` through the privacy-safe `search_codex_logs` tool; exact-conversation investigations remain available when a conversation ID is supplied. Claude Code uses its native trace hierarchy as documented in [docs/claude-code-integration.md](docs/claude-code-integration.md). Custom agents use the framework-neutral wrappers in [docs/custom-agent-instrumentation.md](docs/custom-agent-instrumentation.md).

List integrations and their actual configuration state:

```bash
curl --fail-with-body \
  -H "authorization: Bearer $TRACEY_API_BEARER_TOKEN" \
  http://localhost:3000/v1/connectors
```

## MCP

Tracey exposes five bounded, read-only investigation tools over authenticated Streamable HTTP and stdio. It can also observe calls to an explicitly allowlisted external MCP server. See [docs/mcp-integration.md](docs/mcp-integration.md).

## Autonomy and safety

Production defaults to `approval`; the other modes are `observe`, `recommend`, `guarded_autopilot`, and `full_autopilot`. Autopilot modes are advanced capabilities that must be enabled deliberately for specific scopes and actions. Every mutation is a typed plan evaluated against tenant, environment, namespace, workload, role, action, risk, confidence, blast radius, cooldown, concurrency, maintenance-window, replica, reversibility, and verification constraints. Exact managed-pod restarts use the dedicated `restart_pod` action and are verified by confirming the old pod disappears and the controller restores the previous ready-replica count.

The LLM can call `propose_remediation`, but it cannot call Kubernetes mutations. The API sends an approved structured action to the independently authenticated executor ServiceAccount. In addition to purpose-built restart, rollback, scale, resource, HPA, Job, CronJob, and rollout tools, Tracey can apply, merge-patch, and delete arbitrary permitted Kubernetes resource kinds. These generic operations always require an explicit administrator confirmation, even if a policy is configured for autopilot.

The default executor has a namespace-scoped Kubernetes Role. Additional workload namespaces receive their own explicit RoleBinding; Tracey does not silently expand the default identity into a ClusterRole. Broad cluster operation uses a separately deployed privileged executor identity and an explicit application flag. Neither executor can mutate Secrets, service accounts, RBAC roles/bindings, or namespaces, and neither exposes arbitrary shell or pod-exec.

Use the API-backed SRE UI for policy editing, plan construction, evidence, action timelines, approvals, verification, rollback, and notifications. `/notifs` is Tracey's internal notification center; Slack, email, and PagerDuty are not required.

Production and staging use OIDC authorization-code login with PKCE. Each browser user receives an encrypted, HttpOnly session containing that user's short-lived access and refresh tokens; the proxy forwards the individual access token and rotates refreshed sessions. The local profile can retain `TRACEY_UI_ACCESS_TOKEN` for loopback-only development, but `scripts/deploy-k8s.sh` rejects staging or production without an OIDC UI environment file.

## Kubernetes deployment profiles

Kustomize profiles live under `infra/k8s/overlays/local`, `staging`, and `production`. Production and staging image registry names are explicit placeholders that must be replaced with the target organization's registry; tags are pinned.

The complete deployment entrypoint runs all migrations first and fails if a required environment file or secret input is missing:

```bash
TRACEY_DEPLOYMENT_PROFILE=production ./scripts/deploy-k8s.sh
```

The investigator and executor use separate ServiceAccounts. The default executor Role is namespace-scoped; optional external namespace and privileged connector provisioning is documented in [docs/connectors/kubernetes.md](docs/connectors/kubernetes.md). Manifests include NetworkPolicies, PDBs, probes, resources, non-root security contexts, and Secret references. The local profile additionally deploys ephemeral pgvector PostgreSQL for kind verification.

Kubernetes chat tools use the namespaces and workloads configured by `TRACEY_KUBERNETES_ALLOWED_NAMESPACES` and `TRACEY_KUBERNETES_ALLOWED_WORKLOADS`. Each accepts comma-separated names or `*` for the full scope visible to Tracey's Kubernetes identities. A request such as `which pods are active` lists pods across the connected namespace scope without requiring the user to repeat a namespace. Cluster-wide observation excludes Secret contents; mutation remains typed, policy-evaluated, audited, verified, and rollback-aware.

External agents are deployed from their own repositories and export OTLP to Tracey's Collector endpoint. Their namespaces must opt in with the label `tracey.ai/telemetry-export=enabled`; that network path grants telemetry export only. Kubernetes investigation or remediation requires a separate least-privilege identity and explicit allowlists.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:codex
```

Live cohort and external MCP verification require genuine deployed cohorts and an approved MCP server. Evaluation requires 30-50 reviewed production incidents or controlled staging faults covering all seven PRD failure classes; repository fixtures are never returned by runtime APIs.

## Remaining provider integrations

Kubernetes and SigNoz are the implemented production adapters. AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub remain future typed adapters. Each must provide its own least-privilege identity, schemas, policy checks, verification, rollback behavior, and real integration evidence before it is advertised as supported.

For a real deployment, operators still provide their IdP, registry, managed PostgreSQL backup/restore policy, ingress/TLS, external secret manager, capacity/load targets, and provider-specific credentials. Previously shared credentials must be rotated by their owner; Tracey never prints them during setup or verification.
