import "dotenv/config";

const apiUrl = (process.env.TRACEY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const toolName = process.env.MCP_VERIFY_TOOL;
const argumentsJson = process.env.MCP_VERIFY_ARGUMENTS_JSON;
const apiToken = process.env.TRACEY_API_BEARER_TOKEN;

if (!apiToken) {
  throw new Error("TRACEY_API_BEARER_TOKEN is required to verify protected Tracey API routes");
}
const authorization = { authorization: `Bearer ${apiToken}` };

const discoveryResponse = await fetch(`${apiUrl}/v1/mcp/tools`, {
  headers: authorization,
  signal: AbortSignal.timeout(15_000),
});
if (!discoveryResponse.ok) {
  throw new Error(
    `Real MCP discovery failed with HTTP ${discoveryResponse.status}: ${await discoveryResponse.text()}`,
  );
}
const discovery = await discoveryResponse.json();
if (!Array.isArray(discovery.tools)) {
  throw new Error("MCP discovery response did not contain a tools array");
}

if (!toolName) {
  process.stdout.write(`${JSON.stringify(discovery, null, 2)}\n`);
  process.stdout.write("Discovery verified. Set MCP_VERIFY_TOOL and MCP_VERIFY_ARGUMENTS_JSON to verify a real call.\n");
  process.exit(0);
}
if (argumentsJson === undefined) {
  throw new Error("MCP_VERIFY_ARGUMENTS_JSON is required when MCP_VERIFY_TOOL is set");
}

let toolArguments;
try {
  toolArguments = JSON.parse(argumentsJson);
} catch (error) {
  throw new Error(`MCP_VERIFY_ARGUMENTS_JSON must be valid JSON: ${error instanceof Error ? error.message : error}`);
}
if (!toolArguments || Array.isArray(toolArguments) || typeof toolArguments !== "object") {
  throw new Error("MCP_VERIFY_ARGUMENTS_JSON must decode to a JSON object");
}

const advertised = discovery.tools.find((tool) => tool.name === toolName);
if (!advertised) throw new Error(`The configured server did not advertise ${toolName}`);
if (!advertised.allowed) throw new Error(`${toolName} is not callable: ${advertised.denialReason ?? "policy denied"}`);

const callResponse = await fetch(`${apiUrl}/v1/mcp/call`, {
  method: "POST",
  headers: { "content-type": "application/json", ...authorization },
  body: JSON.stringify({ toolName, arguments: toolArguments }),
  signal: AbortSignal.timeout(125_000),
});
if (!callResponse.ok) {
  throw new Error(`Real MCP call failed with HTTP ${callResponse.status}: ${await callResponse.text()}`);
}

process.stdout.write(
  `${JSON.stringify({
    server: discovery.server,
    toolName,
    discoveredToolCount: discovery.tools.length,
    call: await callResponse.json(),
  }, null, 2)}\n`,
);
