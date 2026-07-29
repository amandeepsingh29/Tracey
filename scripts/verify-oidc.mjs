#!/usr/bin/env node

import dotenv from "dotenv";

dotenv.config({ quiet: true });
const issuer = process.env.OIDC_ISSUER_URL;
const audience = process.env.OIDC_AUDIENCE;
const token = process.env.TRACEY_OIDC_TEST_TOKEN;
const tenantClaim = process.env.OIDC_TENANT_CLAIM ?? "tenant_id";
const rolesClaim = process.env.OIDC_ROLES_CLAIM ?? "roles";
const apiUrl = (process.env.TRACEY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
if (!issuer || !audience || !token) {
  throw new Error("OIDC_ISSUER_URL, OIDC_AUDIENCE and TRACEY_OIDC_TEST_TOKEN are required for live OIDC verification");
}

const discoveryUrl = new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`);
const discoveryResponse = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
if (!discoveryResponse.ok) throw new Error(`OIDC discovery returned HTTP ${discoveryResponse.status}`);
const discovery = await discoveryResponse.json();
if (discovery.issuer !== issuer) throw new Error("OIDC discovery issuer does not exactly match OIDC_ISSUER_URL");
if (typeof discovery.jwks_uri !== "string") throw new Error("OIDC discovery did not publish jwks_uri");
const jwksResponse = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000) });
if (!jwksResponse.ok) throw new Error(`OIDC JWKS returned HTTP ${jwksResponse.status}`);
const jwks = await jwksResponse.json();
if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error("OIDC JWKS contains no signing keys");

const parts = token.split(".");
if (parts.length !== 3) throw new Error("TRACEY_OIDC_TEST_TOKEN is not a JWT");
const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
if (payload.exp * 1_000 <= Date.now()) throw new Error("TRACEY_OIDC_TEST_TOKEN is expired");
const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
if (!audiences.includes(audience)) throw new Error("OIDC test token does not target OIDC_AUDIENCE");
if (payload[tenantClaim] !== process.env.TRACEY_TENANT_ID) throw new Error("OIDC test token tenant does not match TRACEY_TENANT_ID");
const roles = Array.isArray(payload[rolesClaim])
  ? payload[rolesClaim]
  : typeof payload[rolesClaim] === "string" ? payload[rolesClaim].split(/[ ,]+/) : [];
if (!roles.some((role) => ["viewer", "analyst", "operator", "admin"].includes(role))) {
  throw new Error("OIDC test token contains no Tracey role");
}

const response = await fetch(`${apiUrl}/v1/connectors`, {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Tracey rejected the live OIDC token with HTTP ${response.status}`);
console.log(JSON.stringify({
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  issuer,
  audience,
  subject: payload.sub,
  tenant: payload[tenantClaim],
  roles,
  discoveryVerified: true,
  jwksPublished: true,
  protectedApiAcceptedToken: true,
}, null, 2));
