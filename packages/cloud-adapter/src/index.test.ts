import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertKubernetesMutationScope, redactSensitiveText } from "./index.js";

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

describe("Kubernetes mutation scope", () => {
  it("rejects cluster-scoped mutations for the standard connector", () => {
    assert.throws(
      () => assertKubernetesMutationScope("*", "PersistentVolume"),
      /separately provisioned privileged connector/,
    );
  });

  it("allows non-identity cluster resources only for a privileged connector", () => {
    assert.doesNotThrow(
      () => assertKubernetesMutationScope("*", "PersistentVolume", true),
    );
  });

  it("never permits credential or identity boundaries", () => {
    for (const kind of ["Secret", "ServiceAccount", "RoleBinding", "ClusterRole"]) {
      assert.throws(
        () => assertKubernetesMutationScope("*", kind, true),
        /identity or credential boundaries/,
      );
    }
  });
});
