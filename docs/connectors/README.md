# Connector framework

Connectors are bounded adapters between Tracey and independently owned systems. The typed registry lives in `packages/connectors`; authenticated `GET /v1/connectors` and the UI expose the same catalog and configuration-derived state.

| Connector | Responsibility | Implementation boundary |
| --- | --- | --- |
| SigNoz | Query traces, logs, metrics, and recovery evidence | `@tracey/signoz-adapter`; raw telemetry remains in SigNoz |
| Kubernetes | Read workload evidence and execute approved typed mutations | `@tracey/cloud-adapter` plus the separately authenticated executor |
| Codex | Normalize native Codex OTel conversation events | Producer profile over the SigNoz connector |
| Claude Code | Normalize native Claude Code trace hierarchies | Producer profile over the SigNoz connector |
| Generic OpenTelemetry | Accept the framework-neutral `agent.run` contract | External SDK instrumentation and Collector ingestion |
| MCP | Expose Tracey read tools and observe allowlisted external read tools | Authenticated Streamable HTTP/stdio server and bounded client |

A connector descriptor declares its ID, category, capabilities, required configuration keys, documentation, and current state. States are `ready`, `needs_configuration`, or `disabled`. A descriptor never means Tracey owns the connected system.

## Adding a connector

1. Add a typed descriptor to `@tracey/connectors`.
2. Implement bounded read schemas and, if applicable, separate typed mutation schemas.
3. Add least-privilege credentials and deterministic policy checks outside the model tool loop.
4. Add redaction, timeout, tenant-isolation, verification, and recovery tests.
5. Provide genuine integration evidence before reporting the connector as ready.

Agent source code and deployment manifests stay in the agent's repository. Telemetry onboarding and mutation access are deliberately separate configuration steps.
