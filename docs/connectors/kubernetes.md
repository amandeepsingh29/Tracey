# Kubernetes connector

The Kubernetes connector has two default identities:

- The investigator is read-only and can be configured for selected namespaces or cluster-wide discovery.
- The authenticated executor accepts only durable, policy-approved actions. Its default Kubernetes `Role` is restricted to Tracey's own namespace.

The executor supports purpose-built restart, rollback, scale, HPA, Job, CronJob, resource-limit, and rollout operations. It also supports generic server-side apply, merge-patch, and delete for permitted Kubernetes resource kinds. Generic operations always enter `awaiting_approval`, even under an autopilot policy, and execute only after a separate admin confirmation.

There is no arbitrary shell or pod-exec path. Secrets, service accounts, RBAC roles/bindings, and namespaces remain outside executor authorization. The LLM can prepare a remediation plan but cannot call Kubernetes mutations directly.

External application namespaces may label themselves `tracey.ai/telemetry-export=enabled` to reach the Tracey Collector. This label opens only the OTLP network path. It does not grant Tracey Kubernetes API access.

To enable investigation or remediation for an external workload, an operator must separately install scoped RBAC, configure `TRACEY_KUBERNETES_ALLOWED_NAMESPACES` and `TRACEY_KUBERNETES_ALLOWED_WORKLOADS`, configure the investigator or executor endpoint, and create an explicit Tracey policy.

## Add a target namespace

Grant the existing executor access to one additional namespace:

```bash
./scripts/provision-kubernetes-executor.sh namespace customer-production production
```

The first namespace is the workload namespace. The second is the namespace where Tracey's `tracey-executor` ServiceAccount runs. The command installs only a `Role` and `RoleBinding` in the target namespace; it never creates cluster-wide access. Add the same target namespace to `TRACEY_KUBERNETES_ALLOWED_NAMESPACES` and restart the executor after reviewing the generated permissions.

## Privileged connector

Cluster-wide mutation is a separate, explicit connector deployment:

```bash
./scripts/provision-kubernetes-executor.sh privileged production \
  ghcr.io/amandeepsingh29/tracey-executor:0.1.0
```

This installs a distinct `tracey-privileged-executor` ServiceAccount, ClusterRole, Deployment, and Service. It does not modify the default executor's Role. The privileged Deployment explicitly sets `TRACEY_KUBERNETES_ALLOW_CLUSTER_SCOPED_MUTATIONS=true`; the standard executor defaults to `false` and rejects `namespace: "*"` actions even if its ServiceAccount were accidentally over-permissioned.

After reviewing the privileged ClusterRole, point `TRACEY_EXECUTOR_URL` at:

```text
http://tracey-privileged-executor-service.production.svc:3002
```

Only one executor endpoint should be active for a Tracey API instance. Identity and credential boundaries remain blocked in application code even for the privileged connector: Secrets, namespaces, service accounts, Roles, RoleBindings, ClusterRoles, and ClusterRoleBindings cannot be mutated.
