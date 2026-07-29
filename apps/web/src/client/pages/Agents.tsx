"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Bot, Braces, Cable, CheckCircle2, Clock3, Copy, Link2, Plus, RefreshCw, Search, Server, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button, EmptyState, ErrorState, Field, LoadingState, MetricCard, Modal, PageHeader, Panel, StatusChip } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { duration, relativeTime, titleCase } from "../lib/format";
import type { Agent, AgentDeployment, AgentOnboardingSource, ExecutionSource } from "../types";

export function connectedAgents(agents: Agent[], sources: AgentOnboardingSource[]) {
  const connectedTypes = new Set(sources.map(({ producerType }) => producerType));
  return agents.filter(({ producerType }) => connectedTypes.has(producerType));
}

export function agentProducerFilterOptions(agents: Agent[], sources: AgentOnboardingSource[]) {
  const sourceNames = new Map(sources.map((source) => [source.producerType, source.displayName]));
  return [...new Set(agents.map(({ producerType }) => producerType))]
    .filter((producerType) => sourceNames.has(producerType))
    .map((producerType) => ({ producerType, displayName: sourceNames.get(producerType)! }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function AgentsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [registerOpen, setRegisterOpen] = useState(params.get("register") === "true");
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [environment, setEnvironment] = useState(params.get("environment") ?? "all");
  const [producer, setProducer] = useState(params.get("producer") ?? "all");
  const query = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  useEffect(() => { const current = new URLSearchParams(); if (search) current.set("search", search); if (environment !== "all") current.set("environment", environment); if (producer !== "all") current.set("producer", producer); const suffix = current.toString(); router.replace(suffix ? `/agents?${suffix}` : "/agents", { scroll: false }); }, [search, environment, producer, router]);
  const sources = connectors.data?.agentOnboardingSources ?? [];
  const availableAgents = useMemo(() => connectedAgents(query.data?.agents ?? [], sources), [query.data, sources]);
  const producerOptions = useMemo(() => agentProducerFilterOptions(availableAgents, sources), [availableAgents, sources]);
  useEffect(() => {
    if (producer !== "all" && !producerOptions.some((option) => option.producerType === producer)) setProducer("all");
  }, [producer, producerOptions]);
  const filtered = useMemo(() => availableAgents.filter((agent) => {
    const term = search.toLowerCase();
    return (!term || agent.displayName.toLowerCase().includes(term) || agent.serviceName.toLowerCase().includes(term))
      && (environment === "all" || agent.environment === environment)
      && (producer === "all" || agent.producerType === producer);
  }), [availableAgents, search, environment, producer]);
  const environments = [...new Set(availableAgents.map(({ environment: value }) => value))];
  const telemetry = useQuery({
    queryKey: ["agent-directory-executions"],
    queryFn: () => { const end = Date.now(); return api.executions(end - 7 * 86_400_000, end, 200); },
    enabled: availableAgents.length > 0,
    retry: false,
  });

  return <div className="page">
    <PageHeader eyebrow="AGENT FLEET" title="Production agents" description="Discover health, telemetry readiness, runs, and tools for every connected agent." actions={<Button onClick={() => setRegisterOpen(true)}><Plus size={16} />Connect agent</Button>} />
    <div className="filter-bar"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents or services" aria-label="Search agents" /></label><select value={environment} onChange={(event) => setEnvironment(event.target.value)} aria-label="Filter by environment"><option value="all">All environments</option>{environments.map((value) => <option key={value}>{value}</option>)}</select>{producerOptions.length > 1 && <select value={producer} onChange={(event) => setProducer(event.target.value)} aria-label="Filter by producer"><option value="all">All connected producers</option>{producerOptions.map((option) => <option value={option.producerType} key={option.producerType}>{option.displayName}</option>)}</select>}</div>
    {query.isLoading || connectors.isLoading ? <LoadingState label="Loading connected agents" /> : query.error || connectors.error ? <ErrorState error={query.error ?? connectors.error} onRetry={() => { void query.refetch(); void connectors.refetch(); }} /> : filtered.length === 0 ? <EmptyState icon={availableAgents.length ? Bot : Cable} title={availableAgents.length ? "No agents match these filters" : sources.length ? "No agents registered" : "No agent producer connected"} description={availableAgents.length ? "Adjust the active filters." : sources.length ? "Register an OpenTelemetry agent to begin monitoring real executions." : "Enable an agent producer connector before registering an agent."} action={!availableAgents.length && <Button onClick={() => sources.length ? setRegisterOpen(true) : router.push("/connectors")}><Plus size={16} />{sources.length ? "Register first agent" : "Manage connectors"}</Button>} /> : <div className="agent-grid">{filtered.map((agent) => <AgentCard key={agent.agentId} agent={agent} source={telemetry.data?.sources.find(({ sourceId }) => sourceId === `agent:${agent.agentId}`)} producerName={sources.find(({ producerType }) => producerType === agent.producerType)?.displayName ?? titleCase(agent.producerType)} />)}</div>}
    <ConnectAgentModal open={registerOpen} onClose={() => setRegisterOpen(false)} />
  </div>;
}

function AgentCard({ agent, source, producerName }: { agent: Agent; source: ExecutionSource | undefined; producerName: string }) {
  const telemetryStatus = agent.status === "paused" ? "paused" : source?.status === "complete" && source.observedExecutions > 0 ? "observed" : source?.status === "unavailable" ? "unavailable" : "registered";
  return <Link href={`/agents/${agent.agentId}`} className="agent-card"><header><div className="agent-avatar"><Bot /></div><StatusChip value={telemetryStatus} /></header><h2>{agent.displayName}</h2><code>{agent.serviceName}</code><div className="agent-meta"><span>{producerName}</span><span>{agent.environment}</span></div><footer><span>{telemetryStatus === "observed" ? `${source?.observedExecutions ?? 0} executions observed` : "Identity registered"}</span><ArrowRight size={16} /></footer></Link>;
}

type ConnectionStep = "source" | "setup" | "identity" | "verify";

export async function verifyRegisteredAgent(agent: Agent): Promise<{ observed: boolean; count: number; limitation?: string }> {
  const end = Date.now();
  const feed = await api.executions(end - 7 * 86_400_000, end, 200);
  const sourceId = `agent:${agent.agentId}`;
  const source = feed.sources.find((item) => item.sourceId === sourceId);
  const count = feed.executions.filter((execution) => execution.sourceId === sourceId).length;
  return { observed: count > 0, count, ...(source?.limitation ? { limitation: source.limitation } : {}) };
}

function ConnectAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors, enabled: open });
  const [step, setStep] = useState<ConnectionStep>("source");
  const [sourceId, setSourceId] = useState("");
  const [registered, setRegistered] = useState<Agent>();
  const [verification, setVerification] = useState<{ observed: boolean; count: number; limitation?: string }>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const sources = connectors.data?.agentOnboardingSources ?? [];
  const defaultSource = sources.find(({ isDefault }) => isDefault) ?? sources[0];
  const setup = sources.find((source) => source.sourceId === sourceId) ?? defaultSource;
  useEffect(() => {
    if (open && defaultSource && !sources.some((source) => source.sourceId === sourceId)) setSourceId(defaultSource.sourceId);
  }, [defaultSource, open, sourceId, sources]);
  const reset = () => { setStep("source"); setSourceId(""); setRegistered(undefined); setVerification(undefined); setError(undefined); setCopied(false); };
  const close = () => { reset(); onClose(); };
  const registration = useMutation({
    mutationFn: api.createAgent,
    onSuccess: async (agent) => {
      setRegistered(agent);
      setStep("verify");
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      try {
        setVerification(await verifyRegisteredAgent(agent));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Tracey could not query the connected evidence source.");
      }
    },
    onError: (failure) => setError(failure.message),
  });
  const verify = useMutation({
    mutationFn: verifyRegisteredAgent,
    onSuccess: setVerification,
    onError: (failure) => setError(failure.message),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(undefined);
    const values = new FormData(event.currentTarget);
    if (!setup) return;
    registration.mutate({ sourceId: setup.sourceId, displayName: String(values.get("displayName")), serviceName: String(values.get("serviceName")), environment: String(values.get("environment")) });
  };
  const copyConfiguration = async () => {
    try {
      if (!setup) return;
      await navigator.clipboard.writeText(setup.configurationTemplate);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("The browser could not copy this configuration. Select the text and copy it manually.");
    }
  };
  const titles: Record<ConnectionStep, string> = { source: "Connect an agent", setup: `Set up ${setup?.displayName ?? "agent"}`, identity: "Confirm telemetry identity", verify: "Verify first execution" };
  const descriptions: Record<ConnectionStep, string> = {
    source: "Choose where the agent runs. Tracey will show only the instructions and fields required for that source.",
    setup: "Configure the real producer, restart it if required, and generate one normal execution.",
    identity: "These values must match the telemetry exported by the agent. Tracey does not store the agent’s model credentials.",
    verify: "Tracey queries the connected evidence source now. Registration alone is not treated as a successful connection.",
  };

  return <Modal open={open} onClose={close} title={titles[step]} description={descriptions[step]}>
    <div className="connection-progress" aria-label="Connection progress">{(["source", "setup", "identity", "verify"] as ConnectionStep[]).map((item, index) => <span key={item} className={item === step ? "active" : index < ["source", "setup", "identity", "verify"].indexOf(step) ? "complete" : ""}>{index + 1}</span>)}</div>
    {step === "source" && <div className="connection-body">{connectors.isLoading ? <LoadingState label="Loading enabled agent connectors" /> : connectors.error ? <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} /> : sources.length === 0 ? <EmptyState icon={Cable} title="No agent producer connected" description="Enable an agent producer connector before registering an agent." action={<Button onClick={() => { close(); router.push("/connectors"); }}>Manage connectors</Button>} /> : <><div className="producer-choice-grid">{sources.map((item) => <button type="button" key={item.sourceId} className={setup?.sourceId === item.sourceId ? "active" : ""} onClick={() => setSourceId(item.sourceId)}><Bot /><div><strong>{item.displayName}</strong><p>{item.description}</p></div>{setup?.sourceId === item.sourceId && <CheckCircle2 />}</button>)}</div><footer className="modal-actions"><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!setup} onClick={() => setStep("setup")}>Continue<ArrowRight size={15} /></Button></footer></>}</div>}
    {step === "setup" && setup && <div className="connection-body"><ol className="setup-checklist">{setup.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol><div className="configuration-block"><header><span>Configuration</span><button type="button" onClick={() => void copyConfiguration()}>{copied ? <CheckCircle2 /> : <Copy />}{copied ? "Copied" : "Copy"}</button></header><pre>{setup.configurationTemplate}</pre></div><p className="connection-note">Registration stores the expected identity only. Tracey will not mark this agent observed until matching telemetry is returned.</p><footer className="modal-actions"><Button variant="secondary" onClick={() => setStep("source")}>Back</Button><Button onClick={() => setStep("identity")}>I configured it<ArrowRight size={15} /></Button></footer></div>}
    {step === "identity" && setup && <form className="form-stack connection-form" onSubmit={submit}><div className="form-grid"><Field label="Display name" hint="A readable name shown inside Tracey"><input name="displayName" required maxLength={128} defaultValue={setup.displayNameSuggestion} placeholder="Support triage agent" /></Field><Field label="Service name" hint="Must exactly match OpenTelemetry service.name"><input name="serviceName" required pattern="[A-Za-z0-9_.\-/]+" defaultValue={setup.serviceNameSuggestion} placeholder="support-agent-api" /></Field><Field label="Environment" hint="Must match Tracey’s configured telemetry scope"><input name="environment" required defaultValue="development" /></Field><Field label="Telemetry contract"><input value={`${setup.normalizationProfile} · ${setup.telemetryContractVersion}`} readOnly /></Field></div>{error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={() => setStep("setup")}>Back</Button><Button disabled={registration.isPending}>{registration.isPending ? "Registering…" : "Register identity"}<ArrowRight size={15} /></Button></footer></form>}
    {step === "verify" && registered && <div className="connection-body verification-step"><div className="registered-identity"><CheckCircle2 /><div><strong>Identity registered</strong><code>{registered.serviceName}</code><p>Telemetry verification is still separate.</p></div></div>{verification?.observed ? <div className="verification-success"><CheckCircle2 /><div><strong>Execution observed</strong><p>Tracey found {verification.count} matching execution{verification.count === 1 ? "" : "s"} in the last seven days.</p></div></div> : verification ? <div className="verification-waiting"><RefreshCw /><div><strong>Registered, waiting for telemetry</strong><p>{verification.limitation ?? `No execution matching ${registered.serviceName} has arrived yet. Run the agent once, wait a few seconds, then retry.`}</p></div></div> : <div className="verification-waiting"><Activity /><div><strong>Ready to query live evidence</strong><p>Run one normal agent request first if you have not already.</p></div></div>}{error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-actions"><Button variant="secondary" onClick={() => verify.mutate(registered)} disabled={verify.isPending}>{verify.isPending ? "Checking evidence…" : verification ? "Check again" : "Verify execution"}</Button><Button onClick={() => { close(); router.push(`/agents/${registered.agentId}?linkDeployment=true`); }}><Link2 size={15} />Link deployment</Button><Button variant="ghost" onClick={() => { close(); router.push(verification?.observed ? `/runs?source=${encodeURIComponent(`agent:${registered.agentId}`)}` : `/agents/${registered.agentId}`); }}>{verification?.observed ? "View executions" : "Finish later"}</Button></footer></div>}
  </Modal>;
}

export function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deploymentOpen, setDeploymentOpen] = useState(searchParams.get("linkDeployment") === "true");
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const agent = agents.data?.agents.find((item) => item.agentId === agentId);
  const deployment = useQuery({
    queryKey: ["agent-deployment", agentId],
    queryFn: async () => {
      try {
        return await api.agentDeployment(agentId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(agent),
    retry: false,
  });
  const end = Date.now(), start = end - 24 * 60 * 60 * 1_000;
  const runs = useQuery({ queryKey: ["agent-executions", agentId, start], queryFn: () => api.executions(start, end, 200), enabled: Boolean(agent) });
  const sourceId = `agent:${agentId}`;
  const list = (runs.data?.executions ?? []).filter((execution) => execution.sourceId === sourceId);
  const source = runs.data?.sources.find((item) => item.sourceId === sourceId);
  const traced = list.filter((execution): execution is typeof execution & { traceId: string } => Boolean(execution.traceId));
  const traceQueries = useQueries({ queries: traced.slice(0, 20).map((execution) => ({ queryKey: ["agent-run-trace", execution.traceId, start, end], queryFn: () => api.trace(execution.traceId, start, end), staleTime: 30_000, retry: false })) });
  if (agents.isLoading) return <div className="page"><LoadingState /></div>;
  if (agents.error) return <div className="page"><ErrorState error={agents.error} /></div>;
  if (!agent) return <div className="page"><EmptyState title="Agent not found" description="This agent may have been removed or belongs to another workspace." /></div>;
  const failed = list.filter(({ status }) => status === "failed").length;
  const durations = list.map(({ durationMs }) => durationMs).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * .5))] : undefined;
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * .95))] : undefined;
  const spans = traceQueries.flatMap((query) => query.data?.spans ?? []);
  const attribute = (span: typeof spans[number], names: string[]) => names.map((name) => (span.attributes as Record<string, unknown> | undefined)?.[name]).find((value) => value !== undefined);
  const models = [...new Set([...list.map(({ model }) => model), ...spans.map((span) => attribute(span, ["gen_ai.request.model", "gen_ai.response.model", "llm.model_name", "tracey.model"]))].filter((value): value is string => typeof value === "string"))];
  const tokenUsage = list.reduce((sum, execution) => sum + Number(execution.inputTokens ?? 0) + Number(execution.outputTokens ?? 0), 0);
  const costNano = spans.reduce((sum, span) => sum + Number(attribute(span, ["tracey.cost.nano_usd", "gen_ai.usage.cost_nano_usd"]) ?? 0), 0);
  const toolSpans = spans.filter((span) => Boolean(attribute(span, ["gen_ai.tool.name", "tracey.tool.name", "tool.name"])) || String(span.name).toLowerCase().includes("tool"));
  const observedTools = list.reduce((sum, execution) => sum + execution.tools.length, 0);
  const producerName = connectors.data?.agentOnboardingSources.find(({ producerType }) => producerType === agent.producerType)?.displayName ?? titleCase(agent.producerType);
  const openExecution = (execution: typeof list[number]) => {
    if (execution.conversationId) {
      router.push(`/runs/${encodeURIComponent(`conversation:${execution.conversationId}`)}?conversationId=${encodeURIComponent(execution.conversationId)}&serviceName=${encodeURIComponent(execution.serviceName)}&at=${Date.parse(execution.startedAt)}&start=${start}&end=${end}`);
    } else if (execution.traceId) {
      router.push(`/runs/${encodeURIComponent(execution.traceId)}?start=${start}&end=${end}`);
    }
  };
  return <div className="page">
    <button className="back-link" onClick={() => router.push("/agents")}><ArrowLeft size={15} />All agents</button>
    <PageHeader eyebrow={`${producerName} · ${agent.environment}`} title={agent.displayName} description={agent.serviceName} actions={<><Button variant="secondary" onClick={() => router.push(`/runs?source=${encodeURIComponent(sourceId)}`)}><Activity size={16} />Explore runs</Button><Button onClick={() => router.push(`/investigations?new=true&agent=${agent.agentId}`)}><Search size={16} />Investigate</Button></>} />
    <section className="metrics-grid"><MetricCard label="Runs · 24h" value={runs.error ? "—" : list.length} detail="Observed in the connected execution feed" icon={Activity} /><MetricCard label="Failure rate" value={list.length ? `${((failed / list.length) * 100).toFixed(1)}%` : "—"} detail={list.length ? `${failed} failed runs` : "No samples available"} icon={TriangleAlert} tone={failed ? "danger" : "default"} /><MetricCard label="P50 / P95 latency" value={`${duration(p50)} / ${duration(p95)}`} detail={durations.length ? `${durations.length} measured runs` : "No duration samples"} icon={Clock3} /><MetricCard label="Telemetry source" value={source ? titleCase(source.status) : "—"} detail={source?.limitation ?? "Current connector query state"} icon={ShieldCheck} /><MetricCard label="Observed tokens" value={tokenUsage ? tokenUsage.toLocaleString() : "—"} detail={tokenUsage ? "Emitted by the producer" : "Token attributes not emitted"} icon={Braces} /><MetricCard label="Estimated cost" value={costNano ? `$${(costNano / 1_000_000_000).toFixed(4)}` : "—"} detail={costNano ? "Emitted pricing telemetry" : "Cost attributes not emitted"} icon={Activity} /></section>
    <div className="two-column"><Panel title="Identity and deployment" subtitle="Registration metadata used to scope production evidence."><dl className="detail-list"><div><dt>Service</dt><dd><code>{agent.serviceName}</code></dd></div><div><dt>Environment</dt><dd>{agent.environment}</dd></div><div><dt>Producer</dt><dd>{producerName}</dd></div><div><dt>Status</dt><dd><StatusChip value={agent.status} /></dd></div><div><dt>Normalization</dt><dd>{agent.normalizationProfile}</dd></div><div><dt>Contract</dt><dd>{agent.telemetryContractVersion}</dd></div></dl></Panel><Panel title="Telemetry readiness" subtitle="Registration and observed telemetry are separate states.">{runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : list.length === 0 ? <EmptyState icon={Braces} title="Registered, no execution observed" description={source?.limitation ?? "Run the agent once and confirm it exports telemetry to the connected OpenTelemetry Collector."} /> : <div className="readiness-list"><div><CheckMark ok={true} label="Execution observed" /><CheckMark ok={list.some(({ model }) => Boolean(model))} label="Model identity attributes observed" /><CheckMark ok={observedTools > 0} label="Tool activity observed" /></div></div>}</Panel></div>
    <Panel title="Recent runs" subtitle="Latest observed agent activity from the last 24 hours.">{runs.isLoading ? <LoadingState /> : runs.error ? <ErrorState error={runs.error} /> : list.length === 0 ? <EmptyState title="No recent runs" description="Tracey will show live runs as soon as the connected source returns matching telemetry." /> : <div className="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Duration</th><th>Model</th><th>Started</th></tr></thead><tbody>{list.slice(0, 20).map((execution) => <tr key={execution.executionId} onClick={() => openExecution(execution)} tabIndex={execution.traceId || execution.conversationId ? 0 : -1}><td><code>{execution.runId}</code></td><td><StatusChip value={execution.status} /></td><td>{duration(execution.durationMs)}</td><td>{execution.model ?? "—"}</td><td>{relativeTime(execution.startedAt)}</td></tr>)}</tbody></table></div>}</Panel>
    <div className="two-column"><Panel title="Models and tool performance" subtitle="Derived only from emitted execution metadata and sanitized spans."><dl className="detail-list"><div><dt>Models observed</dt><dd>{models.length ? models.join(", ") : "Not emitted"}</dd></div><div><dt>Tool calls</dt><dd>{Math.max(observedTools, toolSpans.length) || "Not emitted"}</dd></div><div><dt>Tool failures</dt><dd>{toolSpans.length ? toolSpans.filter((span) => span.hasError).length : "—"}</dd></div><div><dt>Average tool latency</dt><dd>{toolSpans.length ? duration(toolSpans.reduce((sum, span) => sum + Number(span.durationMs ?? 0), 0) / toolSpans.length) : "—"}</dd></div></dl></Panel><DeploymentPanel deployment={deployment.data} loading={deployment.isLoading} error={deployment.error} onRetry={() => void deployment.refetch()} onEdit={() => setDeploymentOpen(true)} /></div>
    <LinkDeploymentModal agent={agent} current={deployment.data ?? undefined} open={deploymentOpen} onClose={() => { setDeploymentOpen(false); router.replace(`/agents/${agent.agentId}`, { scroll: false }); }} />
  </div>;
}

