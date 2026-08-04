#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"

valid_name() {
  [[ "$1" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] && [[ "${#1}" -le 63 ]]
}

usage() {
  echo "Usage:"
  echo "  $0 namespace <target-namespace> [tracey-namespace]"
  echo "  $0 privileged [tracey-namespace] [executor-image]"
}

case "$mode" in
  namespace)
    target_namespace="${2:-}"
    tracey_namespace="${3:-production}"
    if ! valid_name "$target_namespace" || ! valid_name "$tracey_namespace"; then
      echo "Target and Tracey namespaces must be valid Kubernetes DNS labels." >&2
      exit 2
    fi
    sed \
      -e "s/__TARGET_NAMESPACE__/${target_namespace}/g" \
      -e "s/__TRACEY_NAMESPACE__/${tracey_namespace}/g" \
      "${repo_dir}/infra/k8s/connectors/kubernetes/namespaced-executor-rbac.yaml" \
      | kubectl apply --filename -
    ;;
  privileged)
    tracey_namespace="${2:-production}"
    executor_image="${3:-tracey-executor:0.1.0}"
    if ! valid_name "$tracey_namespace"; then
      echo "Tracey namespace must be a valid Kubernetes DNS label." >&2
      exit 2
    fi
    if [[ ! "$executor_image" =~ ^[A-Za-z0-9._/:@-]+$ ]]; then
      echo "Executor image contains unsupported characters." >&2
      exit 2
    fi
    sed \
      -e "s/__TRACEY_NAMESPACE__/${tracey_namespace}/g" \
      -e "s|__EXECUTOR_IMAGE__|${executor_image}|g" \
      "${repo_dir}/infra/k8s/connectors/kubernetes/privileged-executor.yaml" \
      | kubectl apply --filename -
    echo "Privileged executor endpoint: http://tracey-privileged-executor-service.${tracey_namespace}.svc:3002"
    echo "Point TRACEY_EXECUTOR_URL at that endpoint only after reviewing the generated ClusterRole."
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
