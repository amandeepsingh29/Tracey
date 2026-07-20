# Authentication and telemetry scope

Tracey uses a fixed deployment scope for the MVP. The server owns one `tracey.tenant.id` and one `deployment.environment.name`; callers cannot provide or override either value.

## HTTP authentication

`/health` remains public so infrastructure can check process readiness. Every `/v1/*` route requires:

```http
Authorization: Bearer <TRACEY_API_BEARER_TOKEN>
```

If the token is not configured, protected routes return `503`. Missing or incorrect credentials return `401`. Token comparison is constant-time after a length check. The token value is never logged or exported.

`TRACEY_API_TOKEN_ID` is a non-secret identifier for key rotation and audit telemetry. Authentication decisions emit `tracey.api.authentication` with only the normalized HTTP route, method, token ID, and the bounded outcome `authorized`, `unauthorized`, or `not_configured`.

The `/mcp` Streamable HTTP endpoint deliberately uses the independent `TRACEY_MCP_BEARER_TOKEN`, allowing MCP access to be rotated or disabled without changing REST clients.

## Fixed tenant and environment scope

Configure:

```dotenv
TRACEY_TENANT_ID=your-opaque-tenant
DEPLOYMENT_ENVIRONMENT=production
```

The application adds these values to its OpenTelemetry resources and root agent spans. The Collector's `resource/scope` processor upserts the same attributes on traces, metrics, and logs from Codex and other agents using that Collector.

Every SigNoz query builder adds both filters:

```text
tracey.tenant.id = '<configured tenant>'
deployment.environment.name = '<configured environment>'
```

This includes root-run search, trace-span lookup, correlated logs, and aggregate metrics. Consequently, possessing a trace ID from another configured scope returns no rows. Query scope is escaped by the adapter and cannot be replaced with a caller-supplied SigNoz expression.

## Deployment boundary

The current model supports one tenant/environment scope per Tracey deployment and Collector. It is appropriate for a single-team production deployment while IdP-backed user authorization and a tenant credential registry are completed; it does not pretend that user-level RBAC already exists.

TODO: Add identity-provider authentication, per-user authorization, and a tenant-to-SigNoz-credential registry before offering a shared multi-tenant service. Those features require an actual identity provider and tenant store; static claims or fake login screens would not provide isolation.

TODO: Run a live two-scope isolation test against the selected SigNoz deployment. Pure query-contract and HTTP authentication tests pass locally, but no external tenant data or credentials are configured in this workspace.
