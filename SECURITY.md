# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for this repository:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include the affected component, reproduction steps, potential impact, and any suggested mitigation.

Do not include real credentials, private prompts, user data, Kubernetes Secret values, or production telemetry in the report. Use redacted examples and arrange a secure transfer method if additional evidence is required.

## Scope

Security-sensitive areas include:

- Authentication, OIDC, tenant isolation, and role enforcement
- Connector credential encryption and redaction
- SigNoz query scoping
- Kubernetes investigator and executor permissions
- Policy evaluation, approvals, and break-glass controls
- Action idempotency, verification, and rollback
- MCP authentication and tool allowlists
- OpenRouter-bound data projection
- PostgreSQL row-level security

## Supported versions

Tracey is currently under active development. Security fixes are applied to the latest commit on `main`; no older release line is maintained yet.

## Operational responsibility

Deployers are responsible for their identity provider, ingress and TLS, secret manager, managed PostgreSQL backups, connector identities, Kubernetes RBAC, network policies, and credential rotation.
