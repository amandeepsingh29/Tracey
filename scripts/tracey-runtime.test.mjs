import assert from "node:assert/strict";
import test from "node:test";
import {
  executorConfigured,
  localDatabase,
  localApplicationDatabaseUrl,
  localPostgresEnvironment,
  parsePort,
  runtimeId,
} from "./tracey-runtime.mjs";

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
    {
      TRACEY_POSTGRES_USER: "tracey_app",
      TRACEY_POSTGRES_DB: "tracey",
      TRACEY_POSTGRES_PORT: "5432",
      POSTGRES_PASSWORD: "secret value",
    },
  );
  assert.throws(() => localPostgresEnvironment("postgresql://tracey_app@127.0.0.1:5432/tracey"), /must include/);
});

test("runtime IDs create isolated, bounded Compose project names", () => {
  assert.equal(runtimeId("Clean Install 42"), "clean-install-42");
  assert.throws(() => runtimeId(""));
  assert.throws(() => runtimeId("x".repeat(49)));
});

test("local services use a non-superuser application role", () => {
  const parsed = new URL(localApplicationDatabaseUrl(
    "postgresql://tracey_admin:admin-secret@127.0.0.1:5432/tracey",
    "app-secret",
  ));
  assert.equal(parsed.username, "tracey_admin_app");
  assert.equal(parsed.password, "app-secret");
  assert.equal(parsed.pathname, "/tracey");
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
