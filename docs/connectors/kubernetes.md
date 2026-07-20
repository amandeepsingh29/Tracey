# Kubernetes connector

The Kubernetes connector has two identities:

- The investigator is read-only and can be configured for selected namespaces or cluster-wide discovery.
- The authenticated executor accepts only durable, policy-approved actions and can be scoped by namespace/workload or configured for broad cluster operation.

The executor supports purpose-built restart, rollback, scale, HPA, Job, CronJob, resource-limit, and rollout operations. It also supports generic server-side apply, merge-patch, and delete for permitted Kubernetes resource kinds. Generic operations always enter `awaiting_approval`, even under an autopilot policy, and execute only after a separate admin confirmation.

There is no arbitrary shell or pod-exec path. Secrets, service accounts, RBAC roles/bindings, and namespaces remain outside executor authorization. The LLM can prepare a remediation plan but cannot call Kubernetes mutations directly.

External application namespaces may label themselves `tracey.ai/telemetry-export=enabled` to reach the Tracey Collector. This label opens only the OTLP network path. It does not grant Tracey Kubernetes API access.

To enable investigation or remediation for an external workload, an operator must separately install scoped RBAC, configure `TRACEY_KUBERNETES_ALLOWED_NAMESPACES` and `TRACEY_KUBERNETES_ALLOWED_WORKLOADS`, configure the investigator or executor endpoint, and create an explicit Tracey policy.
