import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CompactEncrypt, compactDecrypt, createRemoteJWKSet, jwtVerify } from "jose";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const SESSION_COOKIE = "tracey_session";
export const LOGIN_ATTEMPT_COOKIE = "tracey_oidc_attempt";

const DiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  end_session_endpoint: z.string().url().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("Bearer"),
  expires_in: z.coerce.number().int().positive().default(300),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});

const LoginAttemptSchema = z.object({
  state: z.string().min(32),
  nonce: z.string().min(32),
  codeVerifier: z.string().min(43),
  redirectUri: z.string().url(),
  returnTo: z.string().startsWith("/"),
});

export const WebSessionSchema = z.object({
  subject: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
  tenantId: z.string().optional(),
  roles: z.array(z.string()).default([]),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive(),
  idToken: z.string().min(1).optional(),
});

export type WebSession = z.infer<typeof WebSessionSchema>;

export interface WebAuthConfig {
  mode: "local" | "oidc";
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  audience?: string;
  scopes: string;
  sessionSecret?: string;
  tenantClaim: string;
  rolesClaim: string;
  publicUrl?: string;
}

export function webAuthConfig(environment: NodeJS.ProcessEnv = process.env): WebAuthConfig {
  const inferred = environment.TRACEY_WEB_OIDC_CLIENT_ID && environment.OIDC_ISSUER_URL ? "oidc" : "local";
  const mode = z.enum(["local", "oidc"]).parse(environment.TRACEY_WEB_AUTH_MODE ?? inferred);
  const config: WebAuthConfig = {
    mode,
    scopes: environment.TRACEY_WEB_OIDC_SCOPES?.trim() || "openid profile email offline_access",
    tenantClaim: environment.OIDC_TENANT_CLAIM?.trim() || "tenant_id",
    rolesClaim: environment.OIDC_ROLES_CLAIM?.trim() || "roles",
    ...(environment.OIDC_ISSUER_URL ? { issuer: new URL(environment.OIDC_ISSUER_URL).toString().replace(/\/$/, "") } : {}),
    ...(environment.TRACEY_WEB_OIDC_CLIENT_ID ? { clientId: environment.TRACEY_WEB_OIDC_CLIENT_ID } : {}),
    ...(environment.TRACEY_WEB_OIDC_CLIENT_SECRET ? { clientSecret: environment.TRACEY_WEB_OIDC_CLIENT_SECRET } : {}),
    ...(environment.OIDC_AUDIENCE ? { audience: environment.OIDC_AUDIENCE } : {}),
    ...(environment.TRACEY_WEB_SESSION_SECRET ? { sessionSecret: environment.TRACEY_WEB_SESSION_SECRET } : {}),
    ...(environment.TRACEY_WEB_PUBLIC_URL ? { publicUrl: new URL(environment.TRACEY_WEB_PUBLIC_URL).origin } : {}),
  };
  if (mode === "oidc") {
    if (!config.issuer || !config.clientId || !config.sessionSecret || config.sessionSecret.length < 32) {
      throw new Error("OIDC web login requires OIDC_ISSUER_URL, TRACEY_WEB_OIDC_CLIENT_ID, and TRACEY_WEB_SESSION_SECRET with at least 32 characters");
    }
  }
  return config;
}

let discoveryCache: { issuer: string; promise: Promise<z.infer<typeof DiscoverySchema>> } | undefined;

export async function oidcDiscovery(config: WebAuthConfig): Promise<z.infer<typeof DiscoverySchema>> {
  if (!config.issuer) throw new Error("OIDC issuer is not configured");
  if (discoveryCache?.issuer !== config.issuer) {
    const issuer = config.issuer;
    discoveryCache = {
      issuer,
      promise: fetch(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
        const metadata = DiscoverySchema.parse(await response.json());
        if (metadata.issuer.replace(/\/$/, "") !== issuer) throw new Error("OIDC discovery issuer does not match configuration");
        return metadata;
      }),
    };
  }
  return discoveryCache.promise;
}

function encryptionKey(secret: string): Uint8Array {
  return createHash("sha256").update(secret, "utf8").digest();
}

export async function seal(value: unknown, secret: string): Promise<string> {
  return new CompactEncrypt(Buffer.from(JSON.stringify(value), "utf8"))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(encryptionKey(secret));
}

export async function unseal<T>(value: string, secret: string, schema: z.ZodType<T>): Promise<T> {
  const { plaintext } = await compactDecrypt(value, encryptionKey(secret));
  return schema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function valuesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function callbackUrl(request: NextRequest, config: WebAuthConfig): string {
  return new URL("/api/auth/callback", config.publicUrl ?? request.nextUrl.origin).toString();
}

export function secureCookies(request: NextRequest, config: WebAuthConfig): boolean {
  return (config.publicUrl ? new URL(config.publicUrl).protocol : request.nextUrl.protocol) === "https:";
}

export function setSessionCookie(response: NextResponse, request: NextRequest, config: WebAuthConfig, value: string, session: WebSession): void {
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: secureCookies(request, config),
    sameSite: "lax",
    path: "/",
    maxAge: session.refreshToken ? 30 * 24 * 60 * 60 : Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1_000)),
  });
}

