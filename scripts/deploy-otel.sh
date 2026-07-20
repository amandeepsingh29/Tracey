#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

: "${SIGNOZ_OTLP_ENDPOINT:?Set SIGNOZ_OTLP_ENDPOINT}"
: "${SIGNOZ_INGESTION_KEY:?Set SIGNOZ_INGESTION_KEY}"
: "${TRACEY_TENANT_ID:?Set TRACEY_TENANT_ID}"
: "${DEPLOYMENT_ENVIRONMENT:?Set DEPLOYMENT_ENVIRONMENT}"

kubectl create namespace production --dry-run=client --output yaml | kubectl apply --filename -
kubectl create secret generic signoz-secret \
  --from-literal=SIGNOZ_OTLP_ENDPOINT="${SIGNOZ_OTLP_ENDPOINT}" \
  --from-literal=SIGNOZ_INGESTION_KEY="${SIGNOZ_INGESTION_KEY}" \
  --from-literal=TRACEY_TENANT_ID="${TRACEY_TENANT_ID}" \
  --from-literal=DEPLOYMENT_ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT}" \
  --namespace production --dry-run=client --output yaml | kubectl apply --filename -

kubectl apply --filename infra/k8s/base/otel-collector.yaml
kubectl rollout status deployment/otel-collector --namespace production --timeout=180s
