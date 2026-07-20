import "dotenv/config";

const apiUrl = (process.env.TRACEY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiToken = process.env.TRACEY_API_TOKEN;
const conversationId = process.env.TRACEY_CODEX_CONVERSATION_ID;
const serviceName = process.env.TRACEY_CODEX_SERVICE_NAME ?? "codex-app-server";
const start = Number(process.env.TRACEY_CODEX_START);
const end = Number(process.env.TRACEY_CODEX_END);

if (!apiToken) throw new Error("TRACEY_API_TOKEN is required");
if (!conversationId) throw new Error("TRACEY_CODEX_CONVERSATION_ID is required");
if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) {
  throw new Error("TRACEY_CODEX_START and TRACEY_CODEX_END must define the exact live capture window");
}

const url = new URL(`${apiUrl}/v1/signoz/codex/conversations/${conversationId}`);
url.searchParams.set("start", String(start));
url.searchParams.set("end", String(end));
url.searchParams.set("limit", "5000");
url.searchParams.set("serviceName", serviceName);
const response = await fetch(url, {
  headers: { authorization: `Bearer ${apiToken}` },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Live Codex normalization failed with HTTP ${response.status}: ${await response.text()}`);
}
const result = await response.json();
if (
  result.conversationId !== conversationId ||
  result.normalizationVersion !== "codex-otel-0.144@1" ||
  !Array.isArray(result.runs) ||
  result.runs.length === 0
) {
  throw new Error("Tracey returned an invalid Codex conversation contract");
}
for (const run of result.runs) {
  if (!Array.isArray(run.spans) || run.spans[0]?.name !== "agent.run") {
    throw new Error(`Normalized run ${run.runId ?? "unknown"} has no root agent.run span`);
  }
  const forbiddenAttributeKeys = new Set([
    "prompt",
    "output",
    "arguments",
    "result",
    "command",
    "user.email",
    "user.account_id",
    "host.name",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
  ]);
  const exposed = run.spans.flatMap((span) =>
    Object.keys(span.attributes ?? {}).filter((key) => forbiddenAttributeKeys.has(key)),
  );
  if (exposed.length > 0) {
    throw new Error(`Normalized run ${run.runId} contains forbidden content attributes: ${[...new Set(exposed)].join(", ")}`);
  }
}

const spans = result.runs.flatMap((run) => run.spans);
const toolSpans = spans.filter((span) => span.attributes?.["gen_ai.operation.name"] === "execute_tool");
const statusCounts = Object.fromEntries(
  [...new Set(result.runs.map((run) => run.status))].sort().map((status) => [
    status,
    result.runs.filter((run) => run.status === status).length,
  ]),
);
process.stdout.write(`${JSON.stringify({
  verification: "passed",
  conversationId: result.conversationId,
  serviceName,
  normalizationVersion: result.normalizationVersion,
  runCount: result.runs.length,
  statusCounts,
  spanCount: spans.length,
  toolSpanCount: toolSpans.length,
  observedToolFailureCount: toolSpans.filter((span) => span.hasError).length,
  rejectedLogs: result.rejectedLogs,
  query: result.query,
  privacy: {
    contentCapture: "none",
    forbiddenAttributeKeysPresent: [],
  },
}, null, 2)}\n`);
