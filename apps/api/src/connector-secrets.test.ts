import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectorSecretVault } from "./connector-secrets.js";

describe("connector secret vault", () => {
  it("encrypts authenticated secret payloads without retaining plaintext", () => {
    const vault = new ConnectorSecretVault("test-material-that-is-long-enough");
    const encrypted = vault.encrypt({ apiKey: "sensitive-value" });
    assert.equal(encrypted.includes("sensitive-value"), false);
    assert.deepEqual(vault.decrypt(encrypted), { apiKey: "sensitive-value" });
    const parts = encrypted.split(".");
    const ciphertext = parts[3] ?? "";
    parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    assert.throws(() => vault.decrypt(parts.join(".")));
  });
});
