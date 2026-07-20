import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { classifyDefaultToolError, instrumentModelCall, instrumentToolCall } from "./operations.js";

describe("custom-agent instrumentation", () => {
  it("classifies actual timeout failures without inspecting tool payloads", () => {
    assert.equal(classifyDefaultToolError(new Error("upstream timed out after 5s")), "timeout");
    assert.equal(classifyDefaultToolError(new Error("connection reset")), "upstream_error");
  });

  it("emits a real tool span and preserves the operation result", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);

    const value = await instrumentToolCall(
      {
        toolName: "customer.lookup",
        transport: "http",
        sideEffect: "read",
      },
      async () => ({ customerId: "opaque-id" }),
    );
    await provider.forceFlush();

    assert.deepEqual(value, { customerId: "opaque-id" });
    const finished = exporter.getFinishedSpans();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.name, "execute_tool customer.lookup");
    assert.equal(finished[0]?.attributes["tracey.tool.result.class"], "success");
    assert.equal(finished[0]?.attributes["gen_ai.tool.call.arguments"], undefined);

    const modelValue = await instrumentModelCall(
      { providerName: "openai", requestModel: "gpt-5-mini", operationName: "chat" },
      async () => ({
        value: "real-provider-output",
        telemetry: {
          responseId: "resp_observed",
          responseModel: "gpt-5-mini-2025-08-07",
          inputTokens: 1_000,
          cachedInputTokens: 400,
          outputTokens: 200,
          reasoningOutputTokens: 10,
        },
      }),
    );
    await provider.forceFlush();
    assert.equal(modelValue, "real-provider-output");
    const modelSpan = exporter.getFinishedSpans().find(({ name }) => name === "chat gpt-5-mini");
    assert.equal(modelSpan?.attributes["tracey.cost.attribution"], "exact");
    assert.equal(modelSpan?.attributes["tracey.cost.nano_usd"], 560_000);
    assert.equal(modelSpan?.attributes["tracey.cost.usd"], 0.00056);
    assert.equal(modelSpan?.attributes["gen_ai.usage.cached_input_tokens"], 400);
    await provider.shutdown();
  });
});
