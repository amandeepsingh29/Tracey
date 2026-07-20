import { z } from "zod";

export const AutonomyModeSchema = z.enum([
  "observe",
  "recommend",
  "approval",
  "guarded_autopilot",
  "full_autopilot",
]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const ActionRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type ActionRisk = z.infer<typeof ActionRiskSchema>;

export const KubernetesNameSchema = z.string().trim().min(1).max(253).regex(
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
  "must be a valid lowercase Kubernetes resource name",
);
export const KubernetesScopeSchema = z.union([z.literal("*"), KubernetesNameSchema]);
const ContainerNameSchema = z.string().trim().min(1).max(63).regex(
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/,
  "must be a valid container name",
);
const baseTarget = {
  namespace: KubernetesNameSchema,
  workload: KubernetesNameSchema,
};

const KubernetesApiVersionSchema = z.string().trim().min(1).max(128).regex(
  /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?v[0-9][a-z0-9]*$/,
  "must be a valid Kubernetes apiVersion",
);
const KubernetesKindSchema = z.string().trim().min(1).max(128).regex(
  /^[A-Z][A-Za-z0-9]*$/,
  "must be a valid Kubernetes kind",
);
const KubernetesObjectPatchSchema = z.record(z.string(), z.unknown()).refine(
  (patch) => Object.keys(patch).length > 0,
  "patch must contain at least one field",
);

export const CloudActionTypeSchema = z.enum([
  "restart_pod", "restart_workload", "rollback_deployment", "scale_deployment", "update_resource_limits",
  "update_hpa", "retry_job", "suspend_cronjob", "resume_cronjob", "apply_config_patch",
  "restore_previous_config", "apply_kubernetes_resource", "patch_kubernetes_resource",
  "delete_kubernetes_resource",
]);

export const CloudActionSchema = z.union([
  z.object({ type: z.literal("restart_pod"), ...baseTarget }),
  z.object({ type: z.literal("restart_workload"), ...baseTarget }),
  z.object({
    type: z.literal("rollback_deployment"), ...baseTarget,
    revision: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("scale_deployment"), ...baseTarget,
    replicas: z.number().int().min(1).max(1_000),
  }),
  z.object({
    type: z.literal("update_resource_limits"), ...baseTarget,
    container: ContainerNameSchema,
    memory: z.string().regex(/^\d+(?:Mi|Gi)$/).optional(),
    cpu: z.string().regex(/^\d+(?:m)?$/).optional(),
  }).refine(({ memory, cpu }) => Boolean(memory || cpu), "memory or cpu is required"),
  z.object({
    type: z.literal("update_hpa"), ...baseTarget,
    minReplicas: z.number().int().min(1).max(1_000),
    maxReplicas: z.number().int().min(1).max(1_000),
  }).refine(({ minReplicas, maxReplicas }) => minReplicas <= maxReplicas, "minReplicas must not exceed maxReplicas"),
  z.object({ type: z.literal("retry_job"), namespace: KubernetesNameSchema, workload: KubernetesNameSchema }),
  z.object({ type: z.literal("suspend_cronjob"), namespace: KubernetesNameSchema, workload: KubernetesNameSchema }),
  z.object({ type: z.literal("resume_cronjob"), namespace: KubernetesNameSchema, workload: KubernetesNameSchema }),
  z.object({
    type: z.literal("apply_config_patch"), ...baseTarget,
    patch: z.object({
      minReadySeconds: z.number().int().min(0).max(3_600).optional(),
      progressDeadlineSeconds: z.number().int().min(60).max(3_600).optional(),
      revisionHistoryLimit: z.number().int().min(1).max(20).optional(),
      maxUnavailable: z.union([z.number().int().min(0).max(100), z.string().regex(/^\d{1,3}%$/)]).optional(),
      maxSurge: z.union([z.number().int().min(0).max(100), z.string().regex(/^\d{1,3}%$/)]).optional(),
    }).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), "at least one rollout setting is required"),
  }),
  z.object({ type: z.literal("restore_previous_config"), ...baseTarget }),
  z.object({
    type: z.literal("apply_kubernetes_resource"),
    namespace: KubernetesScopeSchema,
    workload: KubernetesNameSchema,
    apiVersion: KubernetesApiVersionSchema,
    kind: KubernetesKindSchema,
    manifest: KubernetesObjectPatchSchema,
  }),
  z.object({
    type: z.literal("patch_kubernetes_resource"),
    namespace: KubernetesScopeSchema,
    workload: KubernetesNameSchema,
    apiVersion: KubernetesApiVersionSchema,
    kind: KubernetesKindSchema,
    patch: KubernetesObjectPatchSchema,
  }),
  z.object({
    type: z.literal("delete_kubernetes_resource"),
    namespace: KubernetesScopeSchema,
    workload: KubernetesNameSchema,
    apiVersion: KubernetesApiVersionSchema,
    kind: KubernetesKindSchema,
    propagationPolicy: z.enum(["Foreground", "Background", "Orphan"]).default("Foreground"),
  }),
]);
export type CloudAction = z.infer<typeof CloudActionSchema>;
export type CloudActionType = CloudAction["type"];

