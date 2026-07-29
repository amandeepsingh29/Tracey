import type { AgentProducerType } from "@tracey/domain";
import type { InvestigationService } from "@tracey/investigation";
import type { ActionProposal, InvestigationMessage, PostgresStore } from "@tracey/postgres-store";
import { KubernetesAdapter } from "@tracey/cloud-adapter";
import { KubernetesNameSchema, RemediationPlanSchema } from "@tracey/autonomy";
import type { AutonomyService } from "./autonomy-service.js";
import { compareServiceHealth } from "./action-executor.js";
import { z } from "zod";

const ChatInputSchema = z.string().trim().min(1).max(8_000);
const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS = 12;
const MAX_TOOL_RESULT_CHARS = 80_000;
const INCOMPLETE_ACTION_PROMISE = /\b(?:please hold on|let me (?:try|check|gather|look|continue)|i(?:'ll| will) (?:try|check|gather|look|continue)|to proceed,?\s+i will need|please confirm (?:if |whether )?you (?:would like|want) to proceed)\b/i;
const EXPLICIT_ACTION_CONFIRMATION = /^(?:yes(?:[,\s]+(?:please\s+)?(?:proceed|confirm|execute|do it))?|proceed|confirm(?:ed)?|approve(?:\s+and\s+execute)?|execute(?:\s+it)?|do it)[.!]?$/i;
const EXPLICIT_MUTATION_REQUEST = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+(?:you|tracey)\s+to\s+|go\s+ahead\s+(?:and\s+)?)?(?:restart|roll\s*back|rollback|scale|delete|patch|apply|update|change|retry|suspend|resume)\b/i;
const OBSERVABILITY_VERIFIED_ACTIONS = new Set([
  "restart_workload",
  "rollback_deployment",
  "scale_deployment",
  "update_resource_limits",
  "restore_previous_config",
]);
const ServiceWindowObject = z.object({
  serviceName: z.string().trim().min(1).max(128),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
const ServiceWindowSchema = ServiceWindowObject.refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000, "invalid or excessive time range");
const BeforeAfterObject = z.object({
  serviceName: z.string().trim().min(1).max(128),
  beforeStart: z.number().int().nonnegative(), beforeEnd: z.number().int().positive(),
  afterStart: z.number().int().nonnegative(), afterEnd: z.number().int().positive(),
});
const validComparisonWindows = ({ beforeStart, beforeEnd, afterStart, afterEnd }: z.infer<typeof BeforeAfterObject>) =>
  beforeStart < beforeEnd && afterStart < afterEnd &&
  beforeEnd - beforeStart <= 7 * 86_400_000 && afterEnd - afterStart <= 7 * 86_400_000;
const BeforeAfterSchema = BeforeAfterObject.refine(validComparisonWindows, "invalid or excessive comparison windows");

export type EvidenceRef = {
  traceId?: string;
  spanId?: string;
  sourceType?: "kubernetes" | "signoz" | "tracey";
  sourceId?: string;
  observation?: string;
  signal?: string;
};
type ModelMessage = Record<string, unknown> & { role: string; content?: unknown };
export interface AgenticActorContext { subject: string; roles: string[] }

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ApplicationIdentity = {
  agentId: string;
  displayName: string;
  serviceName: string;
  environment: string;
  status: string;
  producerType: string;
};

type ApplicationPod = {
  name: string;
  namespace: string;
  phase: string;
  containers: Array<{ ready: boolean; restartCount: number }>;
};

const identityStopWords = new Set([
  "a", "an", "app", "application", "are", "is", "live", "running", "service",
  "status", "the", "up", "agent", "api",
]);

function identityTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !identityStopWords.has(token));
}

export function resolveApplicationStatus(query: string, agents: ApplicationIdentity[], pods: ApplicationPod[]) {
  const requested = new Set(identityTokens(query));
  const registryMatches = agents
    .map((agent) => {
      const tokens = new Set(identityTokens(`${agent.displayName} ${agent.serviceName}`));
      const score = [...requested].filter((token) => tokens.has(token)).length;
      return { agent, tokens, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ agent, tokens }) => ({ agent, tokens }));
  const workloadTokens = new Set(registryMatches.flatMap(({ tokens }) => [...tokens]));
  const matchingPods = pods.filter((pod) => {
    const podTokens = identityTokens(pod.name);
    return podTokens.some((token) => requested.has(token) || workloadTokens.has(token));
  });
  const readyPods = matchingPods.filter((pod) =>
    pod.phase === "Running" && pod.containers.length > 0 && pod.containers.every(({ ready }) => ready));
  const status = readyPods.length > 0
    ? "running_in_kubernetes"
    : registryMatches.length > 0
      ? "registered_but_no_running_kubernetes_workload_observed"
      : matchingPods.length > 0
        ? "kubernetes_workload_observed_without_registered_agent"
        : "not_found_in_connected_sources";
  return {
    query,
    status,
    registryMatches: registryMatches.slice(0, 10).map(({ agent }) => agent),
    matchingPods: matchingPods.slice(0, 100),
    readyPodCount: readyPods.length,
  };
}

const OpenRouterResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      role: z.literal("assistant"),
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        id: z.string(), type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }).passthrough(),
  })).min(1),
  model: z.string().optional(),
}).passthrough();

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "resolve_application_status",
      description: "Resolve a named app, service, or agent across Tracey's registry and every connected Kubernetes namespace. Always use this for questions such as 'is the notes app live?', 'is checkout running?', or 'what is the status of service X?'. It does not require the user to know a namespace.",
      parameters: {
        type: "object", required: ["query"], additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 256 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List production agents registered for the current tenant.",
      parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_deployment",
      description: "Resolve a registered agent to its validated Kubernetes Deployment and return live rollout, pod, image, and restart health. Use this before proposing a Kubernetes change for an agent.",
      parameters: {
        type: "object", required: ["agentId"], additionalProperties: false,
        properties: { agentId: { type: "string", format: "uuid" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_failed_agent_runs",
      description: "Scan every active registered agent and report failed runs or failure signals in one bounded operation. Always use this for questions such as 'which agents failed in the last 24 hours?'; do not manually call list_agents followed by search_agent_runs for each agent.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          lookbackMinutes: { type: "integer", minimum: 1, maximum: 10_080, default: 1_440 },
          perAgentLimit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_agent_runs",
      description: "Search native observed roots for a registered Claude Code or custom OTel agent.",
      parameters: {
        type: "object", required: ["agentId", "start", "end"], additionalProperties: false,
        properties: {
          agentId: { type: "string", format: "uuid" }, start: { type: "integer" }, end: { type: "integer" },
          runId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "investigate_trace",
      description: "Fetch a bounded trace and return deterministic graph analysis and evidence-linked diagnosis.",
      parameters: {
        type: "object", required: ["traceId", "start", "end"], additionalProperties: false,
        properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, start: { type: "integer" }, end: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_codex_logs",
      description: "Search recent privacy-safe native Codex OpenTelemetry events by service without requiring a conversation ID. Use this for questions about recent Codex activity, logs, tools, failures, or latency.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          serviceName: { type: "string", enum: ["codex-app-server", "Codex Desktop"] },
          lookbackMinutes: { type: "integer", minimum: 1, maximum: 10_080 },
          limit: { type: "integer", minimum: 1, maximum: 1_000 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "investigate_codex_conversation",
      description: "Investigate exact native Codex telemetry by conversation ID. For a relative window such as 'last 10 minutes', pass lookbackMinutes instead of calculating timestamps.",
      parameters: {
        type: "object", required: ["conversationId"], additionalProperties: false,
        properties: {
          conversationId: { type: "string", format: "uuid" },
          start: { type: "integer", minimum: 1_000_000_000_000, description: "Absolute UTC Unix epoch milliseconds; use only together with end." },
          end: { type: "integer", minimum: 1_000_000_000_000, description: "Absolute UTC Unix epoch milliseconds; use only together with start." },
          lookbackMinutes: { type: "integer", minimum: 1, maximum: 10_080, description: "Relative window ending now. Do not combine with start or end." },
          serviceName: { type: "string", enum: ["codex-app-server", "Codex Desktop"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_cohorts",
      description: "Compare two real prompt, model, or tool cohorts using deterministic statistics.",
      parameters: {
        type: "object", required: ["start", "end", "serviceName", "dimension", "baseline", "candidate"], additionalProperties: false,
        properties: {
          start: { type: "integer" }, end: { type: "integer" }, serviceName: { type: "string" },
          dimension: { type: "string", enum: ["prompt_version", "model", "tool_version"] },
          baseline: { type: "string" }, candidate: { type: "string" }, minSampleSize: { type: "integer", minimum: 2, maximum: 1000 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pods",
      description: "List active pods in one connected Kubernetes namespace, or omit namespace to list every namespace currently connected to Tracey.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { namespace: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pod_status",
      description: "Get the current status of a Kubernetes pod.",
      parameters: {
        type: "object", required: ["namespace", "podName"], additionalProperties: false,
        properties: { namespace: { type: "string" }, podName: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pod_logs",
      description: "Fetch logs from a Kubernetes pod to investigate errors or crashes.",
      parameters: {
        type: "object", required: ["namespace", "podName"], additionalProperties: false,
        properties: { namespace: { type: "string" }, podName: { type: "string" }, tailLines: { type: "integer", minimum: 1, maximum: 1000 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_k8s_events",
      description: "Get recent Kubernetes events in a namespace to diagnose scheduling, eviction, or probe failures.",
      parameters: {
        type: "object", required: ["namespace"], additionalProperties: false,
        properties: { namespace: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_deployment_config",
      description: "Get the current configuration (image, replicas, resources, env vars) of a Kubernetes deployment.",
      parameters: {
        type: "object", required: ["namespace", "deploymentName"], additionalProperties: false,
        properties: { namespace: { type: "string" }, deploymentName: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: { name: "describe_pod", description: "Return a privacy-filtered pod description.", parameters: {
      type: "object", required: ["namespace", "podName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, podName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_deployment_rollout_status", description: "Inspect deployment rollout readiness and conditions.", parameters: {
      type: "object", required: ["namespace", "deploymentName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, deploymentName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_replica_set_history", description: "Inspect deployment revisions and their readiness.", parameters: {
      type: "object", required: ["namespace", "deploymentName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, deploymentName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_resource_usage", description: "Read current pod CPU and memory usage from metrics.k8s.io.", parameters: {
      type: "object", required: ["namespace", "podName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, podName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_node_health", description: "Inspect Kubernetes node capacity and health conditions.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  },
  {
    type: "function",
    function: { name: "get_service_endpoints", description: "Inspect ready and unready endpoints for a service.", parameters: {
      type: "object", required: ["namespace", "serviceName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, serviceName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_ingress_status", description: "Inspect ingress hosts and load-balancer status.", parameters: {
      type: "object", required: ["namespace"], additionalProperties: false, properties: { namespace: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_hpa_status", description: "Inspect HorizontalPodAutoscaler configuration and status.", parameters: {
      type: "object", required: ["namespace"], additionalProperties: false, properties: { namespace: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_pdb_status", description: "Inspect PodDisruptionBudget health and allowed disruptions.", parameters: {
      type: "object", required: ["namespace"], additionalProperties: false, properties: { namespace: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_container_restarts", description: "Return bounded per-container restart counts for a pod.", parameters: {
      type: "object", required: ["namespace", "podName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, podName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "get_recent_changes", description: "Correlate deployment generation, recent ReplicaSets, and related Kubernetes events.", parameters: {
      type: "object", required: ["namespace", "deploymentName"], additionalProperties: false,
      properties: { namespace: { type: "string" }, deploymentName: { type: "string" } },
    } },
  },
  {
    type: "function",
    function: { name: "search_traces", description: "Search bounded observed root traces for a service.", parameters: {
      type: "object", required: ["serviceName", "start", "end"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
    } },
  },
  {
    type: "function",
    function: { name: "inspect_trace", description: "Inspect a bounded trace, its privacy-filtered evidence, latency graph, and diagnosis.", parameters: {
      type: "object", required: ["traceId", "start", "end"], additionalProperties: false,
      properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, start: { type: "integer" }, end: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "query_metrics", description: "Query bounded production agent-run metrics for a service.", parameters: {
      type: "object", required: ["serviceName", "start", "end"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, stepInterval: { type: "integer", minimum: 1, maximum: 3600 } },
    } },
  },
  {
    type: "function",
    function: { name: "query_logs", description: "Return bounded, locally redacted logs correlated to an exact trace.", parameters: {
      type: "object", required: ["traceId", "start", "end"], additionalProperties: false,
      properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, start: { type: "integer" }, end: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "inspect_exceptions", description: "Return error spans and deterministic exception hypotheses for an exact trace.", parameters: {
      type: "object", required: ["traceId", "start", "end"], additionalProperties: false,
      properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, start: { type: "integer" }, end: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "compare_before_after", description: "Compare bounded SigNoz span error rate and p95 latency windows for one service.", parameters: {
      type: "object", required: ["serviceName", "beforeStart", "beforeEnd", "afterStart", "afterEnd"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, beforeStart: { type: "integer" }, beforeEnd: { type: "integer" }, afterStart: { type: "integer" }, afterEnd: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "calculate_error_rate", description: "Calculate a bounded SigNoz span error rate for a service window.", parameters: {
      type: "object", required: ["serviceName", "start", "end"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "calculate_latency_change", description: "Calculate p95 latency change between bounded service windows.", parameters: {
      type: "object", required: ["serviceName", "beforeStart", "beforeEnd", "afterStart", "afterEnd"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, beforeStart: { type: "integer" }, beforeEnd: { type: "integer" }, afterStart: { type: "integer" }, afterEnd: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "determine_affected_services", description: "Determine affected service names from the spans in an exact trace.", parameters: {
      type: "object", required: ["traceId", "start", "end"], additionalProperties: false,
      properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, start: { type: "integer" }, end: { type: "integer" } },
    } },
  },
  {
    type: "function",
    function: { name: "verify_incident_recovery", description: "Fail-closed recovery verification using bounded before/after SigNoz samples and explicit thresholds.", parameters: {
      type: "object", required: ["serviceName", "beforeStart", "beforeEnd", "afterStart", "afterEnd", "minimumSampleCount", "maxErrorRateIncrease", "maxLatencyIncreasePercent"], additionalProperties: false,
      properties: { serviceName: { type: "string" }, beforeStart: { type: "integer" }, beforeEnd: { type: "integer" }, afterStart: { type: "integer" }, afterEnd: { type: "integer" }, minimumSampleCount: { type: "integer", minimum: 1, maximum: 1000 }, maxErrorRateIncrease: { type: "number", minimum: 0, maximum: 1 }, maxLatencyIncreasePercent: { type: "number", minimum: 0, maximum: 1000 } },
    } },
  },
  {
    type: "function",
    function: {
      name: "propose_remediation",
      description: "Submit an evidence-backed remediation plan to Tracey's deterministic policy engine. This is the only model tool that can initiate a mutation workflow; it never bypasses policy, approval, execution, verification, or recovery controls.",
      parameters: {
        type: "object",
        required: ["action", "summary", "reason", "confidence", "risk", "reversible", "expectedImpact", "blastRadius", "evidenceRefs", "verification"],
        additionalProperties: false,
        properties: {
          action: {
            oneOf: [
              { type: "object", required: ["type", "namespace", "workload"], additionalProperties: false, properties: { type: { const: "restart_pod" }, namespace: { type: "string" }, workload: { type: "string", description: "Exact Kubernetes pod name" } } },
              { type: "object", required: ["type", "namespace", "workload"], additionalProperties: false, properties: { type: { const: "restart_workload" }, namespace: { type: "string" }, workload: { type: "string" } } },
              { type: "object", required: ["type", "namespace", "workload"], additionalProperties: false, properties: { type: { const: "rollback_deployment" }, namespace: { type: "string" }, workload: { type: "string" }, revision: { type: "integer", minimum: 1 } } },
              { type: "object", required: ["type", "namespace", "workload", "replicas"], additionalProperties: false, properties: { type: { const: "scale_deployment" }, namespace: { type: "string" }, workload: { type: "string" }, replicas: { type: "integer", minimum: 1, maximum: 1000 } } },
              { type: "object", required: ["type", "namespace", "workload", "container"], additionalProperties: false, properties: { type: { const: "update_resource_limits" }, namespace: { type: "string" }, workload: { type: "string" }, container: { type: "string" }, memory: { type: "string" }, cpu: { type: "string" } } },
              { type: "object", required: ["type", "namespace", "workload", "minReplicas", "maxReplicas"], additionalProperties: false, properties: { type: { const: "update_hpa" }, namespace: { type: "string" }, workload: { type: "string" }, minReplicas: { type: "integer", minimum: 1 }, maxReplicas: { type: "integer", minimum: 1 } } },
              { type: "object", required: ["type", "namespace", "workload", "patch"], additionalProperties: false, properties: { type: { const: "apply_config_patch" }, namespace: { type: "string" }, workload: { type: "string" }, patch: { type: "object", minProperties: 1, additionalProperties: false, properties: { minReadySeconds: { type: "integer", minimum: 0, maximum: 3600 }, progressDeadlineSeconds: { type: "integer", minimum: 60, maximum: 3600 }, revisionHistoryLimit: { type: "integer", minimum: 1, maximum: 20 }, maxUnavailable: { oneOf: [{ type: "integer", minimum: 0, maximum: 100 }, { type: "string", pattern: "^\\d{1,3}%$" }] }, maxSurge: { oneOf: [{ type: "integer", minimum: 0, maximum: 100 }, { type: "string", pattern: "^\\d{1,3}%$" }] } } } } },
              { type: "object", required: ["type", "namespace", "workload"], additionalProperties: false, properties: { type: { type: "string", enum: ["retry_job", "suspend_cronjob", "resume_cronjob", "restore_previous_config"] }, namespace: { type: "string" }, workload: { type: "string" } } },
              { type: "object", required: ["type", "namespace", "workload", "apiVersion", "kind", "manifest"], additionalProperties: false, properties: { type: { const: "apply_kubernetes_resource" }, namespace: { type: "string", description: "Kubernetes namespace, or * for a cluster-scoped resource" }, workload: { type: "string", description: "Resource name" }, apiVersion: { type: "string" }, kind: { type: "string" }, manifest: { type: "object", minProperties: 1, additionalProperties: true } } },
              { type: "object", required: ["type", "namespace", "workload", "apiVersion", "kind", "patch"], additionalProperties: false, properties: { type: { const: "patch_kubernetes_resource" }, namespace: { type: "string", description: "Kubernetes namespace, or * for a cluster-scoped resource" }, workload: { type: "string", description: "Resource name" }, apiVersion: { type: "string" }, kind: { type: "string" }, patch: { type: "object", minProperties: 1, additionalProperties: true } } },
              { type: "object", required: ["type", "namespace", "workload", "apiVersion", "kind"], additionalProperties: false, properties: { type: { const: "delete_kubernetes_resource" }, namespace: { type: "string", description: "Kubernetes namespace, or * for a cluster-scoped resource" }, workload: { type: "string", description: "Resource name" }, apiVersion: { type: "string" }, kind: { type: "string" }, propagationPolicy: { type: "string", enum: ["Foreground", "Background", "Orphan"] } } },
            ],
          },
          summary: { type: "string", minLength: 1, maxLength: 2000 },
          reason: { type: "string", minLength: 1, maxLength: 4000 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
          reversible: { type: "boolean" },
          expectedImpact: { type: "string", minLength: 1, maxLength: 2000 },
          blastRadius: { type: "object", required: ["workloads", "estimatedUnavailableReplicas"], additionalProperties: false, properties: { workloads: { type: "integer", minimum: 1, maximum: 100 }, estimatedUnavailableReplicas: { type: "integer", minimum: 0, maximum: 10000 } } },
          evidenceRefs: { type: "array", maxItems: 100, items: { type: "object", required: ["traceId"], additionalProperties: false, properties: { traceId: { type: "string", pattern: "^[a-fA-F0-9]{32}$" }, spanId: { type: "string", pattern: "^[a-fA-F0-9]{16}$" } } } },
          verification: { type: "object", required: ["serviceName", "timeoutSeconds", "lookbackSeconds", "minimumSampleCount", "settleSeconds", "requireWorkloadReady", "maxErrorRateIncrease", "maxLatencyIncreasePercent"], additionalProperties: false, properties: { serviceName: { type: "string", minLength: 1, maxLength: 128 }, timeoutSeconds: { type: "integer", minimum: 10, maximum: 3600 }, lookbackSeconds: { type: "integer", minimum: 30, maximum: 3600 }, minimumSampleCount: { type: "integer", minimum: 1, maximum: 1000 }, settleSeconds: { type: "integer", minimum: 0, maximum: 300 }, requireWorkloadReady: { type: "boolean" }, maxErrorRateIncrease: { type: "number", minimum: 0, maximum: 1 }, maxLatencyIncreasePercent: { type: "number", minimum: 0, maximum: 1000 } } },
          rollback: { type: "object", required: ["action", "automatic"], additionalProperties: false, properties: { action: { type: "object" }, automatic: { type: "boolean" } } },
        },
      },
    },
  },
] as const;
export const agentToolNames: string[] = toolDefinitions.map(({ function: definition }) => definition.name);

const CodexToolArgumentsSchema = z.object({
  conversationId: z.string().uuid(),
  start: z.number().int().min(1_000_000_000_000).optional(),
  end: z.number().int().min(1_000_000_000_000).optional(),
  lookbackMinutes: z.number().int().min(1).max(10_080).optional(),
  serviceName: z.enum(["codex-app-server", "Codex Desktop"]).default("codex-app-server"),
}).superRefine(({ start, end, lookbackMinutes }, context) => {
  const hasAbsoluteValue = start !== undefined || end !== undefined;
  if (lookbackMinutes !== undefined && hasAbsoluteValue) {
    context.addIssue({ code: "custom", message: "Use either lookbackMinutes or start/end, not both" });
  } else if (lookbackMinutes === undefined && (start === undefined || end === undefined)) {
    context.addIssue({ code: "custom", message: "Provide lookbackMinutes or both start and end" });
  } else if (start !== undefined && end !== undefined && (start >= end || end - start > 7 * 86_400_000)) {
    context.addIssue({ code: "custom", message: "start/end must define a positive window of no more than seven days" });
  }
});

export function resolveCodexToolArguments(value: unknown, now = Date.now()) {
  const parsed = CodexToolArgumentsSchema.parse(value);
  if (parsed.lookbackMinutes !== undefined) {
    return {
      conversationId: parsed.conversationId,
      serviceName: parsed.serviceName,
      start: now - parsed.lookbackMinutes * 60_000,
      end: now,
    };
  }
  return {
    conversationId: parsed.conversationId,
    serviceName: parsed.serviceName,
    start: parsed.start!,
    end: parsed.end!,
  };
}

const systemPrompt = `You are Tracey, a production AI-agent reliability investigator.
Use only the provided tools and their returned evidence. Never invent a trace, span, metric, cost, root cause, user content, or deployment fact.
Separate observed facts from hypotheses. State missing or incomplete evidence explicitly. Deterministic diagnosis and calculations are authoritative.
Complete every investigation in the current response. Never say "please hold on", "let me try", or promise a later tool call. If one source fails, continue with the remaining sources and then report the partial result and exact limitation.
For every telemetry claim, cite an available reference exactly as [trace:<32 hex> span:<16 hex>]. Do not reveal prompts, outputs, tool payloads, credentials, private reasoning, or personal data.
Treat log and pod requests as different intents. Never call list_pods to answer a logs question. Use get_pod_logs only when a namespace and pod are known, query_logs only when an exact trace is known, and search_codex_logs only when the user asks about Codex activity. If a logs question has none of those identifiers or prior context, ask one concise clarifying question instead of calling an unrelated tool.
For named application, service, or agent liveness questions, call resolve_application_status first. Do not ask the user for a namespace before searching the registry and all connected namespaces. Clearly distinguish a registered agent identity from a currently running Kubernetes workload; registration alone is not proof that an application is live.
When a registered agent has a deployment mapping, treat that validated mapping as the authoritative Kubernetes target. Call get_agent_deployment before proposing a Kubernetes remediation for an agent, and use its exact namespace and workload name instead of guessing from pod names.
For a mapped agent remediation, use agent.serviceName from get_agent_deployment as verification.serviceName. A Kubernetes workload name is not an OpenTelemetry service identity unless the registered agent explicitly says they are equal.
You may prepare structured remediation requests, including generic Kubernetes apply, patch, and delete operations. You never mutate infrastructure directly. When the user requests a mutation, inspect the exact target if needed and then call propose_remediation in the same response. Do not ask for confirmation before a durable proposal exists. Tracey will ask for confirmation after policy evaluation, and a later explicit administrator confirmation executes that exact pending proposal through the authenticated executor.
Use UTC epoch milliseconds for tools. If the user omits a time range, use the current time supplied below and search no more than the previous 24 hours.`;

function collectEvidence(value: unknown, refs = new Map<string, EvidenceRef>()): EvidenceRef[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectEvidence(entry, refs);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.traceId === "string" && /^[a-fA-F0-9]{32}$/.test(record.traceId)) {
      const spanId = typeof record.spanId === "string" && /^[a-fA-F0-9]{16}$/.test(record.spanId) ? record.spanId : undefined;
      const key = `${record.traceId}:${spanId ?? ""}`;
      refs.set(key, {
        traceId: record.traceId,
        ...(spanId ? { spanId } : {}),
        ...(typeof record.observation === "string" ? { observation: record.observation.slice(0, 500) } : {}),
        ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
      });
    }
    for (const entry of Object.values(record)) collectEvidence(entry, refs);
  }
  return [...refs.values()].slice(0, 500);
}

function evidenceKey(reference: EvidenceRef): string {
  return reference.traceId
    ? `trace:${reference.traceId}:${reference.spanId ?? ""}`
    : `${reference.sourceType ?? "tool"}:${reference.sourceId ?? reference.signal ?? "observation"}`;
}

function safeSourcePart(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:/*-]/g, "-").slice(0, 180);
  return normalized || undefined;
}

function operationalEvidence(toolName: string, args: unknown, result: unknown): EvidenceRef[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  if (typeof record.error === "string") return [];
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const kubernetesTools = new Set([
    "list_pods", "get_pod_status", "get_pod_logs", "get_k8s_events", "get_deployment_config",
    "describe_pod", "get_deployment_rollout_status", "get_replica_set_history", "get_resource_usage",
    "get_node_health", "get_service_endpoints", "get_ingress_status", "get_hpa_status", "get_pdb_status",
    "get_container_restarts", "get_recent_changes",
  ]);
  if (kubernetesTools.has(toolName)) {
    const namespace = safeSourcePart(input.namespace) ?? "all-connected-namespaces";
    const resource = safeSourcePart(input.podName ?? input.deploymentName ?? input.serviceName ?? input.ingressName ?? input.hpaName ?? input.pdbName);
    if (toolName === "list_pods") {
      const pods = Array.isArray(record.pods) ? record.pods as Array<Record<string, unknown>> : [];
      const scopes = Array.isArray(record.scopes) ? record.scopes.filter((scope): scope is string => typeof scope === "string") : [];
      const podSummary = pods.slice(0, 12).map((pod) => {
        const podNamespace = safeSourcePart(pod.namespace) ?? "unknown";
        const podName = safeSourcePart(pod.name) ?? "unknown";
        const phase = safeSourcePart(pod.phase) ?? "unknown";
        return `${podNamespace}/${podName} (${phase})`;
      }).join(", ");
      return [{
        sourceType: "kubernetes",
        sourceId: `pods:${scopes.map((scope) => safeSourcePart(scope)).filter(Boolean).join(",") || namespace}`,
        signal: "kubernetes.pods",
        observation: `Kubernetes API returned ${pods.length} pod${pods.length === 1 ? "" : "s"} across ${scopes.length || 1} connected namespace${(scopes.length || 1) === 1 ? "" : "s"}${podSummary ? `: ${podSummary}` : "."}`.slice(0, 500),
      }];
    }
    return [{
      sourceType: "kubernetes",
      sourceId: `${toolName}:${namespace}${resource ? `/${resource}` : ""}`,
      signal: `kubernetes.${toolName}`,
      observation: `Kubernetes API successfully returned the requested ${toolName.replaceAll("_", " ")} evidence for ${resource ? `${namespace}/${resource}` : namespace}.`,
    }];
  }
  if (toolName === "list_agents") {
    const agents = Array.isArray(record.agents) ? record.agents : [];
    if (agents.length === 0) return [];
    return [{
      sourceType: "tracey",
      sourceId: "registered-agents",
      signal: "tracey.agent.registry",
      observation: `Tracey's tenant-scoped registry returned ${agents.length} registered agent${agents.length === 1 ? "" : "s"}.`,
    }];
  }
  if (toolName === "get_agent_deployment") {
    const mapping = record.mapping && typeof record.mapping === "object"
      ? record.mapping as Record<string, unknown>
      : undefined;
    const health = record.health && typeof record.health === "object"
      ? record.health as Record<string, unknown>
      : undefined;
    if (!mapping || !health) return [];
    const namespace = safeSourcePart(mapping.namespace) ?? "unknown";
    const workload = safeSourcePart(mapping.workloadName) ?? "unknown";
    return [{
      sourceType: "kubernetes",
      sourceId: `agent-deployment:${namespace}/${workload}`,
      signal: "kubernetes.agent_deployment",
      observation: `Tracey's validated agent mapping resolved to Deployment ${namespace}/${workload}; live Kubernetes health reports ${Number(health.readyReplicas ?? 0)}/${Number(health.desiredReplicas ?? 0)} replicas ready and ${Number(health.totalRestarts ?? 0)} container restarts.`,
    }];
  }
  if (toolName === "search_failed_agent_runs") {
    const agents = Array.isArray(record.agents) ? record.agents : [];
    const queried = agents.filter((agent) => agent && typeof agent === "object" && (agent as Record<string, unknown>).queryStatus === "complete").length;
    const unavailable = agents.length - queried;
    return [{
      sourceType: "tracey",
      sourceId: "failed-agent-run-scan",
      signal: "tracey.agent.failure_scan",
      observation: `Tracey completed a tenant-scoped failure scan across ${agents.length} active registered agent${agents.length === 1 ? "" : "s"}; ${queried} source${queried === 1 ? " was" : "s were"} queried successfully and ${unavailable} source${unavailable === 1 ? " was" : "s were"} unavailable.`,
    }];
  }
  if (toolName === "resolve_application_status") {
    const matches = Array.isArray(record.registryMatches) ? record.registryMatches.length : 0;
    const pods = Array.isArray(record.matchingPods) ? record.matchingPods.length : 0;
    const status = safeSourcePart(record.status) ?? "unknown";
    return [{
      sourceType: "tracey",
      sourceId: `application-status:${safeSourcePart(input.query) ?? "query"}`,
      signal: "tracey.application.status",
      observation: `Tracey resolved the application across its registry and connected Kubernetes namespaces: ${matches} registry match${matches === 1 ? "" : "es"}, ${pods} matching pod${pods === 1 ? "" : "s"}, status ${status}.`,
    }];
  }
  if (toolName === "propose_remediation") {
    const action = record.action && typeof record.action === "object" ? record.action as Record<string, unknown> : undefined;
    const proposalId = safeSourcePart(action?.proposalId);
    const status = safeSourcePart(action?.status);
    const target = safeSourcePart(action?.target);
    if (!proposalId || !status || !target) return [];
    return [{
      sourceType: "tracey",
      sourceId: `action:${proposalId}`,
      signal: "tracey.action.lifecycle",
      observation: `Tracey recorded action ${proposalId} for ${target} with status ${status}.`,
    }];
  }
  const signozTools = new Set([
    "search_agent_runs", "search_codex_logs", "investigate_codex_conversation", "compare_cohorts",
    "search_traces", "inspect_trace", "query_metrics", "query_logs", "inspect_exceptions",
    "compare_before_after", "calculate_error_rate", "calculate_latency_change",
    "determine_affected_services", "verify_incident_recovery",
  ]);
  if (signozTools.has(toolName)) {
    const service = safeSourcePart(input.serviceName) ?? "configured-scope";
    const count = typeof record.logCount === "number"
      ? record.logCount
      : Array.isArray(record.logs) ? record.logs.length
        : Array.isArray(record.runs) ? record.runs.length
          : Array.isArray(record.spans) ? record.spans.length
            : undefined;
    return [{
      sourceType: "signoz",
      sourceId: `${toolName}:${service}`,
      signal: `signoz.${toolName}`,
      observation: `SigNoz successfully returned ${toolName.replaceAll("_", " ")} evidence for ${service}${count === undefined ? "." : ` (${count} observed record${count === 1 ? "" : "s"}).`}`,
    }];
  }
  return [];
}

export function collectCitableEvidence(toolName: string, args: unknown, result: unknown): EvidenceRef[] {
  const traceEvidence = collectEvidence(result);
  return traceEvidence.length > 0 ? traceEvidence : operationalEvidence(toolName, args, result);
}

export function durableProposalMessage(result: unknown): string {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const action = record.action && typeof record.action === "object" && !Array.isArray(record.action)
    ? record.action as Record<string, unknown>
    : {};
  const decision = record.decision && typeof record.decision === "object" && !Array.isArray(record.decision)
    ? record.decision as Record<string, unknown>
    : {};
  const proposalId = safeSourcePart(action.proposalId) ?? "the recorded change";
  const target = safeSourcePart(action.target) ?? "the selected target";
  const status = safeSourcePart(action.status) ?? "recorded";
  const reasons = Array.isArray(decision.reasons)
    ? decision.reasons.filter((reason): reason is string => typeof reason === "string").join("; ")
    : "";
  if (status === "awaiting_approval") {
    return `Change proposal ${proposalId} is ready for confirmation for ${target}. Review the approval card and approve or reject it; nothing has been executed.`;
  }
  if (status === "rejected") {
    return `Change proposal ${proposalId} was rejected by policy for ${target}${reasons ? `: ${reasons}` : "."}`;
  }
  if (status === "policy_evaluated") {
    return `Recommendation ${proposalId} was recorded for ${target}. The current mode does not permit execution.`;
  }
  return `Change proposal ${proposalId} was durably recorded with status ${status} for ${target}.`;
}

export function isIncompleteActionPromise(content: string | null | undefined): boolean {
  return typeof content === "string" && INCOMPLETE_ACTION_PROMISE.test(content);
}

export function isExplicitActionConfirmation(content: string): boolean {
  return EXPLICIT_ACTION_CONFIRMATION.test(content.trim());
}

export function isExplicitMutationRequest(content: string): boolean {
  return EXPLICIT_MUTATION_REQUEST.test(content.trim());
}

const safeSpanAttributeKeys = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.tool.name",
  "tracey.run.id",
  "tracey.agent.name",
  "tracey.agent.version",
  "tracey.user.outcome",
  "tracey.model.route",
  "tracey.decision.type",
  "tracey.decision.selected",
  "tracey.tool.version",
  "tracey.tool.schema.version",
  "tracey.tool.side_effect",
  "tracey.tool.result.class",
  "tracey.content.capture",
]);

export function safeInvestigationResult(toolName: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (toolName === "investigate_trace") {
    const spans = Array.isArray(record.spans) ? record.spans.slice(0, 500).map((entry) => {
      const span = entry as Record<string, unknown>;
      const attributes = span.attributes && typeof span.attributes === "object"
        ? Object.fromEntries(Object.entries(span.attributes as Record<string, unknown>)
          .filter(([key, value]) => safeSpanAttributeKeys.has(key) && ["string", "number", "boolean"].includes(typeof value)))
        : {};
      return {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        serviceName: span.serviceName,
        durationMs: span.durationMs,
        statusCode: span.statusCode,
        hasError: span.hasError,
        attributes,
      };
    }) : [];
    return { traceId: record.traceId, spans, analysis: record.analysis, diagnosis: record.diagnosis, evidence: record.evidence, query: record.query };
  }
  if (toolName === "investigate_codex_conversation") {
    const runs = Array.isArray(record.runs) ? record.runs.map((run) => {
      const item = run as Record<string, unknown>;
      return { runId: item.runId, traceId: item.traceId, startedAt: item.startedAt, status: item.status,
        evidenceCompleteness: item.evidenceCompleteness, analysis: item.analysis, diagnosis: item.diagnosis };
    }) : [];
    const statusCounts = runs.reduce<Record<string, number>>((counts, run) => {
      const status = typeof run.status === "string" ? run.status : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});
    // Put authoritative aggregate counts before the verbose per-run evidence.
    // Tool payloads are size-bounded before being sent to the model, so a large
    // conversation may truncate later run details without corrupting its totals.
    return { conversationId: record.conversationId, normalizationProfile: record.normalizationProfile,
      runCount: runs.length, statusCounts, rejectedLogs: record.rejectedLogs, query: record.query, runs };
  }
  if (toolName === "search_codex_logs") {
    const logs = Array.isArray(record.logs) ? record.logs : [];
    const eventCounts: Record<string, number> = {};
    const conversations = new Set<string>();
    const tools = new Set<string>();
    let failures = 0;
    const events = logs.slice(0, 200).map((entry) => {
      const log = entry as Record<string, unknown>;
      const attributes = log.attributes && typeof log.attributes === "object" ? log.attributes as Record<string, unknown> : {};
      const eventName = typeof log.body === "string" ? log.body : "codex.unknown";
      eventCounts[eventName] = (eventCounts[eventName] ?? 0) + 1;
      const conversationId = typeof attributes["conversation.id"] === "string" ? attributes["conversation.id"] : undefined;
      const toolName = typeof attributes.tool_name === "string" ? attributes.tool_name : undefined;
      const errorType = typeof attributes["error.type"] === "string" ? attributes["error.type"] : undefined;
      const success = typeof attributes.success === "boolean" ? attributes.success : undefined;
      if (conversationId) conversations.add(conversationId);
      if (toolName) tools.add(toolName);
      if (success === false || errorType) failures += 1;
      return {
        timestamp: log.timestamp,
        eventName,
        ...(conversationId ? { conversationId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(success === undefined ? {} : { success }),
        ...(errorType ? { errorType } : {}),
        ...(typeof attributes.duration_ms === "number" ? { durationMs: attributes.duration_ms } : {}),
      };
    });
    return {
      logCount: logs.length,
      rejectedLogs: typeof record.rejectedRows === "number" ? record.rejectedRows : 0,
      conversationCount: conversations.size,
      eventCounts,
      tools: [...tools].sort(),
      failures,
      events,
      query: record.query,
      truncated: Boolean(record.nextCursor) || logs.length > 200,
    };
  }
  if (toolName === "query_logs" && Array.isArray(record.logs)) {
    return { logs: record.logs.slice(0, 200).map((entry) => {
      const log = entry as Record<string, unknown>;
      return {
        timestamp: log.timestamp,
        traceId: log.traceId,
        spanId: log.spanId,
        severity: log.severity,
        serviceName: log.serviceName,
        body: typeof log.body === "string" ? redactModelText(log.body) : undefined,
      };
    }), evidence: record.evidence, query: record.query };
  }
  return value;
}

function redactModelText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:authorization|bearer|token|api[-_]?key|password|secret|cookie)\s*[:=]?\s*[^\s,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:sk|sk-or-v1)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .slice(0, 2_000);
}

function validateCitations(content: string, evidence: EvidenceRef[]): string {
  const allowed = new Set(evidence
    .filter((ref): ref is EvidenceRef & { traceId: string } => typeof ref.traceId === "string")
    .map((ref) => `${ref.traceId.toLowerCase()}:${ref.spanId?.toLowerCase() ?? ""}`));
  return content.replace(/\[trace:([a-fA-F0-9]{32})(?:\s+span:([a-fA-F0-9]{16}))?\]/g, (match, traceId: string, spanId?: string) =>
    allowed.has(`${traceId.toLowerCase()}:${spanId?.toLowerCase() ?? ""}`) ? match : "[unverified citation removed]");
}

export interface AgenticInvestigatorConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  tenantId: string;
  environment: string;
  allowedNamespaces?: string[];
  allowedWorkloads?: string[];
}

export class AgenticInvestigator {
  private readonly cloudAdapter: KubernetesAdapter;

  constructor(
    private readonly config: AgenticInvestigatorConfig,
    private readonly investigations: InvestigationService,
    private readonly store: PostgresStore,
    private readonly autonomy?: AutonomyService,
  ) {
    this.cloudAdapter = new KubernetesAdapter({
      ...(config.allowedNamespaces?.length ? { allowedNamespaces: config.allowedNamespaces } : {}),
      ...(config.allowedWorkloads?.length ? { allowedWorkloads: config.allowedWorkloads } : {}),
    });
  }

  async createSession(title: string) {
    return this.store.createInvestigationSession(this.config.tenantId, title);
  }

  async listMessages(sessionId: string) {
    return this.store.listInvestigationMessages(this.config.tenantId, sessionId);
  }

  async chat(sessionId: string, userInput: string, actor: AgenticActorContext = { subject: "tracey-agent", roles: ["analyst"] }) {
    const content = ChatInputSchema.parse(userInput);
    await this.store.appendInvestigationMessage(this.config.tenantId, { sessionId, role: "user", content });
    const confirmedAction = await this.executePendingConfirmation(sessionId, content, actor);
    if (confirmedAction) return confirmedAction;
    const history = await this.store.listInvestigationMessages(this.config.tenantId, sessionId, 100);
    const connectedNamespaces = this.config.allowedNamespaces?.includes("*") ? "all namespaces" : this.config.allowedNamespaces?.length ? this.config.allowedNamespaces.join(", ") : "none";
    const connectedWorkloads = this.config.allowedWorkloads?.includes("*") ? "all workloads" : this.config.allowedWorkloads?.length ? this.config.allowedWorkloads.join(", ") : "none";
    const messages: ModelMessage[] = [
      { role: "system", content: `${systemPrompt}\nCurrent UTC epoch milliseconds: ${Date.now()}.\nConnected Kubernetes namespaces: ${connectedNamespaces}. Connected Kubernetes workloads: ${connectedWorkloads}. When the user omits a namespace, call list_pods without a namespace; never guess or probe an unlisted namespace.` },
      ...history.slice(-20).map(({ role, content: messageContent }) => ({ role, content: messageContent })),
    ];
    const evidence = new Map<string, EvidenceRef>();
    const toolFailures: Array<{ toolName: string; reason: string }> = [];
    let toolCallCount = 0;
    let durableProposalCreated = false;
    let durableProposalResult: unknown;
    let responseModel = this.config.model;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const response = await this.callModel(messages);
      responseModel = response.model ?? responseModel;
      const assistant = response.choices[0]!.message;
      messages.push(assistant as ModelMessage); // preserve OpenRouter reasoning_details unmodified
      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        let finalContent = assistant.content?.trim();
        if (isExplicitMutationRequest(content) && !durableProposalCreated && iteration < MAX_ITERATIONS - 1) {
          messages.push({
            role: "user",
            content: "The user explicitly requested an infrastructure change. Do not stop at diagnosis, suggest next steps, or ask whether they want an action. Use the evidence already gathered, inspect the exact target if still necessary, and call propose_remediation now. If a valid proposal cannot be created, return the exact policy or tool limitation.",
          });
          continue;
        }
        if (isIncompleteActionPromise(finalContent) && iteration < MAX_ITERATIONS - 1) {
          messages.push({
            role: "user",
            content: "Continue the investigation now. Do not ask me to wait or describe a future action. Call the next valid tool, or return a complete final answer that states exactly which sources succeeded, which failed, and what can be concluded.",
          });
          continue;
        }
        if (!finalContent) {
          messages.push({ role: "user", content: "Return the final concise investigation now. Use only tool evidence already present, include verified trace/span citations, state limitations, and do not request another tool." });
          const synthesis = await this.callModel(messages, false);
          responseModel = synthesis.model ?? responseModel;
          finalContent = synthesis.choices[0]!.message.content?.trim();
        }
        const answer = evidence.size === 0 && toolCallCount > 0 && !durableProposalCreated
          ? toolFailures.length > 0
            ? `Tracey could not complete the requested tool checks. ${toolFailures.map(({ toolName, reason }) => `${toolName}: ${reason}`).join("; ")}.`
            : "Tracey could not verify any technical findings because the selected tools returned no citable evidence. Adjust the service, identifier, or time range and try again."
          : validateCitations(finalContent || "The provider returned no evidence-backed textual answer.", [...evidence.values()]);
        const grounding = evidence.size > 0 ? "evidence_bound" : toolCallCount > 0 ? "tool_grounded" : "model_only";
        return this.store.appendInvestigationMessage(this.config.tenantId, {
          sessionId, role: "assistant", content: answer, evidenceRefs: [...evidence.values()], model: responseModel, grounding, toolCallCount,
        });
      }

      for (const call of calls) {
        toolCallCount += 1;
        if (toolCallCount > MAX_TOOL_CALLS) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool budget exhausted" }) });
          continue;
        }
        const started = performance.now();
        let outcome: "success" | "error" | "denied" = "success";
        let args: unknown = {};
        let result: unknown;
        let refs: EvidenceRef[] = [];
        try {
          args = JSON.parse(call.function.arguments || "{}");
          result = safeInvestigationResult(call.function.name, await this.executeTool(call, args, sessionId, actor));
          if (call.function.name === "propose_remediation") {
            durableProposalCreated = true;
            durableProposalResult = result;
          }
          refs = collectCitableEvidence(call.function.name, args, result);
          for (const ref of refs) evidence.set(evidenceKey(ref), ref);
        } catch (error) {
          outcome = error instanceof z.ZodError ? "denied" : "error";
          const reason = error instanceof z.ZodError
            ? "Invalid tool arguments"
            : redactModelText(error instanceof Error ? error.message : "Tool execution failed");
          result = error instanceof z.ZodError
            ? { error: "Invalid tool arguments", issues: error.issues.map(({ path, message }) => ({ path, message })) }
            : { error: reason };
          toolFailures.push({ toolName: call.function.name, reason });
        }
        await this.store.recordAgentToolAudit(this.config.tenantId, {
          sessionId, toolName: call.function.name, outcome, arguments: args, evidenceRefs: refs, durationMs: performance.now() - started,
        });
        const serialized = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: serialized.slice(0, MAX_TOOL_RESULT_CHARS) });
      }
    }
    if (durableProposalCreated) {
      return this.store.appendInvestigationMessage(this.config.tenantId, {
        sessionId,
        role: "assistant",
        content: durableProposalMessage(durableProposalResult),
        evidenceRefs: [...evidence.values()],
        model: "tracey-control-plane",
        grounding: evidence.size > 0 ? "evidence_bound" : "tool_grounded",
        toolCallCount,
      });
    }
    throw new Error("Agent iteration budget exhausted before a final answer");
  }

  private async executePendingConfirmation(
    sessionId: string,
    content: string,
    actor: AgenticActorContext,
  ): Promise<InvestigationMessage | undefined> {
    if (!isExplicitActionConfirmation(content) || !this.autonomy) return undefined;
    const pending = await this.store.getLatestPendingActionProposal(this.config.tenantId, sessionId);
    if (!pending) return undefined;
    const evidence = (proposal: ActionProposal, observation: string): EvidenceRef[] => [{
      sourceType: "tracey",
      sourceId: `action:${proposal.proposalId}`,
      signal: "tracey.action.lifecycle",
      observation,
    }];
    if (!actor.roles.includes("admin")) {
      return this.store.appendInvestigationMessage(this.config.tenantId, {
        sessionId,
        role: "assistant",
        content: `Confirmation received, but action ${pending.proposalId} requires an administrator to approve and execute it.`,
        evidenceRefs: evidence(pending, `Action ${pending.proposalId} remains awaiting administrator approval for ${pending.target}.`),
        model: "tracey-control-plane",
        grounding: "evidence_bound",
        toolCallCount: 0,
      });
    }

    const started = performance.now();
    let outcome: "success" | "error" = "success";
    try {
      const approved = await this.store.decideActionProposal(
        this.config.tenantId,
        pending.proposalId,
        "approved",
        actor.subject,
      );
      if (!approved) throw new Error("The pending action changed before confirmation; review its current status before retrying");
      const completed = await this.autonomy.execute(approved, actor.subject);
      const observation = `Confirmed action ${completed.proposalId} finished with status ${completed.status} for ${completed.target}.`;
      return await this.store.appendInvestigationMessage(this.config.tenantId, {
        sessionId,
        role: "assistant",
        content: completed.status === "succeeded"
          ? `Action completed successfully. ${completed.target} was changed and the configured post-action verification passed.`
          : `Action execution finished with status ${completed.status}. Review change ${completed.proposalId} for its execution and verification details.`,
        evidenceRefs: evidence(completed, observation),
        model: "tracey-control-plane",
        grounding: "evidence_bound",
        toolCallCount: 1,
      });
    } catch (error) {
      outcome = "error";
      const message = redactModelText(error instanceof Error ? error.message : "Action execution failed");
      return await this.store.appendInvestigationMessage(this.config.tenantId, {
        sessionId,
        role: "assistant",
        content: `The confirmed action could not complete: ${message}. Review change ${pending.proposalId} for its recorded state and recovery details.`,
        evidenceRefs: evidence(pending, `Confirmed action ${pending.proposalId} failed while processing ${pending.target}: ${message}.`),
        model: "tracey-control-plane",
        grounding: "evidence_bound",
        toolCallCount: 1,
      });
    } finally {
      await this.store.recordAgentToolAudit(this.config.tenantId, {
        sessionId,
        toolName: "confirm_and_execute_remediation",
        outcome,
        arguments: { proposalId: pending.proposalId },
        evidenceRefs: [],
        durationMs: performance.now() - started,
      });
    }
  }

  private async callModel(messages: ModelMessage[], allowTools = true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    try {
      const response = await fetch(`${(this.config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json", "X-Title": "Tracey" },
        body: JSON.stringify({ model: this.config.model, messages,
          ...(allowTools ? { tools: toolDefinitions, tool_choice: "auto" } : {}),
          temperature: 0.1,
          max_tokens: allowTools ? 2_000 : 4_000,
          reasoning: { enabled: allowTools },
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
      return OpenRouterResponseSchema.parse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeTool(call: ToolCall, value: unknown, sessionId: string, actor: AgenticActorContext): Promise<unknown> {
    switch (call.function.name) {
      case "resolve_application_status": {
        const args = z.object({ query: z.string().trim().min(1).max(256) }).parse(value);
        const [agents, namespaces] = await Promise.all([
          this.store.listAgents(this.config.tenantId, 100),
          this.config.allowedNamespaces?.includes("*")
            ? this.cloudAdapter.listNamespaces()
            : Promise.resolve(this.config.allowedNamespaces ?? []),
        ]);
        const pods = (await Promise.all(namespaces.map((namespace) => this.cloudAdapter.listPods(namespace)))).flat();
        const resolved = resolveApplicationStatus(args.query, agents, pods);
        const mappedDeployments = (await Promise.all(resolved.registryMatches.map(async (agent) => {
          const mapping = await this.store.getAgentDeploymentMapping(this.config.tenantId, agent.agentId);
          if (!mapping) return undefined;
          try {
            return {
              agentId: agent.agentId,
              mapping,
              health: await this.cloudAdapter.getDeploymentHealth(mapping.namespace, mapping.workloadName),
            };
          } catch (error) {
            return {
              agentId: agent.agentId,
              mapping,
              error: error instanceof Error ? error.message : "Mapped Deployment health is unavailable",
            };
          }
        }))).filter((value) => value !== undefined);
        const healthyMapping = mappedDeployments.some((entry) => entry.health?.ready === true);
        const mappedPods = mappedDeployments.flatMap((entry) => entry.health?.pods ?? []);
        const matchingPods = [...resolved.matchingPods];
        for (const pod of mappedPods) {
          if (!matchingPods.some(({ namespace, name }) => namespace === pod.namespace && name === pod.name)) {
            matchingPods.push(pod);
          }
        }
        return {
          ...resolved,
          status: healthyMapping ? "running_in_kubernetes" : resolved.status,
          matchingPods,
          readyPodCount: matchingPods.filter((pod) =>
            pod.phase === "Running" && pod.containers.length > 0 && pod.containers.every(({ ready }) => ready)).length,
          mappedDeployments,
          scopes: namespaces,
        };
      }
      case "list_agents": {
        const args = z.object({ limit: z.number().int().min(1).max(100).default(50) }).parse(value);
        return { agents: await this.store.listAgents(this.config.tenantId, args.limit) };
      }
      case "get_agent_deployment": {
        const args = z.object({ agentId: z.string().uuid() }).parse(value);
        const agent = await this.store.getAgent(this.config.tenantId, args.agentId);
        if (!agent || agent.status !== "active") throw new Error("Active registered agent not found");
        const mapping = await this.store.getAgentDeploymentMapping(this.config.tenantId, args.agentId);
        if (!mapping) throw new Error("The agent is not linked to a Kubernetes Deployment");
        return {
          agent,
          mapping,
          health: await this.cloudAdapter.getDeploymentHealth(mapping.namespace, mapping.workloadName),
          observedAt: new Date().toISOString(),
        };
      }
      case "search_failed_agent_runs": {
        const args = z.object({
          lookbackMinutes: z.number().int().min(1).max(10_080).default(1_440),
          perAgentLimit: z.number().int().min(1).max(200).default(50),
        }).parse(value);
        const end = Date.now();
        const start = end - args.lookbackMinutes * 60_000;
        const registered = (await this.store.listAgents(this.config.tenantId, 100))
          .filter((agent) => agent.status === "active");
        const agents = await Promise.all(registered.map(async (agent) => {
          const identity = {
            agentId: agent.agentId,
            displayName: agent.displayName,
            serviceName: agent.serviceName,
            producerType: agent.producerType,
            environment: agent.environment,
          };
          if (agent.environment !== this.config.environment) {
            return { ...identity, queryStatus: "unavailable", limitation: "Agent environment is outside the configured SigNoz scope" };
          }
          try {
            if (["codex_desktop", "codex_cli"].includes(agent.producerType)) {
              const result = await this.investigations.getCodexRecentLogs({
                serviceName: agent.serviceName === "Codex Desktop" ? "Codex Desktop" : "codex-app-server",
                start,
                end,
                limit: Math.min(args.perAgentLimit * 20, 1_000),
              });
              const failures = result.logs.flatMap((log) => {
                const success = log.attributes.success;
                const errorType = log.attributes["error.type"];
                if (success !== false && typeof errorType !== "string") return [];
                return [{
                  timestamp: log.timestamp,
                  traceId: log.traceId,
                  ...(log.spanId ? { spanId: log.spanId } : {}),
                  eventName: typeof log.attributes["event.name"] === "string" ? log.attributes["event.name"] : log.body,
                  ...(typeof errorType === "string" ? { errorType } : {}),
                }];
              }).slice(0, args.perAgentLimit);
              return {
                ...identity,
                queryStatus: "complete",
                evidenceType: "failure_signals",
                observedSignals: result.logs.length,
                failureSignalCount: failures.length,
                failures,
                rejectedRecords: result.rejectedRows,
                truncated: Boolean(result.nextCursor),
              };
            }
            const result = await this.investigations.searchAgentRuns({
              start, end, serviceName: agent.serviceName, limit: args.perAgentLimit, offset: 0,
            }, agent.producerType);
            const failures = result.runs.filter(({ outcome }) =>
              typeof outcome === "string" && /^(?:fail(?:ed|ure)?|error)$/i.test(outcome));
            return {
              ...identity,
              queryStatus: "complete",
              evidenceType: "agent_runs",
              observedRuns: result.runs.length,
              failedRunCount: failures.length,
              failures,
              rejectedRecords: result.rejectedRows,
              truncated: Boolean(result.nextCursor),
            };
          } catch (error) {
            return {
              ...identity,
              queryStatus: "unavailable",
              limitation: error instanceof Error ? redactModelText(error.message) : "Telemetry source query failed",
            };
          }
        }));
        return {
          window: { start, end, lookbackMinutes: args.lookbackMinutes },
          activeAgentCount: registered.length,
          completedSourceCount: agents.filter(({ queryStatus }) => queryStatus === "complete").length,
          unavailableSourceCount: agents.filter(({ queryStatus }) => queryStatus === "unavailable").length,
          agents,
        };
      }
      case "search_agent_runs": {
        const args = z.object({ agentId: z.string().uuid(), start: z.number().int().nonnegative(), end: z.number().int().positive(),
          runId: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(50).default(20) }).refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        const agent = await this.store.getAgent(this.config.tenantId, args.agentId);
        if (!agent || agent.status !== "active") throw new Error("Active registered agent not found");
        if (agent.environment !== this.config.environment) throw new Error("Agent environment is outside the configured SigNoz scope");
        if (["codex_desktop", "codex_cli"].includes(agent.producerType)) throw new Error("Use investigate_codex_conversation for Codex telemetry");
        return this.investigations.searchAgentRuns({ start: args.start, end: args.end, serviceName: agent.serviceName,
          ...(args.runId ? { runId: args.runId } : {}), limit: args.limit, offset: 0 }, agent.producerType as AgentProducerType);
      }
      case "investigate_trace": {
        const args = z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        return this.investigations.investigateTrace({ ...args, limit: 1_000 });
      }
      case "investigate_codex_conversation": {
        const args = resolveCodexToolArguments(value);
        return this.investigations.investigateCodexConversation({ ...args, limit: 5_000 });
      }
      case "search_codex_logs": {
        const args = z.object({
          serviceName: z.enum(["codex-app-server", "Codex Desktop"]).default("codex-app-server"),
          lookbackMinutes: z.number().int().min(1).max(10_080).default(1_440),
          limit: z.number().int().min(1).max(1_000).default(500),
        }).parse(value);
        const end = Date.now();
        return this.investigations.getCodexRecentLogs({
          serviceName: args.serviceName,
          start: end - args.lookbackMinutes * 60_000,
          end,
          limit: args.limit,
        });
      }
      case "compare_cohorts": {
        const args = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), serviceName: z.string().min(1).max(128),
          dimension: z.enum(["prompt_version", "model", "tool_version"]), baseline: z.string().min(1).max(256), candidate: z.string().min(1).max(256),
          minSampleSize: z.number().int().min(2).max(1_000).default(30) }).refine(({ start, end, baseline, candidate }) => start < end && end - start <= 7 * 86_400_000 && baseline !== candidate).parse(value);
        return this.investigations.compareCohorts({ ...args, maxSpansPerCohort: 2_000 });
      }
      case "list_pods": {
        const args = z.object({ namespace: KubernetesNameSchema.optional() }).parse(value);
        const namespaces = args.namespace
          ? [args.namespace]
          : this.config.allowedNamespaces?.includes("*")
            ? await this.cloudAdapter.listNamespaces()
            : (this.config.allowedNamespaces ?? []);
        if (namespaces.length === 0) throw new Error("No Kubernetes namespaces are connected to Tracey");
        const scopedPods = await Promise.all(namespaces.map(async (namespace) => ({
          namespace,
          pods: await this.cloudAdapter.listPods(namespace),
        })));
        return { scopes: namespaces, pods: scopedPods.flatMap(({ pods }) => pods) };
      }
      case "get_pod_status": {
        const args = z.object({ namespace: KubernetesNameSchema, podName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getPodStatus(args.namespace, args.podName);
      }
      case "get_pod_logs": {
        const args = z.object({ namespace: KubernetesNameSchema, podName: KubernetesNameSchema, tailLines: z.number().int().min(1).max(500).optional().default(50) }).parse(value);
        return { logs: await this.cloudAdapter.getPodLogs(args.namespace, args.podName, args.tailLines) };
      }
      case "get_k8s_events": {
        const args = z.object({ namespace: KubernetesNameSchema }).parse(value);
        return { events: await this.cloudAdapter.getEvents(args.namespace) };
      }
      case "get_deployment_config": {
        const args = z.object({ namespace: KubernetesNameSchema, deploymentName: KubernetesNameSchema }).parse(value);
        return await this.cloudAdapter.getDeploymentConfig(args.namespace, args.deploymentName);
      }
      case "describe_pod": {
        const args = z.object({ namespace: KubernetesNameSchema, podName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.describePod(args.namespace, args.podName);
      }
      case "get_deployment_rollout_status": {
        const args = z.object({ namespace: KubernetesNameSchema, deploymentName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getDeploymentRolloutStatus(args.namespace, args.deploymentName);
      }
      case "get_replica_set_history": {
        const args = z.object({ namespace: KubernetesNameSchema, deploymentName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getReplicaSetHistory(args.namespace, args.deploymentName);
      }
      case "get_resource_usage": {
        const args = z.object({ namespace: KubernetesNameSchema, podName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getResourceUsage(args.namespace, args.podName);
      }
      case "get_node_health": {
        z.object({}).parse(value);
        return { nodes: await this.cloudAdapter.getNodeHealth() };
      }
      case "get_service_endpoints": {
        const args = z.object({ namespace: KubernetesNameSchema, serviceName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getServiceEndpoints(args.namespace, args.serviceName);
      }
      case "get_ingress_status": {
        const args = z.object({ namespace: KubernetesNameSchema }).parse(value);
        return { ingresses: await this.cloudAdapter.getIngressStatus(args.namespace) };
      }
      case "get_hpa_status": {
        const args = z.object({ namespace: KubernetesNameSchema }).parse(value);
        return { autoscalers: await this.cloudAdapter.getHpaStatus(args.namespace) };
      }
      case "get_pdb_status": {
        const args = z.object({ namespace: KubernetesNameSchema }).parse(value);
        return { disruptionBudgets: await this.cloudAdapter.getPdbStatus(args.namespace) };
      }
      case "get_container_restarts": {
        const args = z.object({ namespace: KubernetesNameSchema, podName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getContainerRestarts(args.namespace, args.podName);
      }
      case "get_recent_changes": {
        const args = z.object({ namespace: KubernetesNameSchema, deploymentName: KubernetesNameSchema }).parse(value);
        return this.cloudAdapter.getRecentChanges(args.namespace, args.deploymentName);
      }
      case "search_traces": {
        const args = ServiceWindowObject.extend({ limit: z.number().int().min(1).max(50).default(20) })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        return this.investigations.searchAgentRuns({ ...args, offset: 0 }, "custom_otel");
      }
      case "inspect_trace": {
        const args = z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        return safeInvestigationResult("investigate_trace", await this.investigations.investigateTrace({ ...args, limit: 1_000 }));
      }
      case "query_metrics": {
        const args = ServiceWindowObject.extend({ stepInterval: z.number().int().min(1).max(3_600).default(60) })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        return this.investigations.queryAgentRunMetrics(args);
      }
      case "query_logs": {
        const args = z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        const investigation = await this.investigations.investigateTrace({ ...args, limit: 1_000 });
        return { logs: investigation.logs, evidence: investigation.evidence, query: investigation.query.logs };
      }
      case "inspect_exceptions": {
        const args = z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        const investigation = await this.investigations.investigateTrace({ ...args, limit: 1_000 });
        return {
          traceId: investigation.traceId,
          errorSpans: investigation.spans.filter(({ hasError, statusCode }) => hasError === true || statusCode?.toUpperCase() === "ERROR")
            .map(({ traceId, spanId, name, serviceName, durationMs, statusCode }) => ({ traceId, spanId, name, serviceName, durationMs, statusCode })),
          hypotheses: investigation.diagnosis?.hypotheses ?? [],
          evidence: investigation.evidence,
        };
      }
      case "compare_before_after":
      case "calculate_latency_change": {
        const args = BeforeAfterSchema.parse(value);
        const [before, after] = await Promise.all([
          this.investigations.getServiceHealthSnapshot({ serviceName: args.serviceName, start: args.beforeStart, end: args.beforeEnd }),
          this.investigations.getServiceHealthSnapshot({ serviceName: args.serviceName, start: args.afterStart, end: args.afterEnd }),
        ]);
        return { before, after, errorRateChange: after.errorRate - before.errorRate,
          p95LatencyChangePercent: before.p95LatencyMs === 0 ? (after.p95LatencyMs === 0 ? 0 : Number.MAX_SAFE_INTEGER) : ((after.p95LatencyMs - before.p95LatencyMs) / before.p95LatencyMs) * 100 };
      }
      case "calculate_error_rate": {
        const args = ServiceWindowSchema.parse(value);
        const result = await this.investigations.getServiceHealthSnapshot(args);
        return { serviceName: result.serviceName, window: result.window, errorRate: result.errorRate, errorSpans: result.errorSpans,
          totalSpans: result.totalSpans, truncated: result.truncated, rejectedRows: result.rejectedRows, query: result.query };
      }
      case "determine_affected_services": {
        const args = z.object({ traceId: z.string().regex(/^[a-fA-F0-9]{32}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .refine(({ start, end }) => start < end && end - start <= 7 * 86_400_000).parse(value);
        const result = await this.investigations.investigateTrace({ ...args, limit: 1_000 });
        const affectedServices = [...new Set(result.spans.filter(({ hasError, statusCode }) => hasError === true || statusCode?.toUpperCase() === "ERROR").map(({ serviceName }) => serviceName))].sort();
        return { traceId: result.traceId, affectedServices, complete: result.evidence.complete };
      }
      case "verify_incident_recovery": {
        const args = BeforeAfterObject.extend({ minimumSampleCount: z.number().int().min(1).max(1_000), maxErrorRateIncrease: z.number().min(0).max(1), maxLatencyIncreasePercent: z.number().min(0).max(1_000) })
          .refine(validComparisonWindows, "invalid or excessive comparison windows").parse(value);
        const [before, after] = await Promise.all([
          this.investigations.getServiceHealthSnapshot({ serviceName: args.serviceName, start: args.beforeStart, end: args.beforeEnd }),
          this.investigations.getServiceHealthSnapshot({ serviceName: args.serviceName, start: args.afterStart, end: args.afterEnd }),
        ]);
        return { before, after, ...compareServiceHealth(before, after, args) };
      }
      case "propose_remediation": {
        if (!this.autonomy) throw new Error("The remediation policy service is not configured");
        let plan = RemediationPlanSchema.parse(value);
        if (OBSERVABILITY_VERIFIED_ACTIONS.has(plan.action.type)) {
          const agents = (await this.store.listAgents(this.config.tenantId, 100))
            .filter(({ status }) => status === "active");
          const mappedServiceNames = new Set<string>();
          await Promise.all(agents.map(async (agent) => {
            const mapping = await this.store.getAgentDeploymentMapping(this.config.tenantId, agent.agentId);
            if (mapping?.namespace === plan.action.namespace && mapping.workloadName === plan.action.workload) {
              mappedServiceNames.add(agent.serviceName);
            }
          }));
          if (mappedServiceNames.size === 1) {
            const [serviceName] = mappedServiceNames;
            plan = RemediationPlanSchema.parse({
              ...plan,
              verification: { ...plan.verification, serviceName },
            });
          } else if (mappedServiceNames.size > 1 && !mappedServiceNames.has(plan.verification.serviceName)) {
            throw new Error("The mapped workload has multiple registered telemetry services; choose an exact registered serviceName");
          }
        }
        const policy = await this.store.getAutonomyPolicy(this.config.tenantId, "global", "default");
        if (!policy) throw new Error("No enabled global/default autonomy policy exists; Tracey fails closed");
        return this.autonomy.evaluatePlan({
          sessionId,
          plan,
          policy,
          actor: actor.subject,
          actorRoles: actor.roles,
          modelIdentity: this.config.model,
        });
      }
      default:
        throw new z.ZodError([{ code: "custom", path: ["tool"], message: "Tool is not allowlisted" }]);
    }
  }
}
