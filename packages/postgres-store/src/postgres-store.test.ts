import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresStore, PostgresStoreError } from "./postgres-store.js";

describe("PostgreSQL control-plane store", () => {
  it("rejects non-PostgreSQL connection schemes", () => {
    assert.throws(
      () => new PostgresStore({ connectionString: "https://database.invalid" }),
      PostgresStoreError,
    );
  });

  it("rejects incompatible embeddings before opening a database connection", async () => {
    const store = new PostgresStore({ connectionString: "postgresql://tracey:secret@127.0.0.1:1/tracey" });
    await assert.rejects(
      store.indexDiagnosis("tenant-a", {
        agentId: "019f697a-67d9-7a20-8956-98b8bb9fe7ed",
        traceId: "a".repeat(32),
        runId: "run-1",
        summary: "Evidence-bound summary",
        diagnosis: {},
        evidenceRefs: [],
        embedding: [1],
      }),
      /exactly 1536/,
    );
    await store.close();
  });
});
