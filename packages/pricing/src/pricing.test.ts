import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateModelCost } from "./pricing.js";

describe("versioned provider pricing", () => {
  it("attributes uncached input, cached input, and output exactly in nano-USD", () => {
    const cost = calculateModelCost({
      provider: "openai",
      model: "gpt-5-mini-2025-08-07",
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
    });

    assert.equal(cost.status, "exact");
    if (cost.status !== "exact") return;
    assert.equal(cost.uncachedInputTokens, 600);
    assert.equal(cost.inputCostNanoUsd, 150_000);
    assert.equal(cost.cachedInputCostNanoUsd, 10_000);
    assert.equal(cost.outputCostNanoUsd, 400_000);
    assert.equal(cost.totalCostNanoUsd, 560_000);
    assert.equal(cost.totalCostUsd, 0.00056);
  });

  it("refuses estimates for unknown models or inconsistent usage", () => {
    assert.equal(calculateModelCost({
      provider: "openai",
      model: "unknown-model",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
    }).status, "unresolved");
    const invalid = calculateModelCost({
      provider: "openai",
      model: "gpt-5-mini",
      inputTokens: 1,
      cachedInputTokens: 2,
      outputTokens: 1,
    });
    assert.equal(invalid.status, "unresolved");
    if (invalid.status === "unresolved") assert.equal(invalid.reason, "invalid_usage");
  });

  it("attributes embedding input without inventing output or cache rates", () => {
    const cost = calculateModelCost({
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 250,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    assert.equal(cost.status, "exact");
    if (cost.status === "exact") assert.equal(cost.totalCostNanoUsd, 5_000);
  });
});
