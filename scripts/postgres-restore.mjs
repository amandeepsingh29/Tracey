#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();
const backupPath = resolve(process.argv[2] ?? "");
const targetUrl = process.argv[3] ?? process.env.RESTORE_DATABASE_URL;
if (!process.argv[2] || !targetUrl) {
  throw new Error("Usage: node scripts/postgres-restore.mjs <backup.dump> <target-database-url>");
}
if (process.env.TRACEY_RESTORE_CONFIRM !== "RESTORE") {
  throw new Error("Set TRACEY_RESTORE_CONFIRM=RESTORE to acknowledge the target database mutation");
}
const manifest = JSON.parse(readFileSync(`${backupPath}.json`, "utf8"));
const checksum = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
if (checksum !== manifest.sha256) throw new Error("Backup checksum does not match its manifest");

const parsed = new URL(targetUrl);
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Target URL must be PostgreSQL");
const pgEnvironment = {
  ...process.env,
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || "5432",
  PGUSER: decodeURIComponent(parsed.username),
  PGPASSWORD: decodeURIComponent(parsed.password),
  PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
};

function run(command, args, environment = pgEnvironment) {
  const result = spawnSync(command, args, {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim()}`);
  return String(result.stdout).trim();
}

const existingObjects = Number(run("psql", [
  "--tuples-only",
  "--no-align",
  "--command",
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m')",
]));
if (existingObjects > 0 && process.env.TRACEY_RESTORE_ALLOW_NONEMPTY !== "true") {
  throw new Error(`Target database contains ${existingObjects} objects; restore requires an empty database`);
}
const restoreArguments = ["--exit-on-error", "--no-owner", "--no-acl"];
if (process.env.TRACEY_PG_TOOLS_CONTAINER) {
  const result = spawnSync("docker", [
    "exec",
    "--interactive",
    process.env.TRACEY_PG_TOOLS_CONTAINER,
    "pg_restore",
    "--username",
    pgEnvironment.PGUSER,
    "--dbname",
    pgEnvironment.PGDATABASE,
    ...restoreArguments,
  ], {
    input: readFileSync(backupPath),
    encoding: null,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`container pg_restore failed: ${String(result.stderr).trim()}`);
} else {
  run("pg_restore", [
    ...restoreArguments,
    "--dbname",
    pgEnvironment.PGDATABASE,
    backupPath,
  ]);
}
const restoredMigrations = Number(run("psql", [
  "--tuples-only",
  "--no-align",
  "--command",
  "SELECT count(*) FROM tracey.schema_migrations",
]));
if (restoredMigrations !== manifest.migrationCount) {
  throw new Error(`Restored ${restoredMigrations}/${manifest.migrationCount} migration records`);
}
console.log(JSON.stringify({
  restoredAt: new Date().toISOString(),
  targetDatabase: pgEnvironment.PGDATABASE,
  checksumVerified: true,
  migrationCount: restoredMigrations,
}, null, 2));
