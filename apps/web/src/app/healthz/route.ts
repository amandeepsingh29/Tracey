export const dynamic = "force-dynamic";
export function GET() { return Response.json({ status: "ok", component: "tracey-web" }, { headers: { "cache-control": "no-store" } }); }
