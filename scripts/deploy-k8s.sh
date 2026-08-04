#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

profile="${TRACEY_DEPLOYMENT_PROFILE:-production}"
case "${profile}" in
  local) namespace=production ;;
  staging) namespace=tracey-staging ;;
  production) namespace=production ;;
  *) echo "TRACEY_DEPLOYMENT_PROFILE must be local, staging, or production" >&2; exit 1 ;;
esac

: "${TRACEY_API_ENV_FILE:?Set TRACEY_API_ENV_FILE}"
: "${TRACEY_EXECUTOR_ENV_FILE:?Set TRACEY_EXECUTOR_ENV_FILE}"
: "${SIGNOZ_OTLP_ENDPOINT:?Set SIGNOZ_OTLP_ENDPOINT}"
: "${SIGNOZ_INGESTION_KEY:?Set SIGNOZ_INGESTION_KEY}"
: "${TRACEY_TENANT_ID:?Set TRACEY_TENANT_ID}"
: "${DEPLOYMENT_ENVIRONMENT:?Set DEPLOYMENT_ENVIRONMENT}"

if [[ "${profile}" != local ]]; then
  : "${TRACEY_UI_ENV_FILE:?Set TRACEY_UI_ENV_FILE for per-user OIDC web sessions}"
fi

for env_file in "${TRACEY_API_ENV_FILE}" "${TRACEY_EXECUTOR_ENV_FILE}" ${TRACEY_UI_ENV_FILE:+"${TRACEY_UI_ENV_FILE}"}; do
  test -f "${env_file}" || { echo "Environment file does not exist: ${env_file}" >&2; exit 1; }
done

if [[ "${profile}" != local ]]; then
  grep -q '^TRACEY_WEB_AUTH_MODE=oidc$' "${TRACEY_UI_ENV_FILE}" || {
    echo "TRACEY_UI_ENV_FILE must set TRACEY_WEB_AUTH_MODE=oidc for staging and production" >&2
    exit 1
  }
  grep -q '^TRACEY_WEB_OIDC_CLIENT_ID=.' "${TRACEY_UI_ENV_FILE}" || {
    echo "TRACEY_UI_ENV_FILE must set TRACEY_WEB_OIDC_CLIENT_ID" >&2
    exit 1
  }
  grep -Eq '^TRACEY_WEB_SESSION_SECRET=.{32,}$' "${TRACEY_UI_ENV_FILE}" || {
    echo "TRACEY_UI_ENV_FILE must set TRACEY_WEB_SESSION_SECRET with at least 32 characters" >&2
    exit 1
  }
fi

kubectl create namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -

if [[ "${profile}" == local ]]; then
  : "${TRACEY_LOCAL_POSTGRES_PASSWORD:?Set TRACEY_LOCAL_POSTGRES_PASSWORD for the local overlay}"
  kubectl create secret generic tracey-local-postgres \
    --from-literal=password="${TRACEY_LOCAL_POSTGRES_PASSWORD}" \
    --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -
  kubectl apply --filename infra/k8s/overlays/local/postgres.yaml
  kubectl rollout status statefulset/tracey-postgres --namespace "${namespace}" --timeout=180s
  local_port="${TRACEY_LOCAL_POSTGRES_PORT:-55432}"
  kubectl port-forward --namespace "${namespace}" service/tracey-postgres "${local_port}:5432" >/tmp/tracey-postgres-port-forward.log 2>&1 &
  migration_port_forward_pid=$!
  trap 'kill "${migration_port_forward_pid}" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    PGPASSWORD="${TRACEY_LOCAL_POSTGRES_PASSWORD}" pg_isready --quiet --host 127.0.0.1 --port "${local_port}" --username tracey --dbname tracey && break
    sleep 1
  done
  PGPASSWORD="${TRACEY_LOCAL_POSTGRES_PASSWORD}" pg_isready --quiet --host 127.0.0.1 --port "${local_port}" --username tracey --dbname tracey || {
    echo "Local PostgreSQL port-forward did not become ready" >&2
    exit 1
  }
  PGPASSWORD="${TRACEY_LOCAL_POSTGRES_PASSWORD}" \
    DATABASE_URL="postgresql://tracey@127.0.0.1:${local_port}/tracey" ./scripts/migrate.sh
  kill "${migration_port_forward_pid}" 2>/dev/null || true
  wait "${migration_port_forward_pid}" 2>/dev/null || true
  trap - EXIT
else
  : "${DATABASE_URL:?Set DATABASE_URL so all migrations can run before deployment}"
  ./scripts/migrate.sh
fi

kubectl create secret generic tracey-api-env --from-env-file="${TRACEY_API_ENV_FILE}" --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -
kubectl create secret generic tracey-executor-env --from-env-file="${TRACEY_EXECUTOR_ENV_FILE}" --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -
if [[ -n "${TRACEY_UI_ENV_FILE:-}" ]]; then
  kubectl create secret generic tracey-ui-env \
    --from-env-file="${TRACEY_UI_ENV_FILE}" \
    --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -
else
  ui_access_token="$(awk -F= '$1 == "TRACEY_UI_ACCESS_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "${TRACEY_API_ENV_FILE}")"
  if [[ -z "${ui_access_token}" ]]; then
    ui_access_token="$(awk -F= '$1 == "TRACEY_API_BEARER_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "${TRACEY_API_ENV_FILE}")"
  fi
  [[ -n "${ui_access_token}" ]] || { echo "Local profile requires TRACEY_UI_ACCESS_TOKEN or TRACEY_API_BEARER_TOKEN" >&2; exit 1; }
  kubectl create secret generic tracey-ui-env \
    --from-literal=TRACEY_WEB_AUTH_MODE=local \
    --from-literal=TRACEY_UI_ACCESS_TOKEN="${ui_access_token}" \
    --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -
fi
kubectl create secret generic signoz-secret \
  --from-literal=SIGNOZ_OTLP_ENDPOINT="${SIGNOZ_OTLP_ENDPOINT}" \
  --from-literal=SIGNOZ_INGESTION_KEY="${SIGNOZ_INGESTION_KEY}" \
  --from-literal=TRACEY_TENANT_ID="${TRACEY_TENANT_ID}" \
  --from-literal=DEPLOYMENT_ENVIRONMENT="${DEPLOYMENT_ENVIRONMENT}" \
  --namespace "${namespace}" --dry-run=client --output yaml | kubectl apply --filename -

kubectl apply --kustomize "infra/k8s/overlays/${profile}"
for deployment in tracey-api tracey-executor tracey-worker tracey-ui otel-collector; do
  kubectl rollout status "deployment/${deployment}" --namespace "${namespace}" --timeout=180s
done
