#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sourceDir = resolve(".");
const cleanDir = mkdtempSync(join(tmpdir(), "tracey-clean-install-"));
const runtimeId = `tracey-clean-${process.pid}`;
const apiPort = 13_100;
const workerPort = 13_101;
const webPort = 18_501;
const postgresPort = 15_432;
const password = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex");
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? cleanDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function copyRepositoryFiles() {
  const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: sourceDir });
  const files = listed.split("\0").filter(Boolean);
  for (const relativePath of files) {
    const source = join(sourceDir, relativePath);
    const destination = join(cleanDir, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return files;
}

async function waitFor(url, expectedStatus = 200) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === expectedStatus) return response;
    } catch {
      // The clean runtime may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${url} did not return HTTP ${expectedStatus}`);
}

function cleanup() {
  if (started) {
    spawnSync("pnpm", ["tracey:down"], { cwd: cleanDir, stdio: "inherit", env: process.env });
  }
  spawnSync("docker", [
    "compose", "--env-file", ".env", "-p", `${runtimeId}-postgres`,
    "-f", "infra/postgres/compose.yaml", "down", "--volumes", "--remove-orphans",
  ], {
    cwd: cleanDir,
    stdio: "ignore",
    env: {
      ...process.env,
      TRACEY_POSTGRES_USER: "tracey_clean",
      TRACEY_POSTGRES_DB: "tracey_clean",
      TRACEY_POSTGRES_PORT: String(postgresPort),
      POSTGRES_PASSWORD: password,
    },
  });
  rmSync(cleanDir, { recursive: true, force: true });
}

try {
  const files = copyRepositoryFiles();
  for (const forbidden of [".env", ".tracey/runtime.json", "node_modules/.modules.yaml"]) {
    if (files.includes(forbidden)) throw new Error(`Clean source unexpectedly contains ${forbidden}`);
  }
  writeFileSync(join(cleanDir, ".env"), [
    `PORT=${apiPort}`,
    `WORKER_HEALTH_PORT=${workerPort}`,
    `TRACEY_WEB_PORT=${webPort}`,
    `TRACEY_RUNTIME_ID=${runtimeId}`,
    "LOG_LEVEL=warn",
    "DEPLOYMENT_ENVIRONMENT=clean-install",
    "TRACEY_TENANT_ID=clean-install",
    `TRACEY_API_BEARER_TOKEN=${token}`,
    `TRACEY_UI_ACCESS_TOKEN=${token}`,
    `DATABASE_URL=postgresql://tracey_clean:${password}@127.0.0.1:${postgresPort}/tracey_clean`,
    "POSTGRES_POOL_MAX=5",
    "POSTGRES_IDLE_TIMEOUT_MS=30000",
    "POSTGRES_STATEMENT_TIMEOUT_MS=5000",
    "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318",
    "TRACEY_KUBERNETES_EXECUTOR_ENABLED=false",
    "TRACEY_KUBERNETES_INVESTIGATOR_ENABLED=false",
    `TRACEY_API_URL=http://127.0.0.1:${apiPort}`,
    "",
  ].join("\n"), { mode: 0o600 });

  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { inherit: true });
  run("pnpm", ["tracey:up"], { inherit: true });
  started = true;

  await waitFor(`http://127.0.0.1:${apiPort}/health`);
  await waitFor(`http://127.0.0.1:${webPort}/healthz`);
  await waitFor(`http://127.0.0.1:${apiPort}/v1/connectors`, 401);
  const authenticated = await fetch(`http://127.0.0.1:${apiPort}/v1/connectors`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!authenticated.ok) throw new Error(`Authenticated clean API check returned HTTP ${authenticated.status}`);
  const connectors = await authenticated.json();
  if (!Array.isArray(connectors.connectors) || connectors.connectors.length === 0) {
    throw new Error("Clean API did not return the connector catalog");
  }

  const migrationCount = Number(run("psql", [
    `postgresql://tracey_clean:${password}@127.0.0.1:${postgresPort}/tracey_clean`,
    "--tuples-only",
    "--no-align",
    "--command",
    "SELECT count(*) FROM tracey.schema_migrations",
  ]));
  const expectedMigrations = Number(run("bash", ["-lc", "find infra/postgres/migrations -name '*.sql' | wc -l"]));
  if (migrationCount !== expectedMigrations) {
    throw new Error(`Clean database applied ${migrationCount}/${expectedMigrations} migrations`);
  }

  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    copiedSourceFiles: files.length,
    dependencyInstall: "frozen-lockfile",
    repositoryStateReused: false,
    migrationsApplied: migrationCount,
    apiHealthy: true,
    webHealthy: true,
    unauthenticatedApiRejected: true,
    authenticatedConnectorCatalog: true,
    runtimeId,
  };
  mkdirSync(join(sourceDir, ".tracey", "reports"), { recursive: true });
  writeFileSync(join(sourceDir, ".tracey", "reports", "clean-install.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  cleanup();
}