function CheckMark({ ok, label }: { ok: boolean; label: string }) { return <div className={ok ? "check-row check-ok" : "check-row"}><span>{ok ? "✓" : "!"}</span><strong>{label}</strong></div>; }

function DeploymentPanel({ deployment, loading, error, onRetry, onEdit }: {
  deployment: AgentDeployment | null | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onEdit: () => void;
}) {
  if (loading) return <Panel title="Deployment mapping" subtitle="Resolving the infrastructure that runs this agent."><LoadingState label="Loading deployment health" /></Panel>;
  if (error) return <Panel title="Deployment mapping" subtitle="Tracey could not read the mapped infrastructure."><ErrorState error={error} onRetry={onRetry} /><Button variant="secondary" onClick={onEdit}>Edit mapping</Button></Panel>;
  if (!deployment) return <Panel title="Deployment mapping" subtitle="Connect telemetry to the Kubernetes Deployment that runs this agent."><EmptyState icon={Server} title="No deployment linked" description="Link a live Deployment so Tracey can combine run failures with replicas, pods, restarts, images, and rollout state." action={<Button variant="secondary" onClick={onEdit}><Link2 size={15} />Link deployment</Button>} /></Panel>;
  const { mapping, health } = deployment;
  return <Panel title="Deployment health" subtitle={`${mapping.namespace}/${mapping.workloadName} · observed ${relativeTime(deployment.observedAt)}`}>
    <div className={health.ready ? "deployment-health healthy" : "deployment-health unhealthy"}><span /><div><strong>{health.ready ? "Healthy rollout" : "Deployment needs attention"}</strong><p>{health.readyReplicas}/{health.desiredReplicas} replicas ready · {health.pods.length} pods · {health.totalRestarts} restarts</p></div><StatusChip value={health.ready ? "ready" : "degraded"} /></div>
    <dl className="detail-list"><div><dt>Workload</dt><dd><code>{mapping.workloadKind}/{mapping.workloadName}</code></dd></div><div><dt>Container</dt><dd>{mapping.containerName ?? "All containers"}</dd></div><div><dt>Image</dt><dd>{health.containers.find(({ name }) => !mapping.containerName || name === mapping.containerName)?.image ?? "Not reported"}</dd></div><div><dt>Updated / available</dt><dd>{health.updatedReplicas} / {health.availableReplicas}</dd></div></dl>
    <Button variant="secondary" onClick={onEdit}>Edit mapping</Button>
  </Panel>;
}

