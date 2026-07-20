#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD; do not use a repository default}"
: "${TRACEY_API_ENV_FILE:?Set TRACEY_API_ENV_FILE to the Tracey API environment file}"
: "${TRACEY_EXECUTOR_ENV_FILE:?Set TRACEY_EXECUTOR_ENV_FILE to the Tracey executor environment file}"

kind_version="${KIND_VERSION:-v0.29.0}"
helm_version="${HELM_VERSION:-v3.18.4}"
cluster_name="${KIND_CLUSTER_NAME:-tracey-test}"

if ! command -v kind >/dev/null; then
  curl --fail --location --silent --show-error --output /tmp/kind "https://kind.sigs.k8s.io/dl/${kind_version}/kind-linux-amd64"
  chmod +x /tmp/kind
  sudo install /tmp/kind /usr/local/bin/kind
fi
if ! command -v helm >/dev/null; then
  curl --fail --location --silent --show-error "https://get.helm.sh/helm-${helm_version}-linux-amd64.tar.gz" --output /tmp/helm.tar.gz
  tar --extract --gzip --file /tmp/helm.tar.gz --directory /tmp
  sudo install /tmp/linux-amd64/helm /usr/local/bin/helm
fi

kind get clusters | grep --fixed-strings --line-regexp --quiet "${cluster_name}" || kind create cluster --name "${cluster_name}"
kubectl create namespace production --dry-run=client --output yaml | kubectl apply --filename -

export DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5432/postgres?sslmode=disable"
docker compose --file infra/postgres/compose.yaml up --detach
until pg_isready --dbname "${DATABASE_URL}"; do sleep 1; done
bash scripts/migrate.sh

set -a
# shellcheck disable=SC1090
source "${TRACEY_API_ENV_FILE}"
set +a
bash scripts/deploy-otel.sh
bash scripts/deploy-tracey.sh

echo "Deployment complete. Run port-forwards explicitly when needed:"
echo "kubectl port-forward -n production svc/tracey-ui-service 8501:8501"
