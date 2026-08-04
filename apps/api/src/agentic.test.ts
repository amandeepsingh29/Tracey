import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProducerType } from "@tracey/domain";
import type { InvestigationService } from "@tracey/investigation";
import type { InvestigationMessage, PostgresStore } from "@tracey/postgres-store";
import type { AutonomyService } from "./autonomy-service.js";
import { AgenticInvestigator, agentToolNames, agentToolNamesForProducerTypes, collectCitableEvidence, durableProposalMessage, isExplicitActionConfirmation, isExplicitMutationRequest, isIncompleteActionPromise, resolveApplicationStatus, resolveCodexToolArguments, safeInvestigationResult, withLatencyBudget } from "./agentic.js";

describe("bounded agentic investigator", () => {
  it("exposes remediation planning but no direct mutation adapter tools", () => {
    assert.ok(agentToolNames.includes("propose_remediation"));
    assert.ok(agentToolNames.includes("resolve_application_status"));
    assert.ok(agentToolNames.includes("get_agent_deployment"));
    for (const tool of ["search_failed_agent_runs", "search_codex_logs", "get_container_restarts", "get_recent_changes", "search_traces", "inspect_trace", "query_metrics", "query_logs", "inspect_exceptions", "compare_before_after", "calculate_error_rate", "calculate_latency_change", "determine_affected_services", "verify_incident_recovery"]) {
      assert.ok(agentToolNames.includes(tool), `${tool} must be registered`);
    }
    for (const direct of ["restart_pod", "rollback_deployment", "scale_deployment", "edit_memory_limit", "edit_env_var"]) {
      assert.equal(agentToolNames.includes(direct), false);
    }
  });

  it("enforces a latency budget around every investigation tool", async () => {
    await assert.rejects(
      withLatencyBudget(new Promise((resolve) => setTimeout(resolve, 50)), 5),
      (error: unknown) => error instanceof Error && error.name === "ToolTimeoutError" && /5ms/.test(error.message),
    );
    assert.equal(await withLatencyBudget(Promise.resolve("complete"), 50), "complete");
  });

  it("hides producer-specific tools when that connector is not enabled", () => {
    const genericTools = agentToolNamesForProducerTypes(new Set<AgentProducerType>(["custom_otel"]));
    assert.equal(genericTools.includes("search_codex_logs"), false);
    assert.equal(genericTools.includes("investigate_codex_conversation"), false);
    assert.equal(genericTools.includes("search_failed_agent_runs"), true);
    assert.equal(agentToolNamesForProducerTypes(new Set<AgentProducerType>(["codex_desktop"])).includes("search_codex_logs"), true);
  });

  it("recognizes incomplete promises that must not end an investigation", () => {
    assert.equal(isIncompleteActionPromise("Please hold on while I check each agent."), true);
    assert.equal(isIncompleteActionPromise("Let me try again to gather the information."), true);
    assert.equal(isIncompleteActionPromise("Please confirm if you would like to proceed."), true);
    assert.equal(isIncompleteActionPromise("Two agents failed and one source was unavailable."), false);
  });

  it("recognizes only concise, explicit action confirmations", () => {
    assert.equal(isExplicitActionConfirmation("yes proceed"), true);
    assert.equal(isExplicitActionConfirmation("Approve and execute"), true);
    assert.equal(isExplicitActionConfirmation("do it."), true);
    assert.equal(isExplicitActionConfirmation("yes, investigate the logs first"), false);
  });

  it("recognizes explicit infrastructure mutation requests", () => {
    assert.equal(isExplicitMutationRequest("restart pod coredns-123"), true);
    assert.equal(isExplicitMutationRequest("Please roll back checkout-api"), true);
    assert.equal(isExplicitMutationRequest("Could you scale the worker deployment?"), true);
    assert.equal(isExplicitMutationRequest("Why did the pod restart?"), false);
    assert.equal(isExplicitMutationRequest("Investigate the readiness failures"), false);
  });

  it("redacts credentials and personal identifiers from logs before OpenRouter", () => {
    const result = safeInvestigationResult("query_logs", { logs: [{
      timestamp: "2026-07-18T00:00:00Z", traceId: "a".repeat(32), body: "user alice@example.com authorization=Bearer-raw password=hunter2 api_key=example-provider-token",
    }] }) as { logs: Array<{ body: string }> };
    assert.doesNotMatch(result.logs[0]!.body, /alice@example|hunter2|example-provider-token/);
    assert.match(result.logs[0]!.body, /REDACTED/);
  });
  it("exposes bounded model and tool evidence without private content", () => {
    const traceId = "a".repeat(32);
    const spanId = "b".repeat(16);
    const result = safeInvestigationResult("investigate_trace", {
      traceId,
      spans: [{
        traceId,
        spanId,
        parentSpanId: null,
        name: "execute_tool create_note",
        serviceName: "sample-agent-api",
        durationMs: 12,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "create_note",
          "tracey.tool.side_effect": "write",
          "tracey.tool.result.class": "success",
          prompt: "private input",
          result: "private output",
          "user.email": "private@example.com",
        },
      }],
    }) as { spans: Array<{ attributes: Record<string, unknown> }> };
    assert.deepEqual(result.spans[0]?.attributes, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "create_note",
      "tracey.tool.side_effect": "write",
      "tracey.tool.result.class": "success",
    });
  });

  it("keeps authoritative Codex run totals ahead of bounded per-run evidence", () => {
    const result = safeInvestigationResult("investigate_codex_conversation", {
      conversationId: crypto.randomUUID(),
      normalizationProfile: "codex-otel-0.144@1",
      rejectedLogs: 2,
      runs: [
        { runId: "run-1", status: "complete" },
        { runId: "run-2", status: "complete" },
        { runId: "run-3", status: "incomplete" },
      ],
    }) as { runCount: number; statusCounts: Record<string, number>; rejectedLogs: number };

    assert.equal(result.runCount, 3);
    assert.deepEqual(result.statusCounts, { complete: 2, incomplete: 1 });
    assert.equal(result.rejectedLogs, 2);
  });

  it("summarizes recent Codex logs without exposing content fields", () => {
    const result = safeInvestigationResult("search_codex_logs", {
      logs: [
        { timestamp: "2026-07-18T12:00:00Z", body: "codex.tool.call", attributes: { "conversation.id": crypto.randomUUID(), tool_name: "exec_command", success: true, duration_ms: 42, prompt: "private" } },
        { timestamp: "2026-07-18T12:00:01Z", body: "codex.tool.result", attributes: { "conversation.id": crypto.randomUUID(), tool_name: "exec_command", success: false, "error.type": "TimeoutError", output: "private" } },
      ],
      rejectedRows: 1,
    }) as { logCount: number; conversationCount: number; tools: string[]; failures: number; events: Array<Record<string, unknown>> };
    assert.equal(result.logCount, 2);
    assert.equal(result.conversationCount, 2);
    assert.deepEqual(result.tools, ["exec_command"]);
    assert.equal(result.failures, 1);
    assert.doesNotMatch(JSON.stringify(result), /private|prompt|output/);
  });

  it("treats successful Kubernetes reads as citable operational evidence", () => {
    const evidence = collectCitableEvidence("list_pods", {}, {
      scopes: ["production"],
      pods: [{
        name: "checkout-api-7b9f",
        namespace: "production",
        phase: "Running",
        containers: [{ name: "api", ready: true, restartCount: 0, state: "running" }],
      }],
    });

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.sourceType, "kubernetes");
    assert.equal(evidence[0]?.sourceId, "pods:production");
    assert.equal(evidence[0]?.signal, "kubernetes.pods");
    assert.match(evidence[0]?.observation ?? "", /1 pod.*production\/checkout-api-7b9f.*Running/);
  });

  it("does not manufacture registry evidence when no agents were returned", () => {
    assert.deepEqual(collectCitableEvidence("list_agents", {}, { agents: [] }), []);
  });

  it("resolves a named app across registry identity and Kubernetes workloads", () => {
    const agent = {
      agentId: crypto.randomUUID(), displayName: "Notes Assistant", serviceName: "notes-agent-api",
      environment: "development", status: "active", producerType: "custom_otel",
    };
    const absent = resolveApplicationStatus("notes app is live?", [agent], []);
    assert.equal(absent.status, "registered_but_no_running_kubernetes_workload_observed");
    assert.equal(absent.registryMatches[0]?.serviceName, "notes-agent-api");
    assert.equal(absent.matchingPods.length, 0);

    const running = resolveApplicationStatus("notes app is live?", [agent], [{
      name: "notes-api-6f74b78c74-dbzlv", namespace: "development", phase: "Running",
      containers: [{ ready: true, restartCount: 0 }],
    }]);
    assert.equal(running.status, "running_in_kubernetes");
    assert.equal(running.readyPodCount, 1);
  });

  it("creates citable evidence for application status resolution", () => {
    const evidence = collectCitableEvidence("resolve_application_status", { query: "notes app" }, {
      status: "registered_but_no_running_kubernetes_workload_observed",
      registryMatches: [{ serviceName: "notes-agent-api" }],
      matchingPods: [],
    });
    assert.equal(evidence[0]?.signal, "tracey.application.status");
    assert.match(evidence[0]?.observation ?? "", /1 registry match.*0 matching pods/);
  });

  it("creates citable evidence for a validated agent deployment mapping", () => {
    const evidence = collectCitableEvidence("get_agent_deployment", {
      agentId: crypto.randomUUID(),
    }, {
      mapping: {
        namespace: "production",
        workloadName: "notes-api",
      },
      health: {
        desiredReplicas: 3,
        readyReplicas: 2,
        totalRestarts: 4,
      },
    });
    assert.equal(evidence[0]?.sourceType, "kubernetes");
    assert.equal(evidence[0]?.sourceId, "agent-deployment:production/notes-api");
    assert.match(evidence[0]?.observation ?? "", /2\/3 replicas ready.*4 container restarts/);
  });

  it("creates citable evidence for a durable remediation proposal", () => {
    const proposalId = crypto.randomUUID();
    const evidence = collectCitableEvidence("propose_remediation", {}, {
      action: {
        proposalId,
        target: "kube-system/coredns-589f44dc88-rvsm8",
        status: "awaiting_approval",
      },
      decision: { decision: "require_approval" },
    });
    assert.equal(evidence[0]?.sourceType, "tracey");
    assert.equal(evidence[0]?.sourceId, `action:${proposalId}`);
    assert.match(evidence[0]?.observation ?? "", /awaiting_approval/);
  });

  it("returns the durable approval result when model synthesis cannot finish", () => {
    assert.equal(durableProposalMessage({
      action: {
        proposalId: "proposal-123",
        target: "notes-production/notes-api",
        status: "awaiting_approval",
      },
      decision: {
        decision: "require_approval",
        reasons: ["approval mode requires an administrator decision"],
      },
    }), "Change proposal proposal-123 is ready for confirmation for notes-production/notes-api. Review the approval card and approve or reject it; nothing has been executed.");
  });

  it("resolves relative Codex windows deterministically in epoch milliseconds", () => {
    const now = 1_784_368_000_000;
    const resolved = resolveCodexToolArguments({
      conversationId: "019f68cf-12e1-7871-9fa6-e3a6325f3a48",
      serviceName: "codex-app-server",
      lookbackMinutes: 10,
    }, now);

    assert.deepEqual(resolved, {
      conversationId: "019f68cf-12e1-7871-9fa6-e3a6325f3a48",
      serviceName: "codex-app-server",
      start: now - 600_000,
      end: now,
    });
    assert.throws(() => resolveCodexToolArguments({
      conversationId: "019f68cf-12e1-7871-9fa6-e3a6325f3a48",
      start: now - 600_000,
      end: now,
      lookbackMinutes: 10,
    }, now), /either lookbackMinutes or start\/end/);
  });

  it("persists user and assistant turns and removes citations not returned by tools", async (context) => {
    const messages: InvestigationMessage[] = [];
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved: InvestigationMessage = {
          ...input,
          messageId: crypto.randomUUID(),
          evidenceRefs: input.evidenceRefs ?? [],
          createdAt: new Date().toISOString(),
        };
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
    } as unknown as PostgresStore;
    context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
      model: "tencent/hy3:free",
      choices: [{ message: { role: "assistant", content: `No telemetry was queried [trace:${"a".repeat(32)}]` } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const agent = new AgenticInvestigator({
      apiKey: "not-exported", model: "tencent/hy3:free", tenantId: "tenant-a", environment: "test",
    }, {} as InvestigationService, store);

    const result = await agent.chat(crypto.randomUUID(), "What happened?");

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[1]?.role, "assistant");
    assert.match(result.content, /unverified citation removed/);
    assert.equal(result.grounding, "model_only");
  });

  it("continues immediately when the model asks the user to wait", async (context) => {
    const messages: InvestigationMessage[] = [];
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() } as InvestigationMessage;
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
    } as unknown as PostgresStore;
    let request = 0;
    context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      request += 1;
      if (request === 2) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
        assert.match(body.messages.at(-1)?.content ?? "", /Continue the investigation now/);
      }
      return new Response(JSON.stringify(request === 1 ? {
        choices: [{ message: { role: "assistant", content: "Please hold on while I check each agent." } }],
      } : {
        choices: [{ message: { role: "assistant", content: "The investigation is complete; no telemetry source was queried." } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = new AgenticInvestigator({
      apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test",
    }, {} as InvestigationService, store);

    const result = await agent.chat(crypto.randomUUID(), "Check every agent");

    assert.equal(request, 2);
    assert.doesNotMatch(result.content, /hold on|let me try/i);
    assert.match(result.content, /investigation is complete/i);
  });

  it("scans every registered agent with one aggregate failure-search tool call", async (context) => {
    const messages: InvestigationMessage[] = [];
    const customTraceId = "a".repeat(32);
    const codexTraceId = "b".repeat(32);
    const agents = [
      {
        agentId: crypto.randomUUID(), displayName: "Notes Assistant", serviceName: "notes-agent-api",
        producerType: "custom_otel", environment: "test", normalizationProfile: "otel@1",
        telemetryContractVersion: "1", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      {
        agentId: crypto.randomUUID(), displayName: "Codex Desktop", serviceName: "codex-app-server",
        producerType: "codex_desktop", environment: "test", normalizationProfile: "codex@1",
        telemetryContractVersion: "1", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ];
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() } as InvestigationMessage;
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
      listAgents: async () => agents,
      recordAgentToolAudit: async () => undefined,
    } as unknown as PostgresStore;
    const investigations = {
      searchAgentRuns: async () => ({
        runs: [{ traceId: customTraceId, runId: "notes-run-1", serviceName: "notes-agent-api", outcome: "failed", startedAt: new Date().toISOString() }],
        rejectedRows: 0, query: {},
      }),
      getCodexRecentLogs: async () => ({
        logs: [{ timestamp: new Date().toISOString(), traceId: codexTraceId, body: "codex.api_request", attributes: { success: false, "error.type": "TimeoutError", "event.name": "codex.api_request" } }],
        rejectedRows: 0, query: {},
      }),
    } as unknown as InvestigationService;
    let request = 0;
    context.mock.method(globalThis, "fetch", async () => {
      request += 1;
      return new Response(JSON.stringify(request === 1 ? {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "scan-1", type: "function", function: {
          name: "search_failed_agent_runs", arguments: JSON.stringify({ lookbackMinutes: 1_440 }),
        } }] } }],
      } : {
        choices: [{ message: { role: "assistant", content: `Notes Assistant had one failed run [trace:${customTraceId}]. Codex Desktop had one failure signal [trace:${codexTraceId}].` } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = new AgenticInvestigator({
      apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test",
    }, investigations, store);

    const result = await agent.chat(crypto.randomUUID(), "Which agents failed in the last 24 hours?");

    assert.equal(result.toolCallCount, 1);
    assert.equal(result.grounding, "evidence_bound");
    assert.equal(result.evidenceRefs.length, 2);
    assert.match(result.content, /Notes Assistant had one failed run/);
    assert.match(result.content, /Codex Desktop had one failure signal/);
  });

  it("fails closed when tools return no citable evidence", async (context) => {
    const messages: InvestigationMessage[] = [];
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved: InvestigationMessage = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() };
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
      listAgents: async () => [],
      recordAgentToolAudit: async () => undefined,
    } as unknown as PostgresStore;
    let request = 0;
    context.mock.method(globalThis, "fetch", async () => {
      request += 1;
      return new Response(JSON.stringify(request === 1 ? {
        model: "tencent/hy3:free",
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "list_agents", arguments: "{\"limit\":50}" } }] } }],
      } : {
        model: "tencent/hy3:free",
        choices: [{ message: { role: "assistant", content: "All production agents are healthy." } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = new AgenticInvestigator({ apiKey: "not-exported", model: "tencent/hy3:free", tenantId: "tenant-a", environment: "test" }, {} as InvestigationService, store);

    const result = await agent.chat(crypto.randomUUID(), "Are production agents healthy?");

    assert.equal(result.grounding, "tool_grounded");
    assert.equal(result.evidenceRefs.length, 0);
    assert.match(result.content, /could not verify any technical findings/i);
    assert.doesNotMatch(result.content, /agents are healthy/i);
  });

  it("reports the exact tool limitation when a grounded check cannot run", async (context) => {
    const messages: InvestigationMessage[] = [];
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved: InvestigationMessage = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() };
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
      recordAgentToolAudit: async () => undefined,
    } as unknown as PostgresStore;
    let request = 0;
    context.mock.method(globalThis, "fetch", async () => {
      request += 1;
      return new Response(JSON.stringify(request === 1 ? {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "pods-1", type: "function", function: { name: "list_pods", arguments: "{}" } }] } }],
      } : {
        choices: [{ message: { role: "assistant", content: "The Kubernetes check could not run." } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = new AgenticInvestigator({
      apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test", allowedNamespaces: [],
    }, {} as InvestigationService, store);

    const result = await agent.chat(crypto.randomUUID(), "Inspect active Kubernetes pods.");

    assert.equal(result.grounding, "tool_grounded");
    assert.match(result.content, /list_pods: No Kubernetes namespaces are connected to Tracey/i);
    assert.doesNotMatch(result.content, /adjust the service, identifier, or time range/i);
  });

  it("routes model remediation plans through the policy service", async (context) => {
    const messages: InvestigationMessage[] = [];
    let evaluated = false;
    const mappedAgentId = crypto.randomUUID();
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() } as InvestigationMessage;
        messages.push(saved);
        return saved;
      },
      listInvestigationMessages: async () => messages,
      recordAgentToolAudit: async () => undefined,
      listAgents: async () => [{
        agentId: mappedAgentId, displayName: "Sample Agent", serviceName: "sample-agent-api",
        environment: "test", status: "active", producerType: "custom_otel",
      }],
      getAgentDeploymentMapping: async () => ({
        agentId: mappedAgentId, namespace: "production", workloadName: "sample-workload",
        containerName: "api", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      getAutonomyPolicy: async () => ({
        policyId: crypto.randomUUID(), scopeType: "global", scopeId: "default", version: 1, enabled: true,
        createdBy: "admin", updatedBy: "admin", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        policy: { mode: "approval", environments: ["test"], namespaces: ["production"], workloads: ["sample-workload"],
          allowedActions: ["restart_workload"], automaticActions: [], prohibitedActions: [], minimumConfidence: 0.9,
          maximumAutomaticRisk: "medium", maxReplicas: 10, maxConcurrentActions: 1, cooldownMinutes: 0 },
      }),
    } as unknown as PostgresStore;
    let verificationServiceName: string | undefined;
    const autonomy = {
      evaluatePlan: async (input: { plan: { verification: { serviceName: string } } }) => {
        evaluated = true;
        verificationServiceName = input.plan.verification.serviceName;
        return { decision: { decision: "require_approval", reasons: ["approval mode"], evaluatedAt: new Date().toISOString() }, action: { status: "awaiting_approval" } };
      },
    } as unknown as AutonomyService;
    let call = 0;
    context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 2) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
        assert.match(body.messages.at(-1)?.content ?? "", /explicitly requested an infrastructure change/i);
      }
      return new Response(JSON.stringify(call === 1 ? {
        choices: [{ message: { role: "assistant", content: "The workload may benefit from a restart. Would you like to proceed with an action?" } }],
      } : call === 2 ? {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "plan-1", type: "function", function: {
          name: "propose_remediation", arguments: JSON.stringify({
            action: { type: "restart_workload", namespace: "production", workload: "sample-workload" },
            summary: "Restart unhealthy workload", reason: "All replicas are unavailable", confidence: 0.98,
            risk: "low", reversible: true, expectedImpact: "Restore ready replicas", blastRadius: { workloads: 1, estimatedUnavailableReplicas: 1 }, evidenceRefs: [],
            verification: { serviceName: "sample-api", timeoutSeconds: 300, lookbackSeconds: 300, minimumSampleCount: 5, settleSeconds: 5, requireWorkloadReady: true, maxErrorRateIncrease: 0, maxLatencyIncreasePercent: 10 },
          }),
        } }] } }],
      } : { choices: [{ message: { role: "assistant", content: "Plan recorded for approval." } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = new AgenticInvestigator({ apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test" }, {} as InvestigationService, store, autonomy);
    const result = await agent.chat(crypto.randomUUID(), "Restart sample-workload", { subject: "analyst-a", roles: ["analyst"] });
    assert.equal(evaluated, true);
    assert.equal(verificationServiceName, "sample-agent-api");
    assert.equal(call, 3);
    assert.equal(result.content, "Plan recorded for approval.");
  });

  it("executes the latest pending action after explicit administrator confirmation without another model call", async (context) => {
    const messages: InvestigationMessage[] = [];
    const pending = {
      proposalId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      actionType: "restart" as const,
      target: "kube-system/coredns-589f44dc88-rvsm8",
      reason: "Administrator requested a restart",
      parameters: { type: "restart_pod", namespace: "kube-system", workload: "coredns-589f44dc88-rvsm8" },
      risk: "low" as const,
      status: "awaiting_approval" as const,
      proposedBy: "admin-a",
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    let approved = false;
    let audited = false;
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() } as InvestigationMessage;
        messages.push(saved);
        return saved;
      },
      getLatestPendingActionProposal: async () => pending,
      decideActionProposal: async () => {
        approved = true;
        return { ...pending, status: "approved" as const, approvedBy: "admin-a" };
      },
      recordAgentToolAudit: async () => { audited = true; },
    } as unknown as PostgresStore;
    const autonomy = {
      execute: async () => ({ ...pending, status: "succeeded" as const, approvedBy: "admin-a" }),
    } as unknown as AutonomyService;
    context.mock.method(globalThis, "fetch", async () => {
      throw new Error("OpenRouter must not be called for a pending action confirmation");
    });
    const agent = new AgenticInvestigator({
      apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test",
    }, {} as InvestigationService, store, autonomy);

    const result = await agent.chat(pending.sessionId, "yes proceed", { subject: "admin-a", roles: ["admin"] });

    assert.equal(approved, true);
    assert.equal(audited, true);
    assert.equal(result.grounding, "evidence_bound");
    assert.equal(result.toolCallCount, 1);
    assert.match(result.content, /completed successfully/i);
    assert.equal((result.evidenceRefs[0] as { sourceId: string }).sourceId, `action:${pending.proposalId}`);
  });

  it("does not execute a pending action when confirmation is not from an administrator", async () => {
    const messages: InvestigationMessage[] = [];
    const pending = {
      proposalId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      actionType: "restart" as const,
      target: "production/sample-api",
      reason: "Restart requested",
      parameters: {},
      risk: "low" as const,
      status: "awaiting_approval" as const,
      proposedBy: "analyst-a",
      idempotencyKey: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const store = {
      appendInvestigationMessage: async (_tenantId: string, input: Omit<InvestigationMessage, "messageId" | "createdAt">) => {
        const saved = { ...input, messageId: crypto.randomUUID(), evidenceRefs: input.evidenceRefs ?? [], createdAt: new Date().toISOString() } as InvestigationMessage;
        messages.push(saved);
        return saved;
      },
      getLatestPendingActionProposal: async () => pending,
    } as unknown as PostgresStore;
    const agent = new AgenticInvestigator({
      apiKey: "test", model: "test-model", tenantId: "tenant-a", environment: "test",
    }, {} as InvestigationService, store, {} as AutonomyService);

    const result = await agent.chat(pending.sessionId, "confirm", { subject: "analyst-a", roles: ["analyst"] });

    assert.match(result.content, /requires an administrator/i);
    assert.equal(result.grounding, "evidence_bound");
  });
});
