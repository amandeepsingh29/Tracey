// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  pkceChallenge,
  readSession,
  safeReturnTo,
  seal,
  valuesMatch,
  webAuthConfig,
  WebSessionSchema,
} from "./oidc";

const secret = "a-production-session-secret-that-is-long-enough";

describe("OIDC web sessions", () => {
  it("encrypts a per-user session and rejects tampering", async () => {
    const session = WebSessionSchema.parse({
      subject: "user-42",
      name: "Amandeep",
      roles: ["operator"],
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
    });
    const cookie = await seal(session, secret);
    expect(cookie).not.toContain("access-token");
    expect((await readSession(cookie, {
      mode: "oidc",
      issuer: "https://id.example.test",
      clientId: "tracey",
      sessionSecret: secret,
      scopes: "openid",
      tenantClaim: "tenant_id",
      rolesClaim: "roles",
    }))?.subject).toBe("user-42");
    const parts = cookie.split(".");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    expect(await readSession(parts.join("."), {
      mode: "oidc",
      issuer: "https://id.example.test",
      clientId: "tracey",
      sessionSecret: secret,
      scopes: "openid",
      tenantClaim: "tenant_id",
      rolesClaim: "roles",
    })).toBeUndefined();
  });

  it("requires complete OIDC configuration and prevents open redirects", () => {
    expect(() => webAuthConfig({ NODE_ENV: "test", TRACEY_WEB_AUTH_MODE: "oidc" })).toThrow(/requires/);
    expect(safeReturnTo("//attacker.example")).toBe("/");
    expect(safeReturnTo("https://attacker.example")).toBe("/");
    expect(safeReturnTo("/runs?page=2")).toBe("/runs?page=2");
  });

  it("creates deterministic PKCE challenges and constant-time state matches", () => {
    expect(pkceChallenge("a".repeat(64))).toHaveLength(43);
    expect(valuesMatch("same-state", "same-state")).toBe(true);
    expect(valuesMatch("same-state", "different-state")).toBe(false);
  });
});
