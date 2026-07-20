# Instrument a custom Node agent

`@tracey/instrumentation` wraps real application operations. It does not provide model responses, retrieval results, or tool outputs. The caller executes its existing provider and dependency clients and returns measured usage metadata to the wrapper.

Model telemetry should include provider-reported cached input and reasoning-output counts when available. Tracey resolves cost only when the exact response model exists in the versioned catalog; see [pricing.md](pricing.md).

## Agent and model call

```ts
import { createHash, randomUUID } from "node:crypto";
import { instrumentModelCall, withAgentRun } from "@tracey/instrumentation";

const runId = `run_${randomUUID()}`;
const inputHash = `sha256:${createHash("sha256").update(userInput).digest("hex")}`;

const run = await withAgentRun(
  {
    runId,
    agentName: "your-agent",
    agentVersion: process.env.AGENT_VERSION ?? "unknown",
    tenantId: process.env.TRACEY_TENANT_ID ?? "local",
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "development",
    inputHash,
  },
  async () => instrumentModelCall(
    {
      providerName: "openai",
      requestModel: configuredModel,
      promptName: "support-answer",
      promptVersion: activePromptVersion,
      operationName: "chat",
    },
    async () => {
      const response = await yourModelClient.generate(userInput);
      return {
        value: response.output,
        telemetry: {
          responseId: response.id,
          responseModel: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      };
    },
  ),
);
```

Prompt and output content are not accepted by the instrumentation API. Only hashes, versions, usage, and bounded routing metadata are exported.

## Real tool call

```ts
const customer = await instrumentToolCall(
  {
    toolName: "crm.lookup_customer",
    toolVersion: process.env.CRM_CLIENT_VERSION,
    transport: "http",
    sideEffect: "read",
    timeoutMs: 5_000,
  },
  () => crmClient.lookupCustomer(customerId),
);
```

Tool arguments and results are never added to span attributes. Errors are rethrown after the span records their type, status, duration, and result class.

## Real retrieval

```ts
const documents = await instrumentRetrieval(
  {
    retrieverName: "policy-search",
    retrieverVersion: process.env.RETRIEVER_VERSION,
    corpusVersion: activeCorpusVersion,
    queryHash,
    topK: 8,
  },
  async () => {
    const results = await vectorStore.search(queryVector, { limit: 8 });
    return {
      value: results,
      telemetry: {
        resultCount: results.length,
        maxScore: results[0]?.score,
        minScore: results.at(-1)?.score,
        permissionFilterApplied: true,
      },
    };
  },
);
```

The wrapper records counts and scores, not document text. An empty real result increments `tracey.agent.retrieval.empty`.

## Tool-selection decisions

Wrap the application decision that actually selects a tool. `evaluation` is optional and must come from a deterministic routing policy or labeled evaluator; Tracey does not infer the expected tool from private model reasoning.

```ts
const selectedTool = await instrumentAgentDecision(
  {
    decisionType: "select_tool",
    selected: routerSelection,
    policy: "support-routing@7",
    candidateCount: availableTools.length,
    evaluation: {
      expected: labeledExpectedTool,
      correct: routerSelection === labeledExpectedTool,
    },
  },
  async () => routerSelection,
);
```

## Feedback after a run

Submit feedback to `POST /v1/feedback` using the `runId`, `traceId`, and root `spanId` created by the production agent's instrumentation. Tracey exports a correlated OTel log and `tracey.agent.feedback` metric. Optional external references are SHA-256 hashed before export.

TODO: Publish `@tracey/instrumentation` as a versioned package after the telemetry contract receives live SigNoz verification. It is currently a functional workspace package, but publishing an unverified public API would create a compatibility promise before the deployed schema is proven.
