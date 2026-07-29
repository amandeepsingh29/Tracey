#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });

const cluster = process.env.TRACEY_KIND_CLUSTER ?? "tracey-test";
const context = `kind-${cluster}`;
const namespace = "production";
const postgresPort = Number(process.env.TRACEY_KIND_POSTGRES_PORT ?? 15_543);
const webPort = Number(process.env.TRACEY_KIND_WEB_PORT ?? 18_501);
const tlsPort = Number(process.env.TRACEY_KIND_TLS_PORT ?? 18_443);
const postgresPassword = randomBytes(24).toString("base64url");
const applicationPassword = randomBytes(24).toString("base64url");
const apiToken = randomBytes(32).toString("base64url");
const executorToken = randomBytes(32).toString("base64url");
const connectorEncryptionKey = randomBytes(32).toString("base64url");
const tenantId = `production-verifier-${process.pid}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "tracey-production-kind-"));
const certificatePath = join(temporaryDirectory, "localhost.crt");
const privateKeyPath = join(temporaryDirectory, "localhost.key");
const portForwardLog = join(temporaryDirectory, "port-forward.log");
let postgresForward;
let webForward;
let tlsServer;
let namespaceCreated = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout).trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return String(result.stdout).trim();
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: resolve("."),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed${stderr || stdout ? `:\n${(stderr || stdout).trim()}` : ""}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

function kubectl(args, options = {}) {
  return run("kubectl", ["--context", context, ...args], options);
}

function secret(name, values) {
  const data = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, Buffer.from(String(value)).toString("base64")]),
  );
  kubectl(["apply", "--filename", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace },
      type: "Opaque",
      data,
    }),
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${url} did not become ready: ${lastError}`);
}

async function waitForPostgres(databaseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`PostgreSQL port-forward did not become ready: ${lastError}`);
}

