#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

if [[ -n "${TRACEY_APPLICATION_DB_ROLE:-}" ]]; then
  [[ "${TRACEY_APPLICATION_DB_ROLE}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || {
    echo "TRACEY_APPLICATION_DB_ROLE is not a valid PostgreSQL role name" >&2
    exit 1
  }
  export PGOPTIONS="${PGOPTIONS:-} -c tracey.application_role=${TRACEY_APPLICATION_DB_ROLE}"
fi

psql "${DATABASE_URL}" --set ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS tracey;
CREATE TABLE IF NOT EXISTS tracey.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

baseline="${1:-}"
for migration in infra/postgres/migrations/*.sql; do
  filename="$(basename "${migration}")"
  if command -v shasum >/dev/null 2>&1; then
    checksum="$(shasum -a 256 "${migration}" | awk '{print $1}')"
  else
    checksum="$(sha256sum "${migration}" | awk '{print $1}')"
  fi
  [[ "${filename}" =~ ^[0-9A-Za-z_.-]+$ && "${checksum}" =~ ^[0-9a-f]{64}$ ]] || { echo "Unsafe migration metadata" >&2; exit 1; }
  applied_checksum="$(psql "${DATABASE_URL}" --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "SELECT checksum FROM tracey.schema_migrations WHERE filename='${filename}'")"
  if [[ -n "${applied_checksum}" ]]; then
    [[ "${applied_checksum}" == "${checksum}" ]] || {
      echo "Migration checksum changed after application: ${filename}" >&2
      exit 1
    }
    echo "Already applied: ${filename}"
    continue
  fi
  if [[ "${baseline}" != "--baseline-existing" ]]; then
    echo "Applying: ${filename}"
    psql "${DATABASE_URL}" --set ON_ERROR_STOP=1 --file "${migration}"
  else
    echo "Baselining existing schema: ${filename}"
  fi
  psql "${DATABASE_URL}" --set ON_ERROR_STOP=1 \
    --command "INSERT INTO tracey.schema_migrations(filename,checksum) VALUES ('${filename}','${checksum}')"
done
