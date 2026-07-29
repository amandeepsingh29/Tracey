#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import dotenv from "dotenv";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(repoDir, ".tracey");
const logDir = join(runtimeDir, "logs");
const statePath = join(runtimeDir, "runtime.json");
const envPath = join(repoDir, ".env");
const postgresCompose = ["compose", "--env-file", ".env", "-p", "tracey-postgres", "-f", "infra/postgres/compose.yaml"];
const collectorCompose = ["compose", "--env-file", ".env", "-p", "tracey-otel", "-f", "infra/otel/compose.yaml"];
const serviceSpecs = {
  api: { packageName: "@tracey/api", portKey: "PORT", defaultPort: 3000, healthPath: "/health" },
  worker: { packageName: "@tracey/worker", portKey: "WORKER_HEALTH_PORT", defaultPort: 3001, healthPath: "/" },
  executor: { packageName: "@tracey/executor", portKey: "EXECUTOR_PORT", defaultPort: 3002, healthPath: "/health" },
  web: { packageName: "@tracey/web", defaultPort: 8501, healthPath: "/healthz" },
};

export function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid port: ${value}`);
  return parsed;
}

export function localDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
}

export function localPostgresEnvironment(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!user || !password || !database) {
    throw new Error("A local DATABASE_URL must include its PostgreSQL user, password, and database name.");
  }
  return { TRACEY_POSTGRES_USER: user, TRACEY_POSTGRES_DB: database, POSTGRES_PASSWORD: password };
}

export function executorConfigured(environment) {
  return environment.TRACEY_KUBERNETES_EXECUTOR_ENABLED === "true"
    && (environment.TRACEY_EXECUTOR_BEARER_TOKEN?.trim().length ?? 0) >= 32
    && Boolean(environment.TRACEY_KUBERNETES_ALLOWED_NAMESPACES?.trim())
    && Boolean(environment.TRACEY_KUBERNETES_ALLOWED_WORKLOADS?.trim());
}

function loadEnvironment() {
  if (!existsSync(envPath)) throw new Error("Missing .env. Copy .env.example to .env and configure the required values.");
  const fileValues = dotenv.parse(readFileSync(envPath));
  return { ...fileValues, ...process.env };
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    env: options.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function commandAvailable(command) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function readState() {
  if (!existsSync(statePath)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error(`${statePath} is invalid. Remove it only after confirming no Tracey processes are running.`);
  }
}

function writeState(state) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function pidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processOwned(service) {
  if (!pidRunning(service.pid)) return false;
  const result = spawnSync("ps", ["-p", String(service.pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && String(result.stdout).includes(service.packageName);
}

async function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(350);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function assertPortsFree(ports) {
  const conflicts = [];
  for (const { name, port } of ports) if (await portOpen(port)) conflicts.push(`${name} (${port})`);
  if (conflicts.length > 0) throw new Error(`Required ports are already in use: ${conflicts.join(", ")}. Stop the owning services or change the matching .env ports.`);
}

async function waitForHttp(url, timeoutMs = 30_000, acceptAnyResponse = false) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      lastStatus = response.status;
      if (response.ok || acceptAnyResponse) return { ok: response.ok, status: response.status };
    } catch {
      // The process can be alive before its listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs / 1_000}s${lastStatus ? ` (last HTTP ${lastStatus})` : ""}`);
}

function compose(environment, args, inherit = false) {
  return run("docker", args, { env: environment, inherit });
}

async function waitForPostgres(environment) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", [...postgresCompose, "exec", "-T", "postgres", "pg_isready", "-U", environment.TRACEY_POSTGRES_USER, "-d", environment.TRACEY_POSTGRES_DB], {
      cwd: repoDir, env: environment, stdio: "ignore",
    });
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Tracey PostgreSQL did not become healthy within 45s");
}

