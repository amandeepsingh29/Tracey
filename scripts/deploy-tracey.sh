#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

: "${TRACEY_API_ENV_FILE:?Set TRACEY_API_ENV_FILE to the API environment file}"
: "${TRACEY_EXECUTOR_ENV_FILE:?Set TRACEY_EXECUTOR_ENV_FILE to the restricted executor environment file}"
: "${DATABASE_URL:?Set DATABASE_URL so all PostgreSQL migrations run before deployment}"
test -f "${TRACEY_API_ENV_FILE}" || { echo "API environment file does not exist: ${TRACEY_API_ENV_FILE}" >&2; exit 1; }
test -f "${TRACEY_EXECUTOR_ENV_FILE}" || { echo "Executor environment file does not exist: ${TRACEY_EXECUTOR_ENV_FILE}" >&2; exit 1; }

api_image="${TRACEY_API_IMAGE:-tracey-api:0.1.0}"
ui_image="${TRACEY_UI_IMAGE:-tracey-ui:0.1.0}"
executor_image="${TRACEY_EXECUTOR_IMAGE:-tracey-executor:0.1.0}"
kind_cluster="${KIND_CLUSTER_NAME:-tracey-test}"

docker build --tag "${api_image}" --file Dockerfile.api .
docker build --tag "${ui_image}" --file Dockerfile.ui .
docker build --tag "${executor_image}" --file Dockerfile.executor .
if kind get clusters | grep --fixed-strings --line-regexp --quiet "${kind_cluster}"; then
  kind load docker-image "${api_image}" --name "${kind_cluster}"
  kind load docker-image "${ui_image}" --name "${kind_cluster}"
  kind load docker-image "${executor_image}" --name "${kind_cluster}"
fi

kubectl create namespace production --dry-run=client --output yaml | kubectl apply --filename -
./scripts/migrate.sh
kubectl create secret generic tracey-api-env --from-env-file="${TRACEY_API_ENV_FILE}" --namespace production --dry-run=client --output yaml | kubectl apply --filename -
kubectl create secret generic tracey-executor-env --from-env-file="${TRACEY_EXECUTOR_ENV_FILE}" --namespace production --dry-run=client --output yaml | kubectl apply --filename -
kubectl apply --filename infra/k8s/base/tracey.yaml
kubectl rollout status deployment/tracey-api --namespace production --timeout=180s
kubectl rollout status deployment/tracey-ui --namespace production --timeout=180s
kubectl rollout status deployment/tracey-executor --namespace production --timeout=180s
