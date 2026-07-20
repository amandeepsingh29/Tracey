#!/usr/bin/env bash
set -euo pipefail

echo "Setting up local kind cluster..."
if ! command -v kind &> /dev/null; then
    echo "kind is not installed. Please install it using: brew install kind"
    exit 1
fi

if ! kind get clusters | grep --fixed-strings --line-regexp --quiet tracey-test; then
    kind create cluster --name tracey-test
fi

echo "Local cluster is ready. Deploy the complete product with:"
echo "TRACEY_DEPLOYMENT_PROFILE=local ./scripts/deploy-k8s.sh"