function startService(name, environment, port) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${name}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn("pnpm", ["--filter", serviceSpecs[name].packageName, "start"], {
    cwd: repoDir,
    env: environment,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return {
    name,
    pid: child.pid,
    port,
    packageName: serviceSpecs[name].packageName,
    healthUrl: `http://127.0.0.1:${port}${serviceSpecs[name].healthPath}`,
    logPath,
  };
}

async function terminateService(service) {
  if (!processOwned(service)) return { stopped: false, reason: pidRunning(service.pid) ? "pid is not owned by Tracey" : "not running" };
  try {
    process.kill(-service.pid, "SIGTERM");
  } catch {
    process.kill(service.pid, "SIGTERM");
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && pidRunning(service.pid)) await new Promise((resolve) => setTimeout(resolve, 200));
  if (pidRunning(service.pid) && processOwned(service)) {
    try {
      process.kill(-service.pid, "SIGKILL");
    } catch {
      process.kill(service.pid, "SIGKILL");
    }
  }
  return { stopped: !pidRunning(service.pid) };
}

async function status({ quiet = false } = {}) {
  const state = readState();
  if (!state) {
    if (!quiet) console.log("Tracey runtime is stopped. No repository-owned runtime state exists.");
    return { healthy: false, state: undefined };
  }
  const rows = [];
  for (const service of state.services ?? []) {
    const running = processOwned(service);
    let health = "stopped";
    if (running) {
      try {
        const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(1_500) });
        health = response.ok ? "healthy" : `degraded (HTTP ${response.status})`;
      } catch {
        health = "unreachable";
      }
    }
    rows.push({ service: service.name, pid: service.pid, port: service.port, running, health, log: service.logPath });
  }
  const dependencyRows = [];
  for (const dependency of state.dependencies ?? []) {
    let health = "stopped";
    if (dependency.name === "postgres") {
      const environment = loadEnvironment();
      if (localDatabase(environment.DATABASE_URL)) Object.assign(environment, localPostgresEnvironment(environment.DATABASE_URL));
      const result = spawnSync("docker", [...dependency.composeArgs, "exec", "-T", "postgres", "pg_isready", "-U", environment.TRACEY_POSTGRES_USER, "-d", environment.TRACEY_POSTGRES_DB], {
        cwd: repoDir, env: environment, stdio: "ignore",
      });
      health = result.status === 0 ? "healthy" : "stopped";
    } else {
      try {
        const response = await fetch("http://127.0.0.1:13133/", { signal: AbortSignal.timeout(1_500) });
        health = response.ok ? "healthy" : `degraded (HTTP ${response.status})`;
      } catch {
        health = "stopped";
      }
    }
    dependencyRows.push({ service: dependency.name, pid: "container", port: dependency.port, running: health === "healthy", health });
  }
  const all = [...dependencyRows, ...rows];
  if (!quiet) {
    console.table(all.map(({ service, pid, port, health }) => ({ service, pid, port, health })));
    console.log(`Web: http://127.0.0.1:${servicePort(state, "web")}`);
    console.log(`API: http://127.0.0.1:${servicePort(state, "api")}`);
  }
  return { healthy: all.length > 0 && all.every(({ health }) => health === "healthy"), state, rows: all };
}

function servicePort(state, name) {
  return state.services?.find((service) => service.name === name)?.port ?? serviceSpecs[name].defaultPort;
}

async function down({ quiet = false } = {}) {
  const state = readState();
  if (!state) {
    if (!quiet) console.log("Tracey is already stopped.");
    return;
  }
  for (const service of [...(state.services ?? [])].reverse()) {
    const result = await terminateService(service);
    if (!quiet) console.log(`${result.stopped ? "Stopped" : "Skipped"} ${service.name}${result.reason ? `: ${result.reason}` : ""}`);
  }
  const environment = loadEnvironment();
  for (const dependency of [...(state.dependencies ?? [])].reverse()) {
    try {
      compose(environment, [...dependency.composeArgs, "down", "--remove-orphans"]);
      if (!quiet) console.log(`Stopped ${dependency.name}; persistent volumes were preserved.`);
    } catch (error) {
      if (!quiet) console.error(`Could not stop ${dependency.name}: ${error.message}`);
    }
  }
  rmSync(statePath, { force: true });
  if (!quiet) console.log("Tracey shutdown complete.");
}

