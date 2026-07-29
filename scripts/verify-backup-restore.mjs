#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL is required");
const parsed = new URL(adminUrl);
const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
const sourceDatabase = `tracey_backup_src_${suffix}`;
const targetDatabase = `tracey_backup_dst_${suffix}`;
const sourceUrl = new URL(adminUrl);
const targetUrl = new URL(adminUrl);
sourceUrl.pathname = `/${sourceDatabase}`;
targetUrl.pathname = `/${targetDatabase}`;
const reportDir = resolve(".tracey/reports/backup-restore");
const backupPath = resolve(reportDir, `${sourceDatabase}.dump`);
mkdirSync(reportDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout).trim();
}

function postgresToolsContainer() {
  if (process.env.TRACEY_PG_TOOLS_CONTAINER) return process.env.TRACEY_PG_TOOLS_CONTAINER;
  const runtime = JSON.parse(readFileSync(resolve(".tracey/runtime.json"), "utf8"));
  const dependency = runtime.dependencies?.find(({ name }) => name === "postgres");
  if (!dependency?.composeArgs) {
    throw new Error("The running Tracey PostgreSQL Compose identity is unavailable");
  }
  const container = run("docker", [...dependency.composeArgs, "ps", "--quiet", "postgres"]);
  if (!container) throw new Error("The Tracey PostgreSQL container is not running");
  return container;
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${sourceDatabase}"`);
  await admin.query(`CREATE DATABASE "${targetDatabase}"`);
  run("bash", ["scripts/migrate.sh"], { env: { DATABASE_URL: sourceUrl.toString() }, inherit: true });
  const source = new pg.Client({ connectionString: sourceUrl.toString() });
  await source.connect();
  const tenantId = `backup-verifier-${suffix}`;
  const agentId = randomUUID();
  try {
    await source.query(
      `INSERT INTO tracey.agent_integrations
       (tenant_id,agent_id,display_name,service_name,producer_type,environment,normalization_profile,telemetry_contract_version)
       VALUES ($1,$2,'Backup verifier',$3,'custom_otel','production','tracey.agent.v1','1.0.0')`,
      [tenantId, agentId, `backup-verifier-${suffix}`],
    );
  } finally {
    await source.end();
  }

  const toolsContainer = postgresToolsContainer();
  run("node", ["scripts/postgres-backup.mjs", backupPath], {
    env: {
      DATABASE_URL: sourceUrl.toString(),
      TRACEY_PG_TOOLS_CONTAINER: toolsContainer,
    },
  });
  run("node", ["scripts/postgres-restore.mjs", backupPath, targetUrl.toString()], {
    env: {
      TRACEY_RESTORE_CONFIRM: "RESTORE",
      TRACEY_PG_TOOLS_CONTAINER: toolsContainer,
    },
  });

  const target = new pg.Client({ connectionString: targetUrl.toString() });
  await target.connect();
  let restoredAgent;
  let restoredMigrations;
  try {
    restoredAgent = Number((await target.query(
      "SELECT count(*)::int AS count FROM tracey.agent_integrations WHERE tenant_id=$1 AND agent_id=$2",
      [tenantId, agentId],
    )).rows[0].count);
    restoredMigrations = Number((await target.query(
      "SELECT count(*)::int AS count FROM tracey.schema_migrations",
    )).rows[0].count);
  } finally {
    await target.end();
  }
  if (restoredAgent !== 1) throw new Error("Restored database is missing the verification agent");

  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    sourceDatabase,
    targetDatabase,
    customFormatBackup: true,
    checksumVerifiedBeforeRestore: true,
    restoredMigrations,
    restoredVerificationRows: restoredAgent,
    sourceAndTargetSeparated: sourceDatabase !== targetDatabase,
  };
  writeFileSync(resolve(".tracey/reports/backup-restore.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const database of [sourceDatabase, targetDatabase]) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [database],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
  }
  await admin.end();
  rmSync(backupPath, { force: true });
  rmSync(`${backupPath}.json`, { force: true });
}
