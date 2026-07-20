import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const methodsWithBody = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const baseUrl = (process.env.TRACEY_API_URL ?? "http://tracey-api-service:3000").replace(/\/$/, "");
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
        ...(process.env.TRACEY_UI_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.TRACEY_UI_ACCESS_TOKEN}` } : {}),
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
