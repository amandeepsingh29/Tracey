import assert from "node:assert/strict";

const baseUrl = (process.env.TRACEY_UI_URL ?? "http://127.0.0.1:8501").replace(/\/$/, "");

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers }, signal: AbortSignal.timeout(130_000) });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  return { response, payload };
}

async function expectOk(path, init) {
  const result = await request(path, init);
  assert.equal(result.response.ok, true, `${path} returned HTTP ${result.response.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

for (const path of ["/", "/onboarding", "/agents", "/runs", "/incidents", "/investigations", "/changes", "/connectors", "/policies", "/notifs", "/settings", "/healthz"]) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.ok, true, `${path} did not render`);
}

const [health, connectors, agents] = await Promise.all([
  expectOk("/api/tracey/health"),
  expectOk("/api/tracey/v1/connectors"),
  expectOk("/api/tracey/v1/agents?limit=100"),
]);
assert.equal(health.status, "ok");
assert.equal(connectors.secretStorageAvailable, true);
assert.ok(connectors.connectors.some((connector) => connector.id === "signoz" && connector.state === "ready"), "SigNoz is not ready");
assert.ok(connectors.connectors.some((connector) => connector.id === "kubernetes" && connector.state === "ready"), "Kubernetes is not ready");
assert.ok(agents.agents.length > 0, "No registered agent is available");

await expectOk("/api/tracey/v1/connectors/kubernetes/test", {
  method: "POST",
  body: JSON.stringify({ investigatorEnabled: true, executorEnabled: false, allowedNamespaces: ["default"], allowedWorkloads: [] }),
});

const observedAgent = agents.agents.find((agent) => !["codex_desktop", "codex_cli"].includes(agent.producerType));
assert.ok(observedAgent, "No OpenTelemetry agent is available for run verification");
const now = Date.now();
const runs = await expectOk(`/api/tracey/v1/agents/${observedAgent.agentId}/runs?start=${now - 7 * 86_400_000}&end=${now}&limit=20`);
assert.ok(runs.runs.length > 0, "No real agent run was observed in the last seven days");
const observedRun = runs.runs[0];
const observedAt = new Date(observedRun.startedAt ?? observedRun.startTime).getTime();
assert.ok(Number.isFinite(observedAt), "Observed run does not contain a valid start time");

const investigation = await expectOk("/api/tracey/v1/investigations", {
  method: "POST",
  body: JSON.stringify({ title: `[E2E] Investigate observed run ${String(observedRun.traceId).slice(0, 12)}` }),
});
const traceStart = observedAt - 300_000;
const traceEnd = observedAt + 3_600_000;
const message = await expectOk(`/api/tracey/v1/investigations/${investigation.sessionId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content: `Analyze trace ${observedRun.traceId} between epoch milliseconds ${traceStart} and ${traceEnd}. Report only observed status, latency, tool calls, failures, and missing evidence. Use investigate_trace and cite returned trace evidence.` }),
});
assert.equal(message.grounding, "evidence_bound", `Investigation was not evidence-bound: ${message.grounding}`);
assert.ok(message.evidenceRefs.length > 0, "Investigation returned no evidence references");
const persistedMessages = await expectOk(`/api/tracey/v1/investigations/${investigation.sessionId}/messages`);
const persistedAssistant = persistedMessages.messages.at(-1);
assert.equal(persistedAssistant.grounding, "evidence_bound", "Grounding was not durable after chat completion");
assert.equal(persistedAssistant.evidenceRefs.length, message.evidenceRefs.length, "Persisted evidence references changed");
const followUp = await expectOk(`/api/tracey/v1/investigations/${investigation.sessionId}/messages`, {
  method: "POST",
  body: JSON.stringify({ content: "Using the evidence already gathered, state only the most important missing evidence or say that none was observed. Keep all technical claims evidence-bound." }),
});
assert.equal(followUp.role, "assistant");
const conversation = await expectOk(`/api/tracey/v1/investigations/${investigation.sessionId}/messages`);
assert.equal(conversation.messages.length, 4, "Follow-up conversation state was not preserved");

const proposal = await expectOk("/api/tracey/v1/actions", {
  method: "POST",
  body: JSON.stringify({ sessionId: investigation.sessionId, actionType: "ticket", target: "frontend-e2e", reason: "Verify approval enforcement without mutating infrastructure", parameters: { source: "frontend-e2e" }, risk: "low" }),
});
const unapproved = await request(`/api/tracey/v1/actions/${proposal.proposalId}/execute`, { method: "POST", body: "{}" });
assert.equal(unapproved.response.status, 409, "An unapproved action was executable");
const rejected = await expectOk(`/api/tracey/v1/actions/${proposal.proposalId}/decision`, { method: "POST", body: JSON.stringify({ decision: "rejected" }) });
assert.equal(rejected.status, "rejected");

console.log(JSON.stringify({
  status: "passed",
  renderedRoutes: 12,
  connectors: { signoz: "ready", kubernetes: "permission_verified" },
  registeredAgents: agents.agents.length,
  observedRun: { agentId: observedAgent.agentId, traceId: observedRun.traceId },
  investigation: { sessionId: investigation.sessionId, grounding: message.grounding, evidenceRefs: message.evidenceRefs.length, followUpPreserved: true },
  approvalBoundary: "unapproved execution rejected",
}, null, 2));