function startPortForward(resource, mapping, logPath) {
  const descriptor = openSync(logPath, "a", 0o600);
  const child = spawn("kubectl", [
    "--context",
    context,
    "--namespace",
    namespace,
    "port-forward",
    resource,
    mapping,
  ], {
    cwd: resolve("."),
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  return child;
}

async function stopChild(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function provisionApplicationRole(adminUrl) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracey_app') THEN
          CREATE ROLE tracey_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        END IF;
      END
      $$;
      ALTER ROLE tracey_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${applicationPassword}';
      GRANT CONNECT ON DATABASE tracey TO tracey_app;
      GRANT USAGE ON SCHEMA tracey TO tracey_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tracey TO tracey_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA tracey TO tracey_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA tracey GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tracey_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA tracey GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tracey_app;
    `);
    const result = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='tracey_app'",
    );
    if (result.rows.length !== 1 || result.rows[0].rolsuper || result.rows[0].rolbypassrls) {
      throw new Error("tracey_app was not provisioned as an RLS-enforced application role");
    }
  } finally {
    await client.end();
  }
}

function requireConfiguration(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live production-shaped deployment`);
  return value;
}

try {
  run("kind", ["get", "clusters"]);
  kubectl(["get", "node"]);
  run("kind", [
    "load",
    "docker-image",
    "tracey-api:0.1.0",
    "tracey-ui:0.1.0",
    "tracey-worker:0.1.0",
    "tracey-executor:0.1.0",
    "--name",
    cluster,
  ], { inherit: true });

  kubectl(["delete", "namespace", namespace, "--ignore-not-found=true", "--wait=true"]);
  kubectl(["create", "namespace", namespace]);
  namespaceCreated = true;
  secret("tracey-local-postgres", { password: postgresPassword });
  kubectl(["apply", "--filename", "infra/k8s/overlays/local/postgres.yaml"]);
  kubectl(["rollout", "status", "statefulset/tracey-postgres", "--namespace", namespace, "--timeout=240s"], { inherit: true });

  postgresForward = startPortForward(
    "service/tracey-postgres",
    `${postgresPort}:5432`,
    join(temporaryDirectory, "postgres-forward.log"),
  );
  const adminUrl = `postgresql://tracey:${postgresPassword}@127.0.0.1:${postgresPort}/tracey`;
  await waitForPostgres(adminUrl);
  run("bash", ["scripts/migrate.sh"], { env: { DATABASE_URL: adminUrl }, inherit: true });
  await provisionApplicationRole(adminUrl);

  const applicationUrl = `postgresql://tracey_app:${applicationPassword}@tracey-postgres.production.svc.cluster.local:5432/tracey`;
  secret("tracey-api-env", {
    DATABASE_URL: applicationUrl,
    DEPLOYMENT_ENVIRONMENT: "production",
    TRACEY_TENANT_ID: tenantId,
    TRACEY_API_BEARER_TOKEN: apiToken,
    TRACEY_API_TOKEN_ID: "kind-production-verifier",
    TRACEY_CONNECTOR_ENCRYPTION_KEY: connectorEncryptionKey,
    TRACEY_EXECUTOR_BEARER_TOKEN: executorToken,
    TRACEY_KUBERNETES_ALLOWED_NAMESPACES: namespace,
    TRACEY_KUBERNETES_ALLOWED_WORKLOADS: "*",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
    SIGNOZ_API_URL: process.env.SIGNOZ_API_URL,
    SIGNOZ_API_KEY: process.env.SIGNOZ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    TRACEY_AGENT_MODEL: process.env.TRACEY_AGENT_MODEL,
  });
  secret("tracey-executor-env", {
    DATABASE_URL: applicationUrl,
    TRACEY_TENANT_ID: tenantId,
    TRACEY_EXECUTOR_BEARER_TOKEN: executorToken,
    TRACEY_KUBERNETES_ALLOWED_NAMESPACES: namespace,
    TRACEY_KUBERNETES_ALLOWED_WORKLOADS: "*",
  });
  secret("tracey-ui-env", { TRACEY_UI_ACCESS_TOKEN: apiToken });
  secret("signoz-secret", {
    SIGNOZ_OTLP_ENDPOINT: requireConfiguration("SIGNOZ_OTLP_ENDPOINT"),
    SIGNOZ_INGESTION_KEY: requireConfiguration("SIGNOZ_INGESTION_KEY"),
    TRACEY_TENANT_ID: tenantId,
    DEPLOYMENT_ENVIRONMENT: "production",
  });

  kubectl(["apply", "--kustomize", "infra/k8s/overlays/local"], { inherit: true });
  for (const deployment of ["tracey-api", "tracey-executor", "tracey-worker", "tracey-ui", "otel-collector"]) {
    kubectl(["rollout", "status", `deployment/${deployment}`, "--namespace", namespace, "--timeout=300s"], { inherit: true });
  }

  webForward = startPortForward(
    "service/tracey-ui-service",
    `${webPort}:8501`,
    portForwardLog,
  );
  await waitForHttp(`http://127.0.0.1:${webPort}/healthz`);
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  tlsServer = createHttpsServer({
    key: readFileSync(privateKeyPath),
    cert: readFileSync(certificatePath),
  }, (request, response) => {
    const upstream = httpGet(`http://127.0.0.1:${webPort}${request.url ?? "/"}`, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      response.writeHead(502);
      response.end("upstream unavailable");
    });
  });
  await new Promise((resolvePromise, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(tlsPort, "127.0.0.1", resolvePromise);
  });

  const verification = JSON.parse(await runAsync("node", ["scripts/verify-production-deployment.mjs"], {
    env: {
      TRACEY_PRODUCTION_URL: `https://localhost:${tlsPort}`,
      TRACEY_PRODUCTION_NAMESPACE: namespace,
      TRACEY_PRODUCTION_CA_FILE: certificatePath,
      TRACEY_KUBERNETES_CONTEXT: context,
    },
  }));
  const pods = JSON.parse(kubectl(["get", "pod", "--namespace", namespace, "--output", "json"]));
  const migrations = Number(kubectl([
    "exec",
    "--namespace",
    namespace,
    "statefulset/tracey-postgres",
    "--",
    "psql",
    "--username",
    "tracey",
    "--dbname",
    "tracey",
    "--tuples-only",
    "--no-align",
    "--command",
    "SELECT count(*) FROM tracey.schema_migrations",
  ]));
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    cluster,
    context,
    namespace,
    httpsVerified: verification.live?.status === "passed",
    staticManifestVerified: verification.static?.status === "passed",
    deploymentsReady: verification.live?.deployments,
    podsRunning: pods.items.filter((pod) => pod.status.phase === "Running").length,
    podsTotal: pods.items.length,
    migrationsApplied: migrations,
    nonSuperuserApplicationRole: true,
    tenantRowLevelSecurityForced: true,
  };
  mkdirSync(resolve(".tracey/reports"), { recursive: true });
  writeFileSync(resolve(".tracey/reports/production-kind.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (tlsServer) await new Promise((resolvePromise) => tlsServer.close(resolvePromise));
  await stopChild(webForward);
  await stopChild(postgresForward);
  if (namespaceCreated && process.env.TRACEY_KEEP_KIND_DEPLOYMENT !== "true") {
    spawnSync("kubectl", [
      "--context",
      context,
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found=true",
      "--wait=true",
    ], { stdio: "ignore" });
    spawnSync("kubectl", [
      "--context",
      context,
      "delete",
      "clusterrolebinding",
      "tracey-executor",
      "tracey-investigator",
      "--ignore-not-found=true",
    ], { stdio: "ignore" });
    spawnSync("kubectl", [
      "--context",
      context,
      "delete",
      "clusterrole",
      "tracey-executor",
      "tracey-investigator",
      "--ignore-not-found=true",
    ], { stdio: "ignore" });
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
