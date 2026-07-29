#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsed = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("DATABASE_URL must be PostgreSQL");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = resolve(process.argv[2] ?? `.tracey/backups/tracey-${timestamp}.dump`);
const temporaryPath = `${backupPath}.partial`;
const manifestPath = `${backupPath}.json`;
mkdirSync(dirname(backupPath), { recursive: true });

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

try {
  unlinkSync(temporaryPath);
} catch {
  // There was no abandoned partial backup.
}
const dumpArguments = ["--format=custom", "--compress=9", "--no-owner", "--no-acl"];
if (process.env.TRACEY_PG_TOOLS_CONTAINER) {
  const result = spawnSync("docker", [
    "exec",
    process.env.TRACEY_PG_TOOLS_CONTAINER,
    "pg_dump",
    "--username",
    pgEnvironment.PGUSER,
    "--dbname",
    pgEnvironment.PGDATABASE,
    ...dumpArguments,
  ], { encoding: null, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`container pg_dump failed: ${String(result.stderr).trim()}`);
  writeFileSync(temporaryPath, result.stdout, { mode: 0o600 });
} else {
  run("pg_dump", [...dumpArguments, "--file", temporaryPath]);
}
renameSync(temporaryPath, backupPath);
const bytes = statSync(backupPath).size;
const sha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
const [serverVersion, migrationCount] = run("psql", [
  "--tuples-only",
  "--no-align",
  "--field-separator=|",
  "--command",
  "SELECT current_setting('server_version'), (SELECT count(*) FROM tracey.schema_migrations)",
]).split("|");
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  file: basename(backupPath),
  format: "postgres-custom",
  database: pgEnvironment.PGDATABASE,
  serverVersion,
  migrationCount: Number(migrationCount),
  bytes,
  sha256,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ backupPath, manifestPath, ...manifest }, null, 2));
