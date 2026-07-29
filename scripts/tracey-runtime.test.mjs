import assert from "node:assert/strict";
import test from "node:test";
import { executorConfigured, localDatabase, localPostgresEnvironment, parsePort } from "./tracey-runtime.mjs";

test("runtime port parsing is bounded and deterministic", () => {
  assert.equal(parsePort(undefined, 3000), 3000);
  assert.equal(parsePort("3100", 3000), 3100);
  assert.throws(() => parsePort("0", 3000), /Invalid port/);
  assert.throws(() => parsePort("not-a-port", 3000), /Invalid port/);
});

test("runtime starts PostgreSQL only for local database URLs", () => {
  assert.equal(localDatabase("postgresql://tracey:x@127.0.0.1:5432/tracey"), true);
  assert.equal(localDatabase("postgresql://tracey:x@localhost:5432/tracey"), true);
  assert.equal(localDatabase("postgresql://tracey:x@db.example.com:5432/tracey"), false);
});

test("local PostgreSQL initialization matches DATABASE_URL credentials", () => {
  assert.deepEqual(
    localPostgresEnvironment("postgresql://tracey_app:secret%20value@127.0.0.1:5432/tracey"),
    { TRACEY_POSTGRES_USER: "tracey_app", TRACEY_POSTGRES_DB: "tracey", POSTGRES_PASSWORD: "secret value" },
  );
  assert.throws(() => localPostgresEnvironment("postgresql://tracey_app@127.0.0.1:5432/tracey"), /must include/);
});

test("executor requires explicit enablement, authentication and scopes", () => {
  const complete = {
    TRACEY_KUBERNETES_EXECUTOR_ENABLED: "true",
    TRACEY_EXECUTOR_BEARER_TOKEN: "x".repeat(32),
    TRACEY_KUBERNETES_ALLOWED_NAMESPACES: "production",
    TRACEY_KUBERNETES_ALLOWED_WORKLOADS: "notes-api",
  };
  assert.equal(executorConfigured(complete), true);
  assert.equal(executorConfigured({ ...complete, TRACEY_KUBERNETES_EXECUTOR_ENABLED: "false" }), false);
  assert.equal(executorConfigured({ ...complete, TRACEY_EXECUTOR_BEARER_TOKEN: "short" }), false);
  assert.equal(executorConfigured({ ...complete, TRACEY_KUBERNETES_ALLOWED_WORKLOADS: "" }), false);
});
