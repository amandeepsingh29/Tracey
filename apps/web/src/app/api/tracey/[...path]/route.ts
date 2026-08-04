import { NextRequest, NextResponse } from "next/server";
import {
  accessTokenForRequest,
  setSessionCookie,
  webAuthConfig,
} from "../../../../server/oidc";

export const dynamic = "force-dynamic";
const methodsWithBody = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Kubernetes and other deployments set TRACEY_API_URL explicitly. Falling
  // back to loopback keeps a local production build connected after restart.
  const baseUrl = (process.env.TRACEY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const authConfig = webAuthConfig();
  let auth;
  try {
    auth = await accessTokenForRequest(request, authConfig);
  } catch {
    return NextResponse.json(
      { error: "Your Tracey session has expired", loginUrl: `/api/auth/login?returnTo=${encodeURIComponent(request.nextUrl.pathname)}` },
      { status: 401 },
    );
  }
  if (authConfig.mode === "oidc" && !auth.accessToken) {
    return NextResponse.json(
      { error: "Sign in to access Tracey", loginUrl: `/api/auth/login?returnTo=${encodeURIComponent(request.nextUrl.pathname)}` },
      { status: 401 },
    );
  }
  const target = new URL(`${baseUrl}/${path.join("/")}`);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  const controller = new AbortController();
  // Agentic investigations may legitimately make several bounded tool calls.
  // Keep the UI proxy above the API's 120 second maximum agent timeout so a
  // completed investigation is never presented as an unreachable API.
  const timeout = setTimeout(() => controller.abort(), 125_000);
  try {
    const body = methodsWithBody.has(request.method) ? await request.text() : "";
    const hasBody = body.length > 0;
    const response = await fetch(target, {
      method: request.method,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: request.headers.get("accept") ?? "application/json",
        ...(hasBody ? { "content-type": request.headers.get("content-type") ?? "application/json" } : {}),
        ...(auth.accessToken ? { authorization: `Bearer ${auth.accessToken}` } : {}),
      },
      ...(hasBody ? { body } : {}),
    });
    const proxied = new NextResponse(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" },
    });
    if (auth.rotatedCookie && auth.session) {
      setSessionCookie(proxied, request, authConfig, auth.rotatedCookie, auth.session);
    }
    return proxied;
  } catch (error) {
    return NextResponse.json({ error: "Tracey API is currently unreachable", retryable: true, errorType: error instanceof Error ? error.name : "UnknownError" }, { status: 502 });
  } finally { clearTimeout(timeout); }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
