export async function webReadinessResponse(): Promise<Response> {
  const baseUrl = (process.env.TRACEY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/ready`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    return Response.json({
      status: response.ok ? "ready" : "not_ready",
      component: "tracey-web",
      dependencies: { api: response.ok ? "ready" : "unavailable" },
    }, {
      status: response.ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({
      status: "not_ready",
      component: "tracey-web",
      dependencies: { api: "unavailable" },
    }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
