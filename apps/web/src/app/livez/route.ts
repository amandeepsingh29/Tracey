export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { status: "alive", component: "tracey-web" },
    { headers: { "cache-control": "no-store" } },
  );
}
