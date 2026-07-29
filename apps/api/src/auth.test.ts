import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import Fastify from "fastify";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createApiAuthenticator, requireRoles } from "./auth.js";

describe("OIDC authentication and role authorization", () => {
  it("verifies issuer, audience, expiry, tenant and viewer/admin permissions through JWKS", async () => {
    const issuer = "https://identity.example.test/";
    const audience = "tracey-api";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "tracey-test-key" };
    const jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "public,max-age=60" });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer.once("error", reject);
      jwksServer.listen(0, "127.0.0.1", resolve);
    });
    const address = jwksServer.address();
    assert.ok(address && typeof address === "object");

    const app = Fastify();
    const authenticate = createApiAuthenticator({
      tokenId: "oidc",
      tenantId: "tenant-a",
      oidc: {
        issuer,
        audience,
        jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
        tenantClaim: "tenant_id",
        rolesClaim: "roles",
      },
    });
    app.get("/viewer", { preHandler: authenticate }, async (request) => request.authContext);
    app.get("/admin", { preHandler: requireRoles(authenticate, ["admin"]) }, async () => ({ ok: true }));

    const token = (input: { tenantId: string; roles: string[]; expiresIn: string }) =>
      new SignJWT({ tenant_id: input.tenantId, roles: input.roles })
        .setProtectedHeader({ alg: "RS256", kid: "tracey-test-key" })
        .setSubject("user-123")
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(input.expiresIn)
        .sign(privateKey);

    try {
      const viewerToken = await token({ tenantId: "tenant-a", roles: ["viewer"], expiresIn: "5m" });
      const viewer = await app.inject({ method: "GET", url: "/viewer", headers: { authorization: `Bearer ${viewerToken}` } });
      assert.equal(viewer.statusCode, 200);
      assert.deepEqual(viewer.json(), {
        subject: "user-123",
        tenantId: "tenant-a",
        roles: ["viewer"],
        method: "oidc",
      });
      const viewerAdmin = await app.inject({ method: "GET", url: "/admin", headers: { authorization: `Bearer ${viewerToken}` } });
      assert.equal(viewerAdmin.statusCode, 403);

      const adminToken = await token({ tenantId: "tenant-a", roles: ["admin"], expiresIn: "5m" });
      const admin = await app.inject({ method: "GET", url: "/admin", headers: { authorization: `Bearer ${adminToken}` } });
      assert.equal(admin.statusCode, 200);

      const wrongTenantToken = await token({ tenantId: "tenant-b", roles: ["admin"], expiresIn: "5m" });
      const wrongTenant = await app.inject({ method: "GET", url: "/viewer", headers: { authorization: `Bearer ${wrongTenantToken}` } });
      assert.equal(wrongTenant.statusCode, 401);

      const expiredToken = await token({ tenantId: "tenant-a", roles: ["admin"], expiresIn: "-1s" });
      const expired = await app.inject({ method: "GET", url: "/viewer", headers: { authorization: `Bearer ${expiredToken}` } });
      assert.equal(expired.statusCode, 401);
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
    }
  });
});
