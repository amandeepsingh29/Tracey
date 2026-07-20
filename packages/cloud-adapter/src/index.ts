import * as k8s from "@kubernetes/client-node";
import { CloudActionSchema, KubernetesNameSchema, type CloudAction } from "@tracey/autonomy";
import { z } from "zod";

const TailLinesSchema = z.number().int().min(1).max(500);
const MAX_LOG_CHARACTERS = 20_000;
const secretPattern = /(authorization|bearer|token|api[-_]?key|password|secret|cookie)\s*[:=]\s*([^\s,;]+)/gi;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown Kubernetes API error";
}

export function redactSensitiveText(value: string): string {
  return value.replace(secretPattern, "$1=[REDACTED]").slice(0, MAX_LOG_CHARACTERS);
}

function labelsToSelector(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) throw new Error("workload has no selector labels");
  return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(",");
}

export interface PodStatus {
  name: string;
  namespace: string;
  phase: string;
  reason?: string;
  containers: Array<{ name: string; ready: boolean; restartCount: number; state: string }>;
}

export interface KubernetesAdapterOptions {
  allowedNamespaces?: string[];
  allowedWorkloads?: string[];
}

function buildScope(values: string[] | undefined): Set<string> | undefined {
  if (values === undefined || values.includes("*")) return undefined;
  return new Set(values.map((entry) => KubernetesNameSchema.parse(entry)));
}

export class KubernetesAdapter {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly autoscaling: k8s.AutoscalingV2Api;
  private readonly batch: k8s.BatchV1Api;
  private readonly networking: k8s.NetworkingV1Api;
  private readonly policy: k8s.PolicyV1Api;
  private readonly custom: k8s.CustomObjectsApi;
  private readonly objects: k8s.KubernetesObjectApi;
  private readonly allowedNamespaces: Set<string> | undefined;
  private readonly allowedWorkloads: Set<string> | undefined;

  constructor(options: KubernetesAdapterOptions = {}) {
    const config = new k8s.KubeConfig();
    config.loadFromDefault();
    this.core = config.makeApiClient(k8s.CoreV1Api);
    this.apps = config.makeApiClient(k8s.AppsV1Api);
    this.autoscaling = config.makeApiClient(k8s.AutoscalingV2Api);
    this.batch = config.makeApiClient(k8s.BatchV1Api);
    this.networking = config.makeApiClient(k8s.NetworkingV1Api);
    this.policy = config.makeApiClient(k8s.PolicyV1Api);
    this.custom = config.makeApiClient(k8s.CustomObjectsApi);
    this.objects = k8s.KubernetesObjectApi.makeApiClient(config);
    this.allowedNamespaces = buildScope(options.allowedNamespaces);
    this.allowedWorkloads = buildScope(options.allowedWorkloads);
  }

  private validateTarget(namespace: string, workload?: string): void {
    KubernetesNameSchema.parse(namespace);
    if (this.allowedNamespaces && !this.allowedNamespaces.has(namespace)) throw new Error(`namespace ${namespace} is outside the executor scope`);
    if (workload) {
      KubernetesNameSchema.parse(workload);
      if (this.allowedWorkloads && !this.allowedWorkloads.has(workload)) throw new Error(`workload ${workload} is outside the executor scope`);
    }
  }