export function clearAuthCookies(response: NextResponse, request: NextRequest, config: WebAuthConfig): void {
  for (const name of [SESSION_COOKIE, LOGIN_ATTEMPT_COOKIE]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      secure: secureCookies(request, config),
      sameSite: "lax",
      path: "/",
      expires: new Date(0),
    });
  }
}

export async function newLoginAttempt(
  request: NextRequest,
  config: WebAuthConfig,
  returnTo: string,
): Promise<{ authorizationUrl: URL; cookie: string; attempt: z.infer<typeof LoginAttemptSchema> }> {
  const metadata = await oidcDiscovery(config);
  const attempt = LoginAttemptSchema.parse({
    state: randomUrlSafe(),
    nonce: randomUrlSafe(),
    codeVerifier: randomUrlSafe(64),
    redirectUri: callbackUrl(request, config),
    returnTo: safeReturnTo(returnTo),
  });
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId!);
  authorizationUrl.searchParams.set("redirect_uri", attempt.redirectUri);
  authorizationUrl.searchParams.set("scope", config.scopes);
  authorizationUrl.searchParams.set("state", attempt.state);
  authorizationUrl.searchParams.set("nonce", attempt.nonce);
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge(attempt.codeVerifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (config.audience) authorizationUrl.searchParams.set("audience", config.audience);
  return { authorizationUrl, cookie: await seal(attempt, config.sessionSecret!), attempt };
}

export async function exchangeAuthorizationCode(
  code: string,
  attemptCookie: string,
  state: string,
  config: WebAuthConfig,
): Promise<{ session: WebSession; returnTo: string }> {
  const attempt = await unseal(attemptCookie, config.sessionSecret!, LoginAttemptSchema);
  if (!valuesMatch(attempt.state, state)) throw new Error("OIDC state validation failed");
  const metadata = await oidcDiscovery(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId!,
    code,
    redirect_uri: attempt.redirectUri,
    code_verifier: attempt.codeVerifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC token exchange returned HTTP ${response.status}`);
  const tokens = TokenResponseSchema.parse(await response.json());
  if (!tokens.id_token) throw new Error("OIDC provider did not return an ID token");
  if (!config.issuer || !config.clientId) throw new Error("OIDC issuer or client ID is not configured");
  const { payload } = await jwtVerify(
    tokens.id_token,
    createRemoteJWKSet(new URL(metadata.jwks_uri)),
    { issuer: config.issuer, audience: config.clientId },
  );
  if (typeof payload.nonce !== "string" || !valuesMatch(payload.nonce, attempt.nonce)) {
    throw new Error("OIDC nonce validation failed");
  }
  if (!payload.sub) throw new Error("OIDC ID token has no subject");
  const rawRoles = payload[config.rolesClaim];
  const roles = (Array.isArray(rawRoles) ? rawRoles : typeof rawRoles === "string" ? rawRoles.split(/[ ,]+/) : [])
    .map(String)
    .filter(Boolean);
  const tenant = payload[config.tenantClaim];
  const session = WebSessionSchema.parse({
    subject: payload.sub,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof tenant === "string" ? { tenantId: tenant } : {}),
    roles,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: Date.now() + tokens.expires_in * 1_000,
    idToken: tokens.id_token,
  });
  return { session, returnTo: attempt.returnTo };
}

export async function readSession(value: string | undefined, config = webAuthConfig()): Promise<WebSession | undefined> {
  if (config.mode !== "oidc" || !value) return undefined;
  try {
    return await unseal(value, config.sessionSecret!, WebSessionSchema);
  } catch {
    return undefined;
  }
}

export async function refreshSession(session: WebSession, config: WebAuthConfig): Promise<WebSession> {
  if (!session.refreshToken) throw new Error("OIDC session expired and has no refresh token");
  const metadata = await oidcDiscovery(config);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId!,
    refresh_token: session.refreshToken,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC token refresh returned HTTP ${response.status}`);
  const tokens = TokenResponseSchema.parse(await response.json());
  return WebSessionSchema.parse({
    ...session,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1_000,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
  });
}

export async function accessTokenForRequest(
  request: NextRequest,
  config = webAuthConfig(),
): Promise<{ accessToken?: string; session?: WebSession; rotatedCookie?: string }> {
  if (config.mode === "local") {
    const accessToken = process.env.TRACEY_UI_ACCESS_TOKEN ?? process.env.TRACEY_API_BEARER_TOKEN;
    return accessToken ? { accessToken } : {};
  }
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value, config);
  if (!session) return {};
  if (session.expiresAt > Date.now() + 30_000) return { accessToken: session.accessToken, session };
  const refreshed = await refreshSession(session, config);
  return {
    accessToken: refreshed.accessToken,
    session: refreshed,
    rotatedCookie: await seal(refreshed, config.sessionSecret!),
  };
}
