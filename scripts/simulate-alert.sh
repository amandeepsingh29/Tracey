#!/usr/bin/env bash
set -euo pipefail

: "${TRACEY_API_BEARER_TOKEN:?Set TRACEY_API_BEARER_TOKEN in the environment}"
TRACEY_API_URL="${TRACEY_API_URL:-http://127.0.0.1:3000}"

session_json="$(curl --fail-with-body --silent --show-error \
  --request POST "${TRACEY_API_URL%/}/v1/investigations" \
  --header "Authorization: Bearer ${TRACEY_API_BEARER_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{"title":"Controlled SRE integration test"}')"
session_id="$(jq --exit-status --raw-output '.sessionId' <<<"${session_json}")"

echo "Started investigation ${session_id}"

curl --fail-with-body --silent --show-error \
  --request POST "${TRACEY_API_URL%/}/v1/investigations/${session_id}/messages" \
  --header "Authorization: Bearer ${TRACEY_API_BEARER_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{
    "content": "Investigate the registered service and its configured Kubernetes workload. Use read-only evidence, explain the likely cause, and prepare a structured remediation recommendation. Do not claim that an action executed unless the policy-controlled action API returns verified execution evidence."
  }' | jq