function LinkDeploymentModal({ agent, current, open, onClose }: {
  agent: Agent;
  current: AgentDeployment | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [namespace, setNamespace] = useState(current?.mapping.namespace ?? "");
  const [workloadName, setWorkloadName] = useState(current?.mapping.workloadName ?? "");
  const [containerName, setContainerName] = useState(current?.mapping.containerName ?? "");
  useEffect(() => {
    if (!open) return;
    setNamespace(current?.mapping.namespace ?? "");
    setWorkloadName(current?.mapping.workloadName ?? "");
    setContainerName(current?.mapping.containerName ?? "");
  }, [current, open]);
  const namespaces = useQuery({ queryKey: ["kubernetes-namespaces"], queryFn: api.kubernetesNamespaces, enabled: open, retry: false });
  useEffect(() => {
    if (!namespace && namespaces.data?.namespaces[0]) setNamespace(namespaces.data.namespaces[0]);
  }, [namespace, namespaces.data]);
  const deployments = useQuery({
    queryKey: ["kubernetes-deployments", namespace],
    queryFn: () => api.kubernetesDeployments(namespace),
    enabled: open && Boolean(namespace),
    retry: false,
  });
  useEffect(() => {
    const available = deployments.data?.deployments ?? [];
    const first = available[0];
    if (first && !available.some(({ name }) => name === workloadName)) {
      setWorkloadName(first.name);
      setContainerName("");
    }
  }, [deployments.data, workloadName]);
  const selected = deployments.data?.deployments.find(({ name }) => name === workloadName);
  const save = useMutation({
    mutationFn: () => api.saveAgentDeployment(agent.agentId, {
      namespace,
      workloadName,
      ...(containerName ? { containerName } : {}),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-deployment", agent.agentId] });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAgentDeployment(agent.agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-deployment", agent.agentId] });
      onClose();
    },
  });
  return <Modal open={open} onClose={onClose} title="Link Kubernetes deployment" description={`Choose the live Deployment that runs ${agent.displayName}. Tracey validates the target before saving it.`}>
    <div className="form-stack">
      {namespaces.isLoading ? <LoadingState label="Discovering connected namespaces" /> : namespaces.error ? <ErrorState error={namespaces.error} onRetry={() => void namespaces.refetch()} /> : <>
        <Field label="Namespace" hint="Discovered from the connected Kubernetes API"><select value={namespace} onChange={(event) => { setNamespace(event.target.value); setWorkloadName(""); setContainerName(""); }}>{namespaces.data?.namespaces.map((value) => <option key={value}>{value}</option>)}</select></Field>
        {deployments.isLoading ? <LoadingState label="Discovering deployments" /> : deployments.error ? <ErrorState error={deployments.error} onRetry={() => void deployments.refetch()} /> : deployments.data?.deployments.length ? <>
          <Field label="Deployment" hint="Only real Deployments returned by Kubernetes are selectable"><select value={workloadName} onChange={(event) => { setWorkloadName(event.target.value); setContainerName(""); }}>{deployments.data.deployments.map((item) => <option value={item.name} key={item.name}>{item.name} · {item.readyReplicas}/{item.desiredReplicas} ready</option>)}</select></Field>
          <Field label="Container" hint="Optional; choose the agent container when the pod has sidecars"><select value={containerName} onChange={(event) => setContainerName(event.target.value)}><option value="">All containers</option>{selected?.containers.map((container) => <option value={container.name} key={container.name}>{container.name}{container.image ? ` · ${container.image}` : ""}</option>)}</select></Field>
          {selected && <div className="deployment-preview"><Server /><div><strong>{selected.namespace}/{selected.name}</strong><p>{selected.readyReplicas}/{selected.desiredReplicas} ready · {selected.containers.length} container{selected.containers.length === 1 ? "" : "s"}</p></div></div>}
        </> : <EmptyState icon={Server} title="No Deployments found" description={`Kubernetes returned no Deployments in ${namespace || "this namespace"}.`} />}
      </>}
      {(save.error || remove.error) && <p className="form-error" role="alert">{(save.error ?? remove.error)?.message}</p>}
      <footer className="modal-actions">{current && <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 size={15} />Unlink</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!namespace || !workloadName || save.isPending}>{save.isPending ? "Validating…" : "Validate and link"}</Button></footer>
    </div>
  </Modal>;
}
