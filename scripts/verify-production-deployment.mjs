import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { parseAllDocuments } from "yaml";

const root = new URL("../", import.meta.url);
const overlay = new URL("../infra/k8s/overlays/production", import.meta.url);
const requiredDeployments = ["otel-collector", "tracey-api", "tracey-executor", "tracey-ui", "tracey-worker"];
const traceyImages = ["api", "executor", "ui", "worker"].map(
  (name) => `ghcr.io/amandeepsingh29/tracey-${name}:0.1.0`,
);

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function documents(source) {
  return parseAllDocuments(source)
    .map((document) => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON();
    })
    .filter(Boolean);
}

function requireContainerHardening(deployment) {
  const name = deployment.metadata.name;
  assert.ok(Number(deployment.spec.replicas) >= 2, `${name} must run at least two replicas`);
  assert.equal(deployment.spec.template.spec.securityContext?.runAsNonRoot, true, `${name} must run as non-root`);
  for (const container of deployment.spec.template.spec.containers ?? []) {
    assert.ok(container.readinessProbe, `${name}/${container.name} needs a readiness probe`);
    assert.ok(container.livenessProbe, `${name}/${container.name} needs a liveness probe`);
    assert.ok(container.resources?.requests?.cpu, `${name}/${container.name} needs a CPU request`);
    assert.ok(container.resources?.requests?.memory, `${name}/${container.name} needs a memory request`);
    assert.ok(container.resources?.limits?.cpu, `${name}/${container.name} needs a CPU limit`);
    assert.ok(container.resources?.limits?.memory, `${name}/${container.name} needs a memory limit`);
    assert.equal(container.securityContext?.allowPrivilegeEscalation, false, `${name}/${container.name} permits privilege escalation`);
    assert.equal(container.securityContext?.readOnlyRootFilesystem, true, `${name}/${container.name} needs a read-only root filesystem`);
    assert.deepEqual(container.securityContext?.capabilities?.drop, ["ALL"], `${name}/${container.name} must drop Linux capabilities`);
    assert.ok(!container.image.endsWith(":latest"), `${name}/${container.name} uses a mutable latest tag`);
  }
}

function verifyReleasePipeline() {
  const workflow = readFileSync(new URL("../.github/workflows/release-images.yml", import.meta.url), "utf8");
  for (const image of ["api", "ui", "worker", "executor", "migrations"]) {
    assert.match(workflow, new RegExp(`name: ${image}\\b`), `release workflow omits ${image}`);
  }
  assert.match(workflow, /cosign sign --yes/, "release workflow must sign image digests");
  assert.match(workflow, /sbom: true/, "release workflow must publish an SBOM");
  readFileSync(new URL("../Dockerfile.migrations", import.meta.url), "utf8");
}

function verifyStaticManifest() {
  const rendered = run("kubectl", ["kustomize", overlay.pathname]);
  assert.doesNotMatch(rendered, /registry\.example\.com|example\.invalid|:latest\b/, "production manifest contains a placeholder or mutable image");
  const resources = documents(rendered);
  const deployments = resources.filter(({ kind }) => kind === "Deployment");
  assert.deepEqual(
    deployments.map(({ metadata }) => metadata.name).sort(),
    requiredDeployments,
    "production overlay must contain the complete Tracey runtime",
  );
  deployments.forEach(requireContainerHardening);

  const images = deployments.flatMap((deployment) =>
    deployment.spec.template.spec.containers.map(({ image }) => image),
  );
  for (const image of traceyImages) assert.ok(images.includes(image), `production image missing: ${image}`);

  const pdbNames = resources
    .filter(({ kind }) => kind === "PodDisruptionBudget")
    .map(({ metadata }) => metadata.name);
  for (const name of requiredDeployments) assert.ok(pdbNames.includes(name), `missing disruption budget for ${name}`);

  const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
  assert.ok(policies.length >= 5, "production overlay must include ingress isolation policies");
  assert.ok(policies.some(({ metadata }) => metadata.name === "tracey-default-deny-ingress"), "default deny ingress policy missing");

  const clusterRoles = resources.filter(({ kind }) => kind === "ClusterRole");
  for (const role of clusterRoles) {
    for (const rule of role.rules ?? []) {
      assert.ok(!(rule.resources ?? []).includes("secrets"), `${role.metadata.name} must not read or mutate Kubernetes Secrets`);
    }
  }

  verifyReleasePipeline();
  return { resources: resources.length, deployments: deployments.length, policies: policies.length };
}

async function verifyLiveDeployment() {
  const publicUrl = process.env.TRACEY_PRODUCTION_URL;
  if (!publicUrl) return { status: "not-run", reason: "TRACEY_PRODUCTION_URL is not configured" };
  const url = new URL(publicUrl);
  assert.equal(url.protocol, "https:", "production verification requires HTTPS");

  const namespace = process.env.TRACEY_PRODUCTION_NAMESPACE ?? "production";
  const healthResponse = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(10_000) });
  assert.equal(healthResponse.ok, true, `public UI health returned HTTP ${healthResponse.status}`);

  const payload = JSON.parse(run("kubectl", ["get", "deployment", "-n", namespace, "-o", "json"]));
  const byName = new Map(payload.items.map((item) => [item.metadata.name, item]));
  for (const name of requiredDeployments) {
    const deployment = byName.get(name);
    assert.ok(deployment, `live cluster is missing deployment/${name}`);
    assert.equal(deployment.status.observedGeneration, deployment.metadata.generation, `${name} has not observed its latest generation`);
    assert.equal(deployment.status.readyReplicas, deployment.spec.replicas, `${name} is not fully ready`);
    assert.equal(deployment.status.unavailableReplicas ?? 0, 0, `${name} has unavailable replicas`);
  }
  return { status: "passed", namespace, publicUrl: url.origin, deployments: requiredDeployments.length };
}

const staticResult = verifyStaticManifest();
const liveResult = await verifyLiveDeployment();
console.log(JSON.stringify({ static: { status: "passed", ...staticResult }, live: liveResult }, null, 2));
