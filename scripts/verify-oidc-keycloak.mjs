#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const keycloakImage = process.env.TRACEY_KEYCLOAK_IMAGE ?? "quay.io/keycloak/keycloak:26.7.0";
const keycloakPort = Number(process.env.TRACEY_KEYCLOAK_PORT ?? 18_080);
const apiPort = Number(process.env.TRACEY_OIDC_API_PORT ?? 13_200);
const realmName = `tracey-live-${process.pid}`;
const clientId = "tracey-api";
const tenantId = `tenant-live-${process.pid}`;
const wrongTenantId = `tenant-other-${process.pid}`;
const viewerPassword = randomBytes(24).toString("base64url");
const adminPassword = randomBytes(24).toString("base64url");
const wrongTenantPassword = randomBytes(24).toString("base64url");
const bootstrapPassword = randomBytes(24).toString("base64url");
const containerName = `tracey-oidc-${process.pid}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "tracey-oidc-keycloak-"));
const realmPath = join(temporaryDirectory, `${realmName}-realm.json`);
const apiLogPath = join(temporaryDirectory, "tracey-api.log");
const issuer = `http://127.0.0.1:${keycloakPort}/realms/${realmName}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
let apiProcess;
let keycloakStarted = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout).trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return String(result.stdout).trim();
}

async function waitFor(url, timeoutMs) {
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

async function token(username, password) {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      username,
      password,
      scope: "openid",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Keycloak token request returned HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (typeof body.access_token !== "string") throw new Error("Keycloak returned no access token");
  return body.access_token;
}

async function apiRequest(path, accessToken, init = {}) {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

function realmUser(username, password, tenant, realmRoles) {
  return {
    username,
    enabled: true,
    firstName: "Tracey",
    lastName: "Verifier",
    email: `${username}@tracey.invalid`,
    emailVerified: true,
    requiredActions: [],
    attributes: { tenant_id: [tenant] },
    credentials: [{ type: "password", value: password, temporary: false }],
    realmRoles,
  };
}

const realm = {
  realm: realmName,
  enabled: true,
  registrationAllowed: false,
  resetPasswordAllowed: false,
  roles: {
    realm: [
      { name: "viewer" },
      { name: "analyst" },
      { name: "operator" },
      { name: "admin" },
    ],
  },
  clients: [
    {
      clientId,
      enabled: true,
      protocol: "openid-connect",
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: false,
      serviceAccountsEnabled: false,
      protocolMappers: [
        {
          name: "tracey-tenant",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-attribute-mapper",
          consentRequired: false,
          config: {
            "user.attribute": "tenant_id",
            "claim.name": "tenant_id",
            "jsonType.label": "String",
            "access.token.claim": "true",
            "id.token.claim": "true",
          },
        },
        {
          name: "tracey-roles",
          protocol: "openid-connect",
          protocolMapper: "oidc-usermodel-realm-role-mapper",
          consentRequired: false,
          config: {
            "claim.name": "roles",
            "jsonType.label": "String",
            multivalued: "true",
            "access.token.claim": "true",
            "id.token.claim": "true",
          },
        },
        {
          name: "tracey-audience",
          protocol: "openid-connect",
          protocolMapper: "oidc-audience-mapper",
          consentRequired: false,
          config: {
            "included.client.audience": clientId,
            "access.token.claim": "true",
          },
        },
      ],
    },
  ],
  users: [
    realmUser("tracey-viewer", viewerPassword, tenantId, ["viewer"]),
    realmUser("tracey-admin", adminPassword, tenantId, ["admin"]),
    realmUser("tracey-wrong-tenant", wrongTenantPassword, wrongTenantId, ["admin"]),
  ],
};

writeFileSync(realmPath, `${JSON.stringify(realm, null, 2)}\n`, { mode: 0o600 });

try {
  run("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${keycloakPort}:8080`,
    "--memory",
    "1g",
    "--env",
    "KC_BOOTSTRAP_ADMIN_USERNAME=tracey-bootstrap",
    "--env",
    `KC_BOOTSTRAP_ADMIN_PASSWORD=${bootstrapPassword}`,
    "--mount",
    `type=bind,source=${realmPath},target=/opt/keycloak/data/import/${realmName}-realm.json,readonly`,
    keycloakImage,
    "start-dev",
    "--import-realm",
  ]);
  keycloakStarted = true;
  await waitFor(`${issuer}/.well-known/openid-configuration`, 120_000);

  const logDescriptor = openSync(apiLogPath, "a", 0o600);
  apiProcess = spawn("node", ["apps/api/dist/main.js"], {
    cwd: resolve("."),
    detached: false,
    env: {
      ...process.env,
      PORT: String(apiPort),
      TRACEY_API_BEARER_TOKEN: "",
      TRACEY_TENANT_ID: tenantId,
      OIDC_ISSUER_URL: issuer,
      OIDC_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
      OIDC_AUDIENCE: clientId,
      OIDC_TENANT_CLAIM: "tenant_id",
      OIDC_ROLES_CLAIM: "roles",
      TRACEY_KUBERNETES_INVESTIGATOR_ENABLED: "false",
      TRACEY_KUBERNETES_EXECUTOR_ENABLED: "false",
      OTEL_SDK_DISABLED: "true",
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  await waitFor(`${apiUrl}/health`, 30_000);

  const viewerToken = await token("tracey-viewer", viewerPassword);
  const adminToken = await token("tracey-admin", adminPassword);
  const wrongTenantToken = await token("tracey-wrong-tenant", wrongTenantPassword);

  const liveVerifier = run("node", ["scripts/verify-oidc.mjs"], {
    env: {
      OIDC_ISSUER_URL: issuer,
      OIDC_AUDIENCE: clientId,
      OIDC_TENANT_CLAIM: "tenant_id",
      OIDC_ROLES_CLAIM: "roles",
      TRACEY_TENANT_ID: tenantId,
      TRACEY_OIDC_TEST_TOKEN: viewerToken,
      TRACEY_API_URL: apiUrl,
    },
  });

  const viewerRead = await apiRequest("/v1/connectors", viewerToken);
  const viewerAdminRoute = await apiRequest("/v1/autonomy/break-glass", viewerToken);
  const adminRoute = await apiRequest("/v1/autonomy/break-glass", adminToken);
  const wrongTenant = await apiRequest("/v1/connectors", wrongTenantToken);
  if (!viewerRead.ok) throw new Error(`Viewer read returned HTTP ${viewerRead.status}`);
  if (viewerAdminRoute.status !== 403) throw new Error(`Viewer admin route returned HTTP ${viewerAdminRoute.status}, expected 403`);
  if (adminRoute.status === 401 || adminRoute.status === 403) throw new Error(`Admin authorization returned HTTP ${adminRoute.status}`);
  if (wrongTenant.status !== 401) throw new Error(`Wrong-tenant token returned HTTP ${wrongTenant.status}, expected 401`);

  const verified = JSON.parse(liveVerifier);
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    provider: "Keycloak",
    providerImage: keycloakImage,
    discoveryVerified: verified.discoveryVerified,
    jwksPublished: verified.jwksPublished,
    protectedApiAcceptedToken: verified.protectedApiAcceptedToken,
    viewerReadAllowed: true,
    viewerAdminDenied: true,
    adminAuthorized: true,
    wrongTenantRejected: true,
  };
  mkdirSync(resolve(".tracey/reports"), { recursive: true });
  writeFileSync(resolve(".tracey/reports/oidc-keycloak.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill("SIGTERM");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    if (apiProcess.exitCode === null) apiProcess.kill("SIGKILL");
  }
  if (keycloakStarted) {
    spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
