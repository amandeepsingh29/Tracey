# OIDC identity

Tracey accepts JWT access tokens from an OpenID Connect provider. The API
validates the token signature against remote JWKS, then enforces the exact
issuer, audience, expiry, configured tenant, and Tracey role.

Required production configuration:

```text
OIDC_ISSUER_URL=https://identity.company.example/realms/operations
OIDC_JWKS_URL=https://identity.company.example/realms/operations/protocol/openid-connect/certs
OIDC_AUDIENCE=tracey-api
OIDC_TENANT_CLAIM=tenant_id
OIDC_ROLES_CLAIM=roles
TRACEY_TENANT_ID=the-fixed-deployment-tenant
```

The roles claim may contain `viewer`, `analyst`, `operator`, or `admin`.
Endpoint authorization is enforced by the API; a valid token from a different
tenant is rejected.

## Live provider verification

The repository includes an automated contract test against the official
Keycloak container:

```bash
pnpm verify:oidc:keycloak
```

It imports a temporary realm and client, obtains real signed access tokens,
loads discovery and JWKS metadata, and checks these behaviors against a
temporary Tracey API:

- viewer access to a read route;
- viewer rejection from an administrator route;
- administrator authorization;
- wrong-tenant rejection.

The container, temporary realm, credentials, API process, and files are removed
after the run. This verifies Tracey's provider contract; production deployments
must still configure their own provider, login session lifecycle, and user
provisioning.