export const RemediationPlanSchema = z.object({
  action: CloudActionSchema,
  summary: z.string().trim().min(1).max(2_000),
  reason: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
  risk: ActionRiskSchema,
  reversible: z.boolean(),
  expectedImpact: z.string().trim().min(1).max(2_000),
  blastRadius: z.object({
    workloads: z.number().int().min(1).max(100),
    estimatedUnavailableReplicas: z.number().int().min(0).max(10_000),
  }),
  evidenceRefs: z.array(z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), spanId: z.string().regex(/^[a-fA-F0-9]{16}$/).optional() })).max(100),
  verification: z.object({
    serviceName: z.string().trim().min(1).max(128),
    timeoutSeconds: z.number().int().min(10).max(3_600),
    lookbackSeconds: z.number().int().min(30).max(3_600).default(300),
    minimumSampleCount: z.number().int().min(1).max(1_000).default(5),
    settleSeconds: z.number().int().min(0).max(300).default(5),
    requireWorkloadReady: z.boolean().default(true),
    maxErrorRateIncrease: z.number().min(0).max(1).default(0),
    maxLatencyIncreasePercent: z.number().min(0).max(1_000).default(10),
  }),
  rollback: z.object({ action: CloudActionSchema, automatic: z.boolean() }).optional(),
});
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;

export const AutonomyPolicySchema = z.object({
  mode: AutonomyModeSchema.default("guarded_autopilot"),
  environments: z.array(z.string().trim().min(1).max(128)).min(1),
  namespaces: z.array(KubernetesScopeSchema).min(1),
  workloads: z.array(KubernetesScopeSchema).min(1),
  allowedActions: z.array(CloudActionTypeSchema).default([]),
  automaticActions: z.array(CloudActionTypeSchema).default([]),
  prohibitedActions: z.array(z.string().min(1).max(100)).default([
    "read_secrets", "delete_namespace", "delete_database", "arbitrary_shell",
  ]),
  minimumConfidence: z.number().min(0).max(1).default(0.9),
  maximumAutomaticRisk: ActionRiskSchema.default("medium"),
  maxReplicas: z.number().int().min(1).max(1_000).default(20),
  maxAffectedWorkloads: z.number().int().min(1).max(100).default(1),
  maxUnavailableReplicas: z.number().int().min(0).max(10_000).default(1),
  maxConcurrentActions: z.number().int().min(1).max(100).default(1),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(15),
  maintenanceWindow: z.object({ startHourUtc: z.number().int().min(0).max(23), endHourUtc: z.number().int().min(0).max(23) }).optional(),
});
export type AutonomyPolicy = z.infer<typeof AutonomyPolicySchema>;

export type PolicyDecisionType = "deny" | "recommend" | "require_approval" | "auto_execute";
export interface PolicyDecision {
  decision: PolicyDecisionType;
  reasons: string[];
  evaluatedAt: string;
}

const riskRank: Record<ActionRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const confirmationOnlyActions = new Set<CloudActionType>([
  "apply_kubernetes_resource", "patch_kubernetes_resource", "delete_kubernetes_resource",
]);

function inMaintenanceWindow(policy: AutonomyPolicy, now: Date): boolean {
  if (!policy.maintenanceWindow) return true;
  const hour = now.getUTCHours();
  const { startHourUtc: start, endHourUtc: end } = policy.maintenanceWindow;
  return start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end);
}

