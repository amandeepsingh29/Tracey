#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { buildAgentRunsQuery } from "../packages/signoz-adapter/dist/signoz-adapter.js";
import { localApplicationDatabaseUrl } from "./tracey-runtime.mjs";

dotenv.config({ quiet: true });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const applicationDatabaseUrl = ["127.0.0.1", "localhost", "::1"].includes(new URL(databaseUrl).hostname)
  ? localApplicationDatabaseUrl(databaseUrl, process.env.TRACEY_POSTGRES_APP_PASSWORD)
  : databaseUrl;
const pool = new pg.Pool({ connectionString: applicationDatabaseUrl, max: 2 });
const suffix = randomUUID().slice(0, 8);
const tenants = [`isolation-a-${suffix}`, `isolation-b-${suffix}`];
const records = tenants.map((tenantId, index) => ({
  tenantId,
  agentId: randomUUID(),
  sessionId: randomUUID(),
  proposalId: randomUUID(),
  idempotencyKey: randomUUID(),
  serviceName: `isolation-agent-${index}-${suffix}`,
}));
const tables = [
  "agent_integrations",
  "investigation_sessions",
  "connector_configs",
  "action_proposals",
];

async function inTenant(tenantId, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('tracey.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seed(record) {
  await inTenant(record.tenantId, async (client) => {
    await client.query(
      `INSERT INTO tracey.agent_integrations
       (tenant_id,agent_id,display_name,service_name,producer_type,environment,normalization_profile,telemetry_contract_version)
       VALUES ($1,$2,'Isolation verifier',$3,'custom_otel','production','tracey.agent.v1','1.0.0')`,
      [record.tenantId, record.agentId, record.serviceName],
    );
    await client.query(
      "INSERT INTO tracey.investigation_sessions (tenant_id,session_id,title) VALUES ($1,$2,'Isolation verifier')",
      [record.tenantId, record.sessionId],
    );
    await client.query(
      `INSERT INTO tracey.connector_configs
       (tenant_id,connector_id,public_config,enabled,status,updated_by)
       VALUES ($1,'signoz','{}',false,'disabled','isolation-verifier')`,
      [record.tenantId],
    );
    await client.query(
      `INSERT INTO tracey.action_proposals
       (tenant_id,proposal_id,session_id,action_type,target,reason,risk,proposed_by,idempotency_key)
       VALUES ($1,$2,$3,'restart','deployment/isolation','Isolation verifier','low','isolation-verifier',$4)`,
      [record.tenantId, record.proposalId, record.sessionId, record.idempotencyKey],
    );
  });
}

async function visibleCounts(tenantId) {
  return inTenant(tenantId, async (client) => {
    const result = {};
    for (const table of tables) {
      const count = await client.query(`SELECT count(*)::int AS count FROM tracey.${table}`);
      result[table] = count.rows[0].count;
    }
    return result;
  });
}

async function remove(record) {
  await inTenant(record.tenantId, async (client) => {
    await client.query(
      "DELETE FROM tracey.action_proposals WHERE tenant_id=$1 AND proposal_id=$2",
      [record.tenantId, record.proposalId],
    );
    await client.query(
      "DELETE FROM tracey.connector_configs WHERE tenant_id=$1 AND connector_id='signoz'",
      [record.tenantId],
    );
    await client.query(
      "DELETE FROM tracey.investigation_sessions WHERE tenant_id=$1 AND session_id=$2",
      [record.tenantId, record.sessionId],
    );
    await client.query(
      "DELETE FROM tracey.agent_integrations WHERE tenant_id=$1 AND agent_id=$2",
      [record.tenantId, record.agentId],
    );
  });
}

try {
  for (const record of records) await seed(record);
  const countsA = await visibleCounts(records[0].tenantId);
  const countsB = await visibleCounts(records[1].tenantId);
  for (const [tenant, counts] of [[records[0].tenantId, countsA], [records[1].tenantId, countsB]]) {
    for (const [table, count] of Object.entries(counts)) {
      if (count !== 1) throw new Error(`${tenant} saw ${count} rows in ${table}; expected exactly its own row`);
    }
  }

  const unscoped = await pool.query("SELECT count(*)::int AS count FROM tracey.agent_integrations");
  if (unscoped.rows[0].count !== 0) throw new Error("An unscoped connection could read tenant-owned agent rows");

  let crossTenantWriteDenied = false;
  try {
    await inTenant(records[0].tenantId, (client) => client.query(
      `INSERT INTO tracey.agent_integrations
       (tenant_id,agent_id,display_name,service_name,producer_type,environment,normalization_profile,telemetry_contract_version)
       VALUES ($1,$2,'Cross tenant write',$3,'custom_otel','production','tracey.agent.v1','1.0.0')`,
      [records[1].tenantId, randomUUID(), `cross-${suffix}`],
    ));
  } catch (error) {
    crossTenantWriteDenied = error?.code === "42501";
  }
  if (!crossTenantWriteDenied) throw new Error("PostgreSQL did not reject a cross-tenant insert");

  const signozQueries = tenants.map((tenantId) => buildAgentRunsQuery({
    start: 1_700_000_000_000,
    end: 1_700_000_060_000,
    serviceName: "isolation-agent",
    limit: 10,
    offset: 0,
  }, { tenantId, environment: "production" }));
  const expressions = signozQueries.map((query) => query.compositeQuery.queries[0].spec.filter.expression);
  if (!expressions[0].includes(`tracey.tenant.id = '${tenants[0]}'`)) throw new Error("Tenant A was absent from its SigNoz query");
  if (!expressions[1].includes(`tracey.tenant.id = '${tenants[1]}'`)) throw new Error("Tenant B was absent from its SigNoz query");
  if (expressions[0] === expressions[1]) throw new Error("Two tenant scopes produced the same SigNoz query");

  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    tenants,
    postgres: {
      forcedRlsTablesChecked: tables,
      tenantAVisibleCounts: countsA,
      tenantBVisibleCounts: countsB,
      unscopedRowsVisible: unscoped.rows[0].count,
      crossTenantWriteDenied,
    },
    signoz: {
      distinctTenantFilters: true,
      environmentFilter: "production",
    },
    connectorConfigurationIsolated: true,
    investigationsIsolated: true,
    actionsIsolated: true,
  };
  mkdirSync(resolve(".tracey/reports"), { recursive: true });
  writeFileSync(resolve(".tracey/reports/tenant-isolation.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const record of records) await remove(record).catch(() => undefined);
  await pool.end();
}
