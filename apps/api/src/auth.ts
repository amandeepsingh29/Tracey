import { timingSafeEqual } from "node:crypto";
import { apiAuthentication, emitOperationalLog } from "@tracey/telemetry";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type TraceyRole = "viewer" | "analyst" | "operator" | "admin";
export interface TraceyAuthContext { subject: string; tenantId: string; roles: TraceyRole[]; method: "static" | "oidc" }

declare module "fastify" {
  interface FastifyRequest { authContext?: TraceyAuthContext }
}

export function bearerTokenMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createApiAuthenticator(config: {
  bearerToken?: string;
  tokenId: string;
  tenantId: string;
  oidc?: { issuer: string; jwksUrl: string; audience: string; tenantClaim: string; rolesClaim: string };
}): preHandlerHookHandler {
  const jwks = config.oidc ? createRemoteJWKSet(new URL(config.oidc.jwksUrl)) : undefined;
  return async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    const attributes = {
      "http.request.method": request.method,
      "http.route": route,
      "tracey.auth.token_id": config.tokenId,
    };
    if (!config.bearerToken && !config.oidc) {
      apiAuthentication.add(1, { ...attributes, "tracey.auth.outcome": "not_configured" });
      emitOperationalLog("ERROR", "Tracey API authentication is not configured", {
        ...attributes,
        "tracey.auth.outcome": "not_configured",
      });
      return reply.code(503).send({
        error: "TRACEY_API_BEARER_TOKEN is required before protected Tracey API routes are enabled",
      });
    }
    if (config.bearerToken && bearerTokenMatches(request.headers.authorization, config.bearerToken)) {
      request.authContext = { subject: config.tokenId, tenantId: config.tenantId, roles: ["admin"], method: "static" };
    } else if (config.oidc && jwks && request.headers.authorization?.startsWith("Bearer ")) {
      try {
        const { payload } = await jwtVerify(request.headers.authorization.slice(7), jwks, {
          issuer: config.oidc.issuer, audience: config.oidc.audience,
        });
        const tenant = payload[config.oidc.tenantClaim];
        const rawRoles = payload[config.oidc.rolesClaim];
        const roles = (Array.isArray(rawRoles) ? rawRoles : typeof rawRoles === "string" ? rawRoles.split(/[ ,]+/) : [])
          .filter((role): role is TraceyRole => ["viewer", "analyst", "operator", "admin"].includes(String(role)));
        if (typeof tenant !== "string" || tenant !== config.tenantId || roles.length === 0 || !payload.sub) throw new Error("OIDC claims are outside the configured tenant or role policy");
        request.authContext = { subject: payload.sub, tenantId: tenant, roles, method: "oidc" };
      } catch {
        delete request.authContext;
      }
    }
    if (!request.authContext) {
      apiAuthentication.add(1, { ...attributes, "tracey.auth.outcome": "unauthorized" });
      emitOperationalLog("WARN", "Tracey API authentication rejected", {
        ...attributes,
        "tracey.auth.outcome": "unauthorized",
      });
      reply.header("www-authenticate", 'Bearer realm="tracey-api"');
      return reply.code(401).send({ error: "Valid bearer authentication is required" });
    }

    apiAuthentication.add(1, { ...attributes, "tracey.auth.outcome": "authorized" });
    emitOperationalLog("INFO", "Tracey API access authorized", {
      ...attributes,
      "tracey.auth.outcome": "authorized",
    });
  };
}

export function requireRoles(authenticate: preHandlerHookHandler, allowed: TraceyRole[]): preHandlerHookHandler {
  return async (request, reply) => {
    await (authenticate as unknown as (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(request, reply);
    if (reply.sent) return;
    if (!request.authContext?.roles.some((role) => allowed.includes(role))) {
      return reply.code(403).send({ error: `One of these roles is required: ${allowed.join(", ")}` });
    }
  };
}
