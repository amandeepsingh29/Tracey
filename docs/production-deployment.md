# Production deployment

Tracey publishes five multi-architecture images from version tags:

- `ghcr.io/amandeepsingh29/tracey-api`
- `ghcr.io/amandeepsingh29/tracey-ui`
- `ghcr.io/amandeepsingh29/tracey-worker`
- `ghcr.io/amandeepsingh29/tracey-executor`
- `ghcr.io/amandeepsingh29/tracey-migrations`

The release workflow attaches provenance and an SBOM, then signs each immutable
digest with GitHub's OIDC identity. A release tag must match the image tag in
`infra/k8s/overlays/production/kustomization.yaml`.

## Before rollout

1. Provision PostgreSQL outside the cluster and enable encrypted connections,
   automated backups, point-in-time recovery, and deletion protection.
2. Create the API and executor environment files outside the repository. Use a
   migration-capable database identity only for the migration image and the
   non-superuser application identity for runtime services.
3. Configure an ingress controller, a real DNS name, and a trusted TLS
   certificate for `tracey-ui-service`. Do not expose the executor service.
4. Set an OIDC issuer, audience, and fixed tenant claim in the API environment.
5. Pin the production overlay to the release tag and verify the signed image
   digests before deployment.

## Migrate and deploy

Run the migration image as a one-time job with `DATABASE_URL` supplied from the
deployment secret. Migrations are checksum protected and safe to retry. Take a
database backup before schema changes, and retain the previous application image
digests until the release is verified.

Use `scripts/deploy-k8s.sh` to create runtime secrets, apply the chosen overlay,
and wait for every rollout. The script deliberately requires all configuration
instead of supplying production defaults.

## Verification

Static verification is safe to run before registry or cluster access:

```bash
pnpm verify:production
```

Live verification requires the real public URL and the target Kubernetes
context:

```bash
TRACEY_PRODUCTION_URL=https://tracey.company.example \
TRACEY_PRODUCTION_NAMESPACE=production \
pnpm verify:production
```

The live gate validates the public TLS connection and health endpoint, observes
the latest Deployment generations, and requires every replica to be ready with
zero unavailable replicas. It also rejects live workloads using `latest` or
another unversioned image reference.

For a reproducible pre-production proof, build the four application images and
run the complete stack in the dedicated `tracey-test` kind cluster:

```bash
pnpm verify:production:kind
```

This command creates an isolated `production` namespace, applies all migrations,
provisions a non-superuser RLS-enforced application role, deploys every runtime
component with two replicas, and validates the UI through a temporary
CA-validated HTTPS endpoint. It removes the namespace and Tracey-owned cluster
roles afterward. This proves the deployment contract on Kubernetes; it does not
replace verification of a real public DNS name, ingress controller, managed
database, or cloud load balancer.

Static or kind success is not a public production deployment claim. The live
gate must also pass against the target environment.

## Rollback

If application verification fails, roll each Deployment back to its previously
recorded signed digest. Database rollback is not automatic: restore the
pre-release backup only when the migration's documented compatibility boundary
requires it. Follow `docs/backup-and-restore.md` and perform the restore into a
separate database before replacing the active database.