async function up() {
  const existing = readState();
  if (existing && (existing.services ?? []).some(processOwned)) {
    console.log("Tracey already has repository-owned processes. Current status:");
    await status();
    return;
  }
  if (existing) rmSync(statePath, { force: true });
  const environment = loadEnvironment();
  const databaseUrl = required(environment, "DATABASE_URL");
  required(environment, "TRACEY_API_BEARER_TOKEN");
  const localPostgres = localDatabase(databaseUrl);
  const collectorConfigured = Boolean(environment.SIGNOZ_OTLP_ENDPOINT?.trim() && environment.SIGNOZ_INGESTION_KEY?.trim());
  const startExecutor = executorConfigured(environment);
  const needsDocker = localPostgres || collectorConfigured;
  if (localPostgres) Object.assign(environment, localPostgresEnvironment(databaseUrl));
  if (!commandAvailable("psql")) throw new Error("psql is required to run checksum-verified Tracey migrations.");
  if (needsDocker) {
    if (!commandAvailable("docker")) throw new Error("Docker is required for local Tracey dependencies.");
    if (spawnSync("docker", ["info"], { cwd: repoDir, env: environment, stdio: "ignore" }).status !== 0) {
      throw new Error("Docker Desktop is not running. Start Docker Desktop, then run pnpm tracey:up again.");
    }
  }

  const apiPort = parsePort(environment.PORT, 3000);
  const workerPort = parsePort(environment.WORKER_HEALTH_PORT, 3001);
  const executorPort = parsePort(environment.EXECUTOR_PORT, 3002);
  const webPort = 8501;
  const requiredPorts = [
    ...(localPostgres ? [{ name: "PostgreSQL", port: Number(new URL(databaseUrl).port || 5432) }] : []),
    ...(collectorConfigured ? [{ name: "OTLP gRPC", port: 4317 }, { name: "OTLP HTTP", port: 4318 }, { name: "Collector health", port: 13133 }] : []),
    { name: "API", port: apiPort },
    { name: "Worker", port: workerPort },
    ...(startExecutor ? [{ name: "Executor", port: executorPort }] : []),
    { name: "Web", port: webPort },
  ];
  await assertPortsFree(requiredPorts);

  const state = { version: 1, startedAt: new Date().toISOString(), dependencies: [], services: [] };
  writeState(state);
  try {
    if (localPostgres) {
      console.log("Starting PostgreSQL...");
      compose(environment, [...postgresCompose, "up", "-d"]);
      state.dependencies.push({ name: "postgres", service: "postgres", port: Number(new URL(databaseUrl).port || 5432), composeArgs: postgresCompose });
      writeState(state);
      await waitForPostgres(environment);
    }
    if (collectorConfigured) {
      console.log("Starting OpenTelemetry Collector...");
      compose(environment, [...collectorCompose, "up", "-d"]);
      state.dependencies.push({ name: "otel-collector", service: "collector", port: 4318, composeArgs: collectorCompose });
      writeState(state);
      await waitForHttp("http://127.0.0.1:13133/", 30_000);
    } else {
      console.warn("OpenTelemetry Collector skipped: SIGNOZ_OTLP_ENDPOINT and SIGNOZ_INGESTION_KEY are not both configured.");
    }

    console.log("Applying checksum-verified database migrations...");
    run("bash", ["scripts/migrate.sh"], { env: environment, inherit: true });
    console.log("Building Tracey...");
    run("pnpm", ["build"], { env: environment, inherit: true });

    const shared = {
      ...environment,
      TRACEY_API_URL: `http://127.0.0.1:${apiPort}`,
      TRACEY_UI_ACCESS_TOKEN: environment.TRACEY_UI_ACCESS_TOKEN || environment.TRACEY_API_BEARER_TOKEN,
      ...(startExecutor ? { TRACEY_EXECUTOR_URL: `http://127.0.0.1:${executorPort}` } : {}),
    };
    for (const [name, port] of [["api", apiPort], ["worker", workerPort]]) {
      console.log(`Starting ${name}...`);
      const service = startService(name, shared, port);
      state.services.push(service);
      writeState(state);
      await waitForHttp(service.healthUrl, 30_000);
    }
    if (startExecutor) {
      console.log("Starting restricted executor...");
      const service = startService("executor", shared, executorPort);
      state.services.push(service);
      writeState(state);
      const executorHealth = await waitForHttp(service.healthUrl, 30_000, true);
      if (!executorHealth.ok) console.warn("Executor is running but its Kubernetes permission health check is not ready.");
    } else {
      console.warn("Restricted executor skipped: it is not explicitly enabled with token and workload scopes.");
    }
    console.log("Starting web...");
    const web = startService("web", shared, webPort);
    state.services.push(web);
    writeState(state);
    await waitForHttp(web.healthUrl, 45_000);

    console.log("\nTracey is ready.");
    console.log(`Web: http://127.0.0.1:${webPort}`);
    console.log(`API: http://127.0.0.1:${apiPort}`);
    console.log(`Logs: ${logDir}`);
    await status();
  } catch (error) {
    console.error(`Startup failed: ${error.message}`);
    await down({ quiet: true });
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "up") return up();
  if (command === "status") {
    const result = await status();
    if (!result.healthy) process.exitCode = 1;
    return;
  }
  if (command === "down") return down();
  console.log("Usage: node scripts/tracey-runtime.mjs <up|status|down>");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