export function evaluatePolicy(input: {
  policy: AutonomyPolicy;
  plan: RemediationPlan;
  environment: string;
  actorRoles: string[];
  activeActionCount: number;
  lastActionAt?: Date;
  now?: Date;
}): PolicyDecision {
  const policy = AutonomyPolicySchema.parse(input.policy);
  const plan = RemediationPlanSchema.parse(input.plan);
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const actionType = plan.action.type;

  if (policy.prohibitedActions.includes(actionType)) reasons.push(`action ${actionType} is prohibited`);
  if (!policy.environments.includes(input.environment)) reasons.push(`environment ${input.environment} is outside policy scope`);
  if (!policy.namespaces.includes("*") && !policy.namespaces.includes(plan.action.namespace)) reasons.push(`namespace ${plan.action.namespace} is outside policy scope`);
  if (!policy.workloads.includes("*") && !policy.workloads.includes(plan.action.workload)) reasons.push(`workload ${plan.action.workload} is outside policy scope`);
  if (!policy.allowedActions.includes(actionType)) reasons.push(`action ${actionType} is not allowlisted`);
  if (!input.actorRoles.some((role) => ["analyst", "operator", "admin"].includes(role))) reasons.push("analyst, operator, or admin role is required");
  if (actionType === "scale_deployment" && plan.action.replicas > policy.maxReplicas) reasons.push(`replica target exceeds limit ${policy.maxReplicas}`);
  if (plan.blastRadius.workloads > policy.maxAffectedWorkloads) reasons.push(`blast radius exceeds ${policy.maxAffectedWorkloads} workload(s)`);
  if (plan.blastRadius.estimatedUnavailableReplicas > policy.maxUnavailableReplicas) reasons.push(`estimated unavailable replicas exceed limit ${policy.maxUnavailableReplicas}`);
  if (reasons.length > 0) return { decision: "deny", reasons, evaluatedAt: now.toISOString() };
  if (policy.mode === "observe") return { decision: "deny", reasons: ["observe mode prohibits mutations"], evaluatedAt: now.toISOString() };
  if (policy.mode === "recommend") return { decision: "recommend", reasons: ["recommend mode produces plans without execution"], evaluatedAt: now.toISOString() };
  if (policy.mode === "approval") return { decision: "require_approval", reasons: ["approval mode requires an administrator decision"], evaluatedAt: now.toISOString() };
  if (confirmationOnlyActions.has(actionType)) {
    return { decision: "require_approval", reasons: ["generic Kubernetes mutations always require explicit administrator confirmation"], evaluatedAt: now.toISOString() };
  }
  if (!input.actorRoles.some((role) => role === "operator" || role === "admin")) {
    return { decision: "require_approval", reasons: ["operator or admin role is required for automatic execution"], evaluatedAt: now.toISOString() };
  }

  const runtimeReasons = [
    ...(input.activeActionCount >= policy.maxConcurrentActions ? ["concurrent action limit reached"] : []),
    ...(input.lastActionAt && now.getTime() - input.lastActionAt.getTime() < policy.cooldownMinutes * 60_000 ? ["action cooldown is active"] : []),
    ...(!inMaintenanceWindow(policy, now) ? ["outside maintenance window"] : []),
  ];
  if (runtimeReasons.length > 0) {
    return { decision: "require_approval", reasons: runtimeReasons, evaluatedAt: now.toISOString() };
  }

  const automatic = policy.automaticActions.includes(actionType);
  const confidenceMet = plan.confidence >= policy.minimumConfidence;
  const riskAllowed = riskRank[plan.risk] <= riskRank[policy.maximumAutomaticRisk];
  const verificationReady = plan.verification.serviceName.length > 0 && plan.verification.minimumSampleCount > 0;
  if (policy.mode === "guarded_autopilot" && (!automatic || !plan.reversible || !confidenceMet || !riskAllowed || !verificationReady)) {
    return {
      decision: "require_approval",
      reasons: [
        ...(!automatic ? ["action is not allowlisted for automatic execution"] : []),
        ...(!plan.reversible ? ["action is not reversible"] : []),
        ...(!confidenceMet ? [`confidence is below ${policy.minimumConfidence}`] : []),
        ...(!riskAllowed ? [`risk exceeds ${policy.maximumAutomaticRisk}`] : []),
        ...(!verificationReady ? ["verification plan is incomplete"] : []),
      ],
      evaluatedAt: now.toISOString(),
    };
  }

  return { decision: "auto_execute", reasons: [`${policy.mode} policy permits execution`], evaluatedAt: now.toISOString() };
}

export const failClosedGuardedPolicy: AutonomyPolicy = AutonomyPolicySchema.parse({
  mode: "guarded_autopilot",
  environments: ["production"],
  namespaces: ["tracey-unconfigured"],
  workloads: ["tracey-unconfigured"],
  allowedActions: [],
  automaticActions: [],
});
