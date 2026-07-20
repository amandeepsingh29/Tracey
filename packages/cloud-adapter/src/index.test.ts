import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSensitiveText } from "./index.js";

describe("Kubernetes evidence privacy", () => {
  it("redacts common credential forms from logs", () => {
    const safe = redactSensitiveText("authorization: Bearer-value token=abc password: hunter2 normal=visible");
    assert.doesNotMatch(safe, /Bearer-value|abc|hunter2/);
    assert.match(safe, /normal=visible/);
  });

  it("bounds external log content", () => {
    assert.equal(redactSensitiveText("x".repeat(30_000)).length, 20_000);
  });
});