  async checkAccess(namespace: string): Promise<void> {
    if (namespace === "*") {
      await this.core.listPodForAllNamespaces(undefined, undefined, undefined, undefined, 1);
      return;
    }
    this.validateTarget(namespace);
    await this.core.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, undefined, 1);
  }

  async checkMutationAccess(namespace: string): Promise<void> {
    if (namespace === "*") {
      await this.apps.listDeploymentForAllNamespaces(undefined, undefined, undefined, undefined, 1);
      return;
    }
    this.validateTarget(namespace);
    await this.apps.listNamespacedDeployment(namespace, undefined, undefined, undefined, undefined, undefined, 1);
  }

  async listPods(namespace: string): Promise<PodStatus[]> {
    this.validateTarget(namespace);
    try {
      const response = await this.core.listNamespacedPod(namespace);
      return response.body.items.map((pod) => this.normalizePod(pod, namespace));
    } catch (error) {
      throw new Error(`Failed to list pods: ${errorMessage(error)}`);
    }
  }

  async listNamespaces(): Promise<string[]> {
    if (this.allowedNamespaces) return [...this.allowedNamespaces].sort();
    try {
      const response = await this.core.listNamespace();
      return response.body.items
        .map((namespace) => namespace.metadata?.name)
        .filter((name): name is string => Boolean(name))
        .sort()
        .slice(0, 100);
    } catch (error) {
      throw new Error(`Failed to list namespaces: ${errorMessage(error)}`);
    }
  }

  async getPodStatus(namespace: string, podName: string): Promise<PodStatus> {
    this.validateTarget(namespace);
    KubernetesNameSchema.parse(podName);
    try {
      const response = await this.core.readNamespacedPod(podName, namespace);
      return this.normalizePod(response.body, namespace);
    } catch (error) {
      throw new Error(`Failed to get pod status: ${errorMessage(error)}`);
    }
  }

  async getContainerRestarts(namespace: string, podName: string): Promise<Record<string, unknown>> {
    const status = await this.getPodStatus(namespace, podName);
    return {
      podName: status.name,
      namespace: status.namespace,
      totalRestarts: status.containers.reduce((total, container) => total + container.restartCount, 0),
      containers: status.containers.map(({ name, restartCount, ready, state }) => ({ name, restartCount, ready, state })),
    };
  }

  async describePod(namespace: string, podName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace);
    KubernetesNameSchema.parse(podName);
    try {
      const { body: pod } = await this.core.readNamespacedPod(podName, namespace);
      return {
        status: this.normalizePod(pod, namespace),
        nodeName: pod.spec?.nodeName,
        serviceAccountName: pod.spec?.serviceAccountName,
        qosClass: pod.status?.qosClass,
        conditions: pod.status?.conditions?.map(({ type, status, reason, message }) => ({ type, status, reason, message: message ? redactSensitiveText(message) : undefined })),
        resources: pod.spec?.containers.map(({ name, resources }) => ({ name, requests: resources?.requests, limits: resources?.limits })),
      };
    } catch (error) {
      throw new Error(`Failed to describe pod: ${errorMessage(error)}`);
    }
  }

  async getPodLogs(namespace: string, podName: string, tailLines = 50): Promise<string> {
    this.validateTarget(namespace);
    KubernetesNameSchema.parse(podName);
    TailLinesSchema.parse(tailLines);
    try {
      const response = await this.core.readNamespacedPodLog(podName, namespace, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tailLines);
      return redactSensitiveText(String(response.body));
    } catch (error) {
      throw new Error(`Failed to get pod logs: ${errorMessage(error)}`);
    }
  }

  async getDeploymentConfig(namespace: string, deploymentName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace, deploymentName);
    try {
      const { body } = await this.apps.readNamespacedDeployment(deploymentName, namespace);
      return {
        name: body.metadata?.name,
        namespace: body.metadata?.namespace,
        replicas: body.spec?.replicas,
        strategy: body.spec?.strategy?.type,
        containers: body.spec?.template.spec?.containers.map((container) => ({
          name: container.name,
          image: container.image,
          resources: container.resources,
          environmentVariableNames: container.env?.map(({ name, valueFrom }) => ({ name, source: valueFrom ? "reference" : "literal-redacted" })) ?? [],
        })) ?? [],
      };
    } catch (error) {
      throw new Error(`Failed to get deployment config: ${errorMessage(error)}`);
    }
  }

  async getDeploymentRolloutStatus(namespace: string, deploymentName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace, deploymentName);
    const { body } = await this.apps.readNamespacedDeploymentStatus(deploymentName, namespace);
    const desired = body.spec?.replicas ?? 0;
    const ready = body.status?.readyReplicas ?? 0;
    return {
      desiredReplicas: desired,
      updatedReplicas: body.status?.updatedReplicas ?? 0,
      availableReplicas: body.status?.availableReplicas ?? 0,
      readyReplicas: ready,
      unavailableReplicas: body.status?.unavailableReplicas ?? 0,
      observedGeneration: body.status?.observedGeneration,
      ready: desired > 0 && ready === desired,
      conditions: body.status?.conditions?.map(({ type, status, reason, message }) => ({ type, status, reason, message: message ? redactSensitiveText(message) : undefined })) ?? [],
    };
  }

  async getReplicaSetHistory(namespace: string, deploymentName: string): Promise<Array<Record<string, unknown>>> {
    this.validateTarget(namespace, deploymentName);
    const { body: deployment } = await this.apps.readNamespacedDeployment(deploymentName, namespace);
    const selector = labelsToSelector(deployment.spec?.selector.matchLabels);
    const { body } = await this.apps.listNamespacedReplicaSet(namespace, undefined, undefined, undefined, undefined, selector);
    return body.items
      .filter((replicaSet) => replicaSet.metadata?.ownerReferences?.some(({ kind, name }) => kind === "Deployment" && name === deploymentName))
      .map((replicaSet) => ({
        name: replicaSet.metadata?.name,
        revision: Number(replicaSet.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
        replicas: replicaSet.spec?.replicas ?? 0,
        readyReplicas: replicaSet.status?.readyReplicas ?? 0,
        createdAt: replicaSet.metadata?.creationTimestamp,
        images: replicaSet.spec?.template?.spec?.containers.map(({ image }) => image),
      }))
      .sort((left, right) => Number(right.revision) - Number(left.revision));
  }

  async getEvents(namespace: string): Promise<Array<Record<string, unknown>>> {
    this.validateTarget(namespace);
    const response = await this.core.listNamespacedEvent(namespace);
    return response.body.items.map((event) => ({
      type: event.type,
      reason: event.reason,
      message: event.message ? redactSensitiveText(event.message) : undefined,
      object: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
      count: event.count,
      lastTimestamp: event.lastTimestamp,
    })).sort((left, right) => new Date(String(right.lastTimestamp ?? 0)).getTime() - new Date(String(left.lastTimestamp ?? 0)).getTime()).slice(0, 50);
  }

  async getResourceUsage(namespace: string, podName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace);
    KubernetesNameSchema.parse(podName);
    try {
      const response = await this.custom.getNamespacedCustomObject("metrics.k8s.io", "v1beta1", namespace, "pods", podName);
      const body = response.body as { timestamp?: string; window?: string; containers?: Array<{ name?: string; usage?: Record<string, string> }> };
      return { timestamp: body.timestamp, window: body.window, containers: body.containers?.map(({ name, usage }) => ({ name, usage })) ?? [] };
    } catch (error) {
      throw new Error(`Kubernetes metrics API is unavailable: ${errorMessage(error)}`);
    }
  }

  async getNodeHealth(): Promise<Array<Record<string, unknown>>> {
    const { body } = await this.core.listNode();
    return body.items.map((node) => ({
      name: node.metadata?.name,
      unschedulable: node.spec?.unschedulable ?? false,
      capacity: node.status?.capacity,
      allocatable: node.status?.allocatable,
      conditions: node.status?.conditions?.map(({ type, status, reason }) => ({ type, status, reason })) ?? [],
    }));
  }

  async getServiceEndpoints(namespace: string, serviceName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace, serviceName);
    const { body } = await this.core.readNamespacedEndpoints(serviceName, namespace);
    return {
      name: body.metadata?.name,
      subsets: body.subsets?.map(({ addresses, notReadyAddresses, ports }) => ({
        readyAddresses: addresses?.map(({ ip, hostname }) => ({ ip, hostname })) ?? [],
        notReadyAddresses: notReadyAddresses?.map(({ ip, hostname }) => ({ ip, hostname })) ?? [],
        ports: ports?.map(({ name, port, protocol }) => ({ name, port, protocol })) ?? [],
      })) ?? [],
    };
  }

  async getIngressStatus(namespace: string): Promise<Array<Record<string, unknown>>> {
    this.validateTarget(namespace);
    const { body } = await this.networking.listNamespacedIngress(namespace);
    return body.items.map((ingress) => ({
      name: ingress.metadata?.name,
      ingressClassName: ingress.spec?.ingressClassName,
      hosts: ingress.spec?.rules?.map(({ host }) => host) ?? [],
      loadBalancer: ingress.status?.loadBalancer?.ingress?.map(({ hostname, ip }) => ({ hostname, ip })) ?? [],
    }));
  }

  async getHpaStatus(namespace: string): Promise<Array<Record<string, unknown>>> {
    this.validateTarget(namespace);
    const { body } = await this.autoscaling.listNamespacedHorizontalPodAutoscaler(namespace);
    return body.items.map((hpa) => ({
      name: hpa.metadata?.name,
      target: hpa.spec?.scaleTargetRef,
      minReplicas: hpa.spec?.minReplicas,
      maxReplicas: hpa.spec?.maxReplicas,
      currentReplicas: hpa.status?.currentReplicas,
      desiredReplicas: hpa.status?.desiredReplicas,
      conditions: hpa.status?.conditions?.map(({ type, status, reason }) => ({ type, status, reason })) ?? [],
    }));
  }

  async getPdbStatus(namespace: string): Promise<Array<Record<string, unknown>>> {
    this.validateTarget(namespace);
    const { body } = await this.policy.listNamespacedPodDisruptionBudget(namespace);
    return body.items.map((budget) => ({
      name: budget.metadata?.name,
      minAvailable: budget.spec?.minAvailable,
      maxUnavailable: budget.spec?.maxUnavailable,
      currentHealthy: budget.status?.currentHealthy,
      desiredHealthy: budget.status?.desiredHealthy,
      disruptionsAllowed: budget.status?.disruptionsAllowed,
    }));
  }

  async getRecentChanges(namespace: string, deploymentName: string): Promise<Record<string, unknown>> {
    this.validateTarget(namespace, deploymentName);
    const [deployment, revisions, events] = await Promise.all([
      this.apps.readNamespacedDeployment(deploymentName, namespace),
      this.getReplicaSetHistory(namespace, deploymentName),
      this.getEvents(namespace),
    ]);
    return {
      deployment: deployment.body.metadata?.name,
      generation: deployment.body.metadata?.generation,
      observedGeneration: deployment.body.status?.observedGeneration,
      lastUpdatedAt: deployment.body.metadata?.managedFields
        ?.map(({ time }) => time)
        .filter(Boolean)
        .sort((left, right) => new Date(String(right)).getTime() - new Date(String(left)).getTime())[0],
      recentRevisions: revisions.slice(0, 10),
      relatedEvents: events.filter((event) => String(event.object ?? "").includes(deploymentName)).slice(0, 20),
    };
  }

  async execute(actionInput: CloudAction): Promise<Record<string, unknown>> {
    const action = CloudActionSchema.parse(actionInput);
    this.validateTarget(action.namespace, action.workload);
    switch (action.type) {
      case "restart_pod":
        return this.restartPod(action.namespace, action.workload);
      case "restart_workload":
        return this.restartWorkload(action.namespace, action.workload);
      case "rollback_deployment":
        return this.rollbackDeployment(action.namespace, action.workload, action.revision);
      case "scale_deployment":
        await this.apps.patchNamespacedDeployment(action.workload, action.namespace, [{ op: "replace", path: "/spec/replicas", value: action.replicas }], undefined, undefined, undefined, undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
        return { action: action.type, replicas: action.replicas, accepted: true };
      case "update_resource_limits":
        return this.updateResourceLimits(action);
      case "update_hpa":
        return this.updateHpa(action);
      case "retry_job":
        return this.retryJob(action.namespace, action.workload);
      case "suspend_cronjob":
      case "resume_cronjob":
        await this.batch.patchNamespacedCronJob(action.workload, action.namespace, [{ op: "add", path: "/spec/suspend", value: action.type === "suspend_cronjob" }], undefined, undefined, undefined, undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
        return { action: action.type, accepted: true };
      case "apply_config_patch":
        return this.applyDeploymentConfigPatch(action);
      case "restore_previous_config":
        return this.rollbackDeployment(action.namespace, action.workload);
      case "apply_kubernetes_resource":
        return this.applyKubernetesResource(action);
      case "patch_kubernetes_resource":
        return this.patchKubernetesResource(action);
      case "delete_kubernetes_resource":
        return this.deleteKubernetesResource(action);
    }
  }

  async getResourceIdentity(input: {
    apiVersion: string;
    kind: string;
    namespace: string;
    workload: string;
  }): Promise<Record<string, unknown> | undefined> {
    this.validateGenericTarget(input.namespace, input.workload, input.kind);
    try {
      const { body } = await this.objects.read(this.objectHeader(input));
      return {
        apiVersion: body.apiVersion,
        kind: body.kind,
        name: body.metadata?.name,
        namespace: body.metadata?.namespace,
        uid: body.metadata?.uid,
        resourceVersion: body.metadata?.resourceVersion,
        generation: body.metadata?.generation,
      };
    } catch (error) {
      if (this.statusCode(error) === 404) return undefined;
      throw new Error(`Failed to read Kubernetes resource: ${errorMessage(error)}`);
    }
  }

  private validateGenericTarget(namespace: string, workload: string, kind: string): void {
    this.validateTarget(namespace === "*" ? "default" : namespace, workload);
    const protectedKinds = new Set(["Secret", "Namespace", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
    if (protectedKinds.has(kind)) throw new Error(`${kind} resources are identity or credential boundaries and cannot be mutated by Tracey`);
  }

  private objectHeader(input: { apiVersion: string; kind: string; namespace: string; workload: string }): k8s.KubernetesObject & { metadata: { name: string; namespace: string } } {
    return {
      apiVersion: input.apiVersion,
      kind: input.kind,
      metadata: {
        name: input.workload,
        namespace: input.namespace === "*" ? "default" : input.namespace,
      },
    };
  }

  private objectMutationHeader(input: { apiVersion: string; kind: string; namespace: string; workload: string }): k8s.KubernetesObject {
    return {
      apiVersion: input.apiVersion,
      kind: input.kind,
      metadata: {
        name: input.workload,
        ...(input.namespace === "*" ? {} : { namespace: input.namespace }),
      },
    };
  }

  private async applyKubernetesResource(action: Extract<CloudAction, { type: "apply_kubernetes_resource" }>): Promise<Record<string, unknown>> {
    this.validateGenericTarget(action.namespace, action.workload, action.kind);
    const spec = {
      ...action.manifest,
      ...this.objectMutationHeader(action),
      metadata: {
        ...((action.manifest.metadata && typeof action.manifest.metadata === "object") ? action.manifest.metadata as Record<string, unknown> : {}),
        ...this.objectMutationHeader(action).metadata,
      },
    } as k8s.KubernetesObject;
    const { body } = await this.objects.patch(spec, undefined, undefined, "tracey-executor", true, {
      headers: { "Content-Type": "application/apply-patch+yaml" },
    });
    return { action: action.type, accepted: true, resource: this.resourceReceipt(body) };
  }

  private async patchKubernetesResource(action: Extract<CloudAction, { type: "patch_kubernetes_resource" }>): Promise<Record<string, unknown>> {
    this.validateGenericTarget(action.namespace, action.workload, action.kind);
    const spec = {
      ...action.patch,
      ...this.objectMutationHeader(action),
      metadata: {
        ...((action.patch.metadata && typeof action.patch.metadata === "object") ? action.patch.metadata as Record<string, unknown> : {}),
        ...this.objectMutationHeader(action).metadata,
      },
    } as k8s.KubernetesObject;
    const { body } = await this.objects.patch(spec, undefined, undefined, "tracey-executor", undefined, {
      headers: { "Content-Type": "application/merge-patch+json" },
    });
    return { action: action.type, accepted: true, resource: this.resourceReceipt(body) };
  }

  private async deleteKubernetesResource(action: Extract<CloudAction, { type: "delete_kubernetes_resource" }>): Promise<Record<string, unknown>> {
    this.validateGenericTarget(action.namespace, action.workload, action.kind);
    const before = await this.getResourceIdentity(action);
    if (!before) return { action: action.type, accepted: true, alreadyAbsent: true };
    await this.objects.delete(this.objectMutationHeader(action), undefined, undefined, 30, undefined, action.propagationPolicy);
    return { action: action.type, accepted: true, deleted: before };
  }

  private resourceReceipt(body: k8s.KubernetesObject): Record<string, unknown> {
    return {
      apiVersion: body.apiVersion,
      kind: body.kind,
      name: body.metadata?.name,
      namespace: body.metadata?.namespace,
      uid: body.metadata?.uid,
      resourceVersion: body.metadata?.resourceVersion,
      generation: body.metadata?.generation,
    };
  }

  private statusCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as { statusCode?: unknown; response?: { statusCode?: unknown } };
    const value = candidate.statusCode ?? candidate.response?.statusCode;
    return typeof value === "number" ? value : undefined;
  }

  private normalizePod(pod: k8s.V1Pod, namespace: string): PodStatus {
    const statuses = new Map(pod.status?.containerStatuses?.map((status) => [status.name, status]) ?? []);
    const reason = pod.status?.reason ?? pod.status?.containerStatuses?.find(({ state }) => state?.waiting?.reason || state?.terminated?.reason)?.state?.waiting?.reason;
    return {
      name: pod.metadata?.name ?? "unknown",
      namespace: pod.metadata?.namespace ?? namespace,
      phase: pod.status?.phase ?? "Unknown",
      ...(reason ? { reason } : {}),
      containers: pod.spec?.containers.map(({ name }) => {
        const status = statuses.get(name);
        const state = status?.state?.waiting ? "waiting" : status?.state?.running ? "running" : status?.state?.terminated ? "terminated" : "unknown";
        return { name, ready: status?.ready ?? false, restartCount: status?.restartCount ?? 0, state };
      }) ?? [],
    };
  }

  private async restartWorkload(namespace: string, deploymentName: string): Promise<Record<string, unknown>> {
    const { body } = await this.apps.readNamespacedDeployment(deploymentName, namespace);
    await this.apps.patchNamespacedDeployment(deploymentName, namespace, [{
      op: "add", path: "/spec/template/metadata/annotations", value: {
        ...(body.spec?.template.metadata?.annotations ?? {}),
        "tracey.dev/restartedAt": new Date().toISOString(),
      },
    }], undefined, undefined, "tracey-executor", undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
    return { action: "restart_workload", accepted: true };
  }

  private async restartPod(namespace: string, podName: string): Promise<Record<string, unknown>> {
    const { body: pod } = await this.core.readNamespacedPod(podName, namespace);
    const controller = pod.metadata?.ownerReferences?.find(({ controller }) => controller === true);
    if (!controller) throw new Error(`pod ${podName} is unmanaged; refusing a restart that Kubernetes cannot replace`);
    await this.core.deleteNamespacedPod(podName, namespace, undefined, undefined, 30);
    return { action: "restart_pod", podName, controller: { kind: controller.kind, name: controller.name }, accepted: true };
  }

  private async rollbackDeployment(namespace: string, deploymentName: string, requestedRevision?: number): Promise<Record<string, unknown>> {
    const { body: deployment } = await this.apps.readNamespacedDeployment(deploymentName, namespace);
    const selector = labelsToSelector(deployment.spec?.selector.matchLabels);
    const { body } = await this.apps.listNamespacedReplicaSet(namespace, undefined, undefined, undefined, undefined, selector);
    const history = body.items
      .filter((replicaSet) => replicaSet.metadata?.ownerReferences?.some(({ kind, name }) => kind === "Deployment" && name === deploymentName))
      .map((replicaSet) => ({ replicaSet, revision: Number(replicaSet.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0) }))
      .filter(({ revision }) => revision > 0)
      .sort((left, right) => right.revision - left.revision);
    const currentRevision = history[0]?.revision;
    const target = requestedRevision ? history.find(({ revision }) => revision === requestedRevision) : history.find(({ revision }) => revision < (currentRevision ?? 0));
    if (!target?.replicaSet.spec?.template) throw new Error("no eligible previous ReplicaSet revision exists");
    await this.apps.patchNamespacedDeployment(deploymentName, namespace, [{ op: "replace", path: "/spec/template", value: target.replicaSet.spec.template }], undefined, undefined, "tracey-executor", undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
    return { action: "rollback_deployment", fromRevision: currentRevision, toRevision: target.revision, accepted: true };
  }

  private async updateResourceLimits(action: Extract<CloudAction, { type: "update_resource_limits" }>): Promise<Record<string, unknown>> {
    const { body } = await this.apps.readNamespacedDeployment(action.workload, action.namespace);
    const index = body.spec?.template.spec?.containers.findIndex(({ name }) => name === action.container) ?? -1;
    if (index < 0) throw new Error(`container ${action.container} does not exist`);
    const patches = [
      ...(action.memory ? [{ op: "add", path: `/spec/template/spec/containers/${index}/resources/limits/memory`, value: action.memory }] : []),
      ...(action.cpu ? [{ op: "add", path: `/spec/template/spec/containers/${index}/resources/limits/cpu`, value: action.cpu }] : []),
    ];
    await this.apps.patchNamespacedDeployment(action.workload, action.namespace, patches, undefined, undefined, "tracey-executor", undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
    return { action: action.type, accepted: true };
  }

  private async updateHpa(action: Extract<CloudAction, { type: "update_hpa" }>): Promise<Record<string, unknown>> {
    await this.autoscaling.patchNamespacedHorizontalPodAutoscaler(action.workload, action.namespace, [
      { op: "add", path: "/spec/minReplicas", value: action.minReplicas },
      { op: "replace", path: "/spec/maxReplicas", value: action.maxReplicas },
    ], undefined, undefined, "tracey-executor", undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
    return { action: action.type, accepted: true };
  }

  private async applyDeploymentConfigPatch(action: Extract<CloudAction, { type: "apply_config_patch" }>): Promise<Record<string, unknown>> {
    const patches = [
      ...(action.patch.minReadySeconds === undefined ? [] : [{ op: "add", path: "/spec/minReadySeconds", value: action.patch.minReadySeconds }]),
      ...(action.patch.progressDeadlineSeconds === undefined ? [] : [{ op: "add", path: "/spec/progressDeadlineSeconds", value: action.patch.progressDeadlineSeconds }]),
      ...(action.patch.revisionHistoryLimit === undefined ? [] : [{ op: "add", path: "/spec/revisionHistoryLimit", value: action.patch.revisionHistoryLimit }]),
      ...(action.patch.maxUnavailable === undefined ? [] : [{ op: "add", path: "/spec/strategy/rollingUpdate/maxUnavailable", value: action.patch.maxUnavailable }]),
      ...(action.patch.maxSurge === undefined ? [] : [{ op: "add", path: "/spec/strategy/rollingUpdate/maxSurge", value: action.patch.maxSurge }]),
    ];
    await this.apps.patchNamespacedDeployment(action.workload, action.namespace, patches, undefined, undefined, "tracey-executor", undefined, undefined, { headers: { "Content-Type": "application/json-patch+json" } });
    return { action: action.type, changedFields: Object.keys(action.patch).sort(), accepted: true };
  }

  private async retryJob(namespace: string, jobName: string): Promise<Record<string, unknown>> {
    const { body } = await this.batch.readNamespacedJob(jobName, namespace);
    if (!body.spec?.template) throw new Error("job has no pod template");
    const retryName = `${jobName}-retry-${Date.now().toString(36)}`.slice(0, 63).replace(/-$/, "");
    const retry = new k8s.V1Job();
    retry.metadata = { name: retryName, namespace, labels: { "tracey.dev/retry-of": jobName } };
    const retrySpec = { ...body.spec };
    delete retrySpec.selector;
    retry.spec = { ...retrySpec, template: { ...body.spec.template, metadata: { labels: { "tracey.dev/retry-of": jobName } } } };
    await this.batch.createNamespacedJob(namespace, retry);
    return { action: "retry_job", jobName: retryName, accepted: true };
  }
}
