import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const methodsWithBody = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Kubernetes and other deployments set TRACEY_API_URL explicitly. Falling
  // back to loopback keeps a local production build connected after restart.
  const baseUrl = (process.env.TRACEY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const accessToken = process.env.TRACEY_UI_ACCESS_TOKEN ?? process.env.TRACEY_API_BEARER_TOKEN;
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
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(hasBody ? { body } : {}),
    });
    return new NextResponse(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: "Tracey API is currently unreachable", retryable: true, errorType: error instanceof Error ? error.name : "UnknownError" }, { status: 502 });
  } finally { clearTimeout(timeout); }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
