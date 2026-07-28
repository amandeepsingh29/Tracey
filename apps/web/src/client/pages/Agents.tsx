"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Bot, Braces, CheckCircle2, Clock3, Code2, Copy, Laptop, Plus, RefreshCw, Search, ShieldCheck, TerminalSquare, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button, EmptyState, ErrorState, Field, LoadingState, MetricCard, Modal, PageHeader, Panel, StatusChip } from "../components/ui";
import { api } from "../lib/api";
import { duration, relativeTime, titleCase } from "../lib/format";
import type { Agent } from "../types";

export function AgentsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [registerOpen, setRegisterOpen] = useState(params.get("register") === "true");
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [environment, setEnvironment] = useState(params.get("environment") ?? "all");
  const [producer, setProducer] = useState(params.get("producer") ?? "all");
  const query = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  useEffect(() => { const current = new URLSearchParams(); if (search) current.set("search", search); if (environment !== "all") current.set("environment", environment); if (producer !== "all") current.set("producer", producer); const suffix = current.toString(); router.replace(suffix ? `/agents?${suffix}` : "/agents", { scroll: false }); }, [search, environment, producer, router]);
  const filtered = useMemo(() => (query.data?.agents ?? []).filter((agent) => {
    const term = search.toLowerCase();
    return (!term || agent.displayName.toLowerCase().includes(term) || agent.serviceName.toLowerCase().includes(term))
      && (environment === "all" || agent.environment === environment)
      && (producer === "all" || agent.producerType === producer);
  }), [query.data, search, environment, producer]);
  const environments = [...new Set((query.data?.agents ?? []).map(({ environment: value }) => value))];

  return <div className="page">
    <PageHeader eyebrow="AGENT FLEET" title="Production agents" description="Discover health, telemetry readiness, runs, and tools for every connected agent." actions={<Button onClick={() => setRegisterOpen(true)}><Plus size={16} />Connect agent</Button>} />
    <div className="filter-bar"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents or services" aria-label="Search agents" /></label><select value={environment} onChange={(event) => setEnvironment(event.target.value)} aria-label="Filter by environment"><option value="all">All environments</option>{environments.map((value) => <option key={value}>{value}</option>)}</select><select value={producer} onChange={(event) => setProducer(event.target.value)} aria-label="Filter by producer"><option value="all">All producers</option><option value="codex_desktop">Codex Desktop</option><option value="codex_cli">Codex CLI</option><option value="claude_code">Claude Code</option><option value="custom_otel">Custom OpenTelemetry</option></select></div>
    {query.isLoading ? <LoadingState label="Loading registered agents" /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : filtered.length === 0 ? <EmptyState icon={Bot} title={query.data?.agents.length ? "No agents match these filters" : "No production agents registered"} description={query.data?.agents.length ? "Adjust the search or environment filters." : "Register a Codex, Claude Code, or custom OpenTelemetry agent to begin monitoring real runs."} action={!query.data?.agents.length && <Button onClick={() => setRegisterOpen(true)}><Plus size={16} />Register first agent</Button>} /> : <div className="agent-grid">{filtered.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)}</div>}
    <ConnectAgentModal open={registerOpen} onClose={() => setRegisterOpen(false)} />
  </div>;
}

function AgentCard({ agent }: { agent: Agent }) {
  return <Link href={`/agents/${agent.agentId}`} className="agent-card"><header><div className="agent-avatar"><Bot /></div><StatusChip value={agent.status} /></header><h2>{agent.displayName}</h2><code>{agent.serviceName}</code><div className="agent-meta"><span>{titleCase(agent.producerType)}</span><span>{agent.environment}</span></div><footer><span>Updated {relativeTime(agent.updatedAt)}</span><ArrowRight size={16} /></footer></Link>;
}

type ConnectionStep = "source" | "setup" | "identity" | "verify";
type ProducerType = Agent["producerType"];

const producerSetup: Record<ProducerType, {
  name: string;
  description: string;
  serviceName: string;
  displayName: string;
  normalizationProfile: string;
  telemetryContractVersion: string;
  instructions: string[];
  configuration: string;
  icon: typeof Bot;
}> = {
  codex_desktop: {
    name: "Codex app",
    description: "Trace prompts, responses, commands, tools, and results from this Codex desktop app.",
    serviceName: "codex-app-server",
    displayName: "Codex App Server",
    normalizationProfile: "codex-otel-0.144@1",
    telemetryContractVersion: "codex-native-otel@1",
    instructions: ["Keep Tracey’s local forensic connector enabled.", "Add the OpenTelemetry exporter below to ~/.codex/config.toml.", "Restart Codex, then complete one normal prompt."],
    configuration: `[otel]
environment = "development"
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "binary"

[otel.trace_exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/traces"
protocol = "binary"`,
    icon: Laptop,
  },
  codex_cli: {
    name: "Codex CLI",
    description: "Observe standalone Codex CLI executions and their tool activity.",
    serviceName: "Codex Desktop",
    displayName: "Codex CLI",
    normalizationProfile: "codex-otel-0.144@1",
    telemetryContractVersion: "codex-native-otel@1",
    instructions: ["Add the OpenTelemetry exporter below to ~/.codex/config.toml.", "Start a new Codex CLI process after saving the file.", "Run one prompt that performs a normal tool call."],
    configuration: `[otel]
environment = "development"
log_user_prompt = false

[otel.exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "binary"

[otel.trace_exporter."otlp-http"]
endpoint = "http://127.0.0.1:4318/v1/traces"
protocol = "binary"`,
    icon: TerminalSquare,
  },
  claude_code: {
    name: "Claude Code",
    description: "Observe Claude Code interactions through its native OpenTelemetry hierarchy.",
    serviceName: "claude-code",
    displayName: "Claude Code",
    normalizationProfile: "claude-code-native-beta@1",
    telemetryContractVersion: "claude-code-otel@1",
    instructions: ["Export these variables in the shell that launches Claude Code.", "Restart Claude Code from that shell.", "Complete one interaction containing a model request and tool execution."],
    configuration: `export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`,
    icon: Code2,
  },
  custom_otel: {
    name: "Custom OpenTelemetry agent",
    description: "Connect an independently deployed agent that emits Tracey’s agent.run contract.",
    serviceName: "",
    displayName: "",
    normalizationProfile: "tracey.agent.v1",
    telemetryContractVersion: "1.0.0",
    instructions: ["Set a stable service.name for the agent.", "Export OTLP traces to Tracey’s collector.", "Emit an agent.run root span, then execute one real agent request."],
    configuration: `export OTEL_SERVICE_NAME=your-agent-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Root span contract
# name: agent.run
# attributes: tracey.run.id, tracey.agent.name,
# tracey.agent.version, deployment.environment.name`,
    icon: Bot,
  },
};

export async function verifyRegisteredAgent(agent: Agent): Promise<{ observed: boolean; count: number; limitation?: string }> {
  if (agent.producerType === "codex_desktop" || agent.producerType === "codex_cli") {
    try {
      const local = await api.recentCodexConversations(168, 20);
      if (local.conversations.length > 0) return { observed: true, count: local.conversations.length };
    } catch {
      // A disabled local forensic connector can still be verified through SigNoz.
    }
    const end = Date.now();
    const feed = await api.executions(end - 7 * 86_400_000, end, 200);
    const count = feed.executions.filter(({ serviceName }) => serviceName === agent.serviceName).length;
    const source = feed.sources.find(({ serviceName }) => serviceName === agent.serviceName);
    return { observed: count > 0, count, ...(source?.limitation ? { limitation: source.limitation } : {}) };
  }
  const end = Date.now();
  const result = await api.agentRuns(agent.agentId, { start: end - 7 * 86_400_000, end, limit: 20 });
  return { observed: result.runs.length > 0, count: result.runs.length };
}

function ConnectAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<ConnectionStep>("source");
  const [producerType, setProducerType] = useState<ProducerType>("codex_desktop");
  const [registered, setRegistered] = useState<Agent>();
  const [verification, setVerification] = useState<{ observed: boolean; count: number; limitation?: string }>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const setup = producerSetup[producerType];
  const reset = () => { setStep("source"); setProducerType("codex_desktop"); setRegistered(undefined); setVerification(undefined); setError(undefined); setCopied(false); };
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
    registration.mutate({ displayName: String(values.get("displayName")), serviceName: String(values.get("serviceName")), producerType, environment: String(values.get("environment")), normalizationProfile: setup.normalizationProfile, telemetryContractVersion: setup.telemetryContractVersion });
  };
  const copyConfiguration = async () => {
    try {
      await navigator.clipboard.writeText(setup.configuration);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("The browser could not copy this configuration. Select the text and copy it manually.");
    }
  };
  const titles: Record<ConnectionStep, string> = { source: "Connect an agent", setup: `Set up ${setup.name}`, identity: "Confirm observed identity", verify: "Verify first execution" };
  const descriptions: Record<ConnectionStep, string> = {
    source: "Choose where the agent runs. Tracey will show only the instructions and fields required for that source.",
    setup: "Configure the real producer, restart it if required, and generate one normal execution.",
    identity: "These values must match the telemetry exported by the agent. Tracey does not store the agent’s model credentials.",
    verify: "Tracey queries the connected evidence source now. Registration alone is not treated as a successful connection.",
  };

  return <Modal open={open} onClose={close} title={titles[step]} description={descriptions[step]}>
    <div className="connection-progress" aria-label="Connection progress">{(["source", "setup", "identity", "verify"] as ConnectionStep[]).map((item, index) => <span key={item} className={item === step ? "active" : index < ["source", "setup", "identity", "verify"].indexOf(step) ? "complete" : ""}>{index + 1}</span>)}</div>
    {step === "source" && <div className="connection-body"><div className="producer-choice-grid">{(Object.entries(producerSetup) as Array<[ProducerType, typeof setup]>).map(([value, item]) => { const Icon = item.icon; return <button type="button" key={value} className={producerType === value ? "active" : ""} onClick={() => setProducerType(value)}><Icon /><div><strong>{item.name}</strong><p>{item.description}</p></div>{producerType === value && <CheckCircle2 />}</button>; })}</div><footer className="modal-actions"><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => setStep("setup")}>Continue<ArrowRight size={15} /></Button></footer></div>}
    {step === "setup" && <div className="connection-body"><ol className="setup-checklist">{setup.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol><div className="configuration-block"><header><span>Configuration</span><button type="button" onClick={() => void copyConfiguration()}>{copied ? <CheckCircle2 /> : <Copy />}{copied ? "Copied" : "Copy"}</button></header><pre>{setup.configuration}</pre></div><p className="connection-note">Tracey will not simulate an execution. If no matching telemetry arrives, verification remains incomplete and explains what to check.</p><footer className="modal-actions"><Button variant="secondary" onClick={() => setStep("source")}>Back</Button><Button onClick={() => setStep("identity")}>I configured it<ArrowRight size={15} /></Button></footer></div>}
    {step === "identity" && <form className="form-stack connection-form" onSubmit={submit}><div className="form-grid"><Field label="Display name" hint="A readable name shown inside Tracey"><input name="displayName" required maxLength={128} defaultValue={setup.displayName} placeholder="Support triage agent" /></Field><Field label="Service name" hint="Must exactly match OpenTelemetry service.name"><input name="serviceName" required pattern="[A-Za-z0-9_.\-/ ]+" defaultValue={setup.serviceName} placeholder="support-agent-api" /></Field><Field label="Environment" hint="Must match Tracey’s configured telemetry scope"><input name="environment" required defaultValue="development" /></Field><Field label="Detected contract"><input value={`${setup.normalizationProfile} · ${setup.telemetryContractVersion}`} readOnly /></Field></div>{error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={() => setStep("setup")}>Back</Button><Button disabled={registration.isPending}>{registration.isPending ? "Registering…" : "Register and verify"}<ArrowRight size={15} /></Button></footer></form>}
    {step === "verify" && registered && <div className="connection-body verification-step"><div className="registered-identity"><CheckCircle2 /><div><strong>{registered.displayName} is registered</strong><code>{registered.serviceName}</code></div></div>{verification?.observed ? <div className="verification-success"><CheckCircle2 /><div><strong>Execution observed</strong><p>Tracey found {verification.count} matching execution{verification.count === 1 ? "" : "s"} in the last seven days.</p></div></div> : verification ? <div className="verification-waiting"><RefreshCw /><div><strong>Waiting for the first execution</strong><p>{verification.limitation ?? `No execution matching ${registered.serviceName} has arrived yet. Run the agent once, wait a few seconds, then retry.`}</p></div></div> : <div className="verification-waiting"><Activity /><div><strong>Ready to query live evidence</strong><p>Run one normal agent request first if you have not already.</p></div></div>}{error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-actions"><Button variant="secondary" onClick={() => verify.mutate(registered)} disabled={verify.isPending}>{verify.isPending ? "Checking evidence…" : verification ? "Check again" : "Verify execution"}</Button>{verification?.observed ? <Button onClick={() => { close(); router.push(registered.producerType.startsWith("codex") ? "/runs" : `/agents/${registered.agentId}`); }}>View execution<ArrowRight size={15} /></Button> : <Button variant="ghost" onClick={() => { close(); router.push(`/agents/${registered.agentId}`); }}>Finish later</Button>}</footer></div>}
  </Modal>;
}

export function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params.agentId ?? "";
  const router = useRouter();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  const agent = agents.data?.agents.find((item) => item.agentId === agentId);
  const end = Date.now(), start = end - 24 * 60 * 60 * 1_000;
  const runs = useQuery({ queryKey: ["agent-runs", agentId, start], queryFn: () => api.agentRuns(agentId, { start, end, limit: 50 }), enabled: Boolean(agent) && !["codex_desktop", "codex_cli"].includes(agent?.producerType ?? "") });
  const list = runs.data?.runs ?? [];
  const traceQueries = useQueries({ queries: list.slice(0, 20).map((run) => ({ queryKey: ["agent-run-trace", run.traceId, start, end], queryFn: () => api.trace(run.traceId, start, end), staleTime: 30_000, retry: false })) });
  if (agents.isLoading) return <div className="page"><LoadingState /></div>;
  if (agents.error) return <div className="page"><ErrorState error={agents.error} /></div>;
  if (!agent) return <div className="page"><EmptyState title="Agent not found" description="This agent may have been removed or belongs to another workspace." /></div>;
  const failed = list.filter((run) => ["error", "failed", "failure"].includes(String(run.status ?? run.outcome).toLowerCase())).length;
  const durations = list.map(({ durationMs }) => durationMs).filter((value): value is number => typeof value === "number").sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * .5))] : undefined;
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * .95))] : undefined;
  const complete = list.filter(({ evidenceCompleteness }) => evidenceCompleteness === "complete").length;
  const spans = traceQueries.flatMap((query) => query.data?.spans ?? []);
  const attribute = (span: typeof spans[number], names: string[]) => names.map((name) => (span.attributes as Record<string, unknown> | undefined)?.[name]).find((value) => value !== undefined);
  const models = [...new Set(spans.map((span) => attribute(span, ["gen_ai.request.model", "gen_ai.response.model", "llm.model_name", "tracey.model"])).filter((value): value is string => typeof value === "string"))];
  const tokenUsage = spans.reduce((sum, span) => sum + Number(attribute(span, ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "llm.token_count.prompt", "llm.token_count.completion"]) ?? 0), 0);
  const costNano = spans.reduce((sum, span) => sum + Number(attribute(span, ["tracey.cost.nano_usd", "gen_ai.usage.cost_nano_usd"]) ?? 0), 0);
  const toolSpans = spans.filter((span) => Boolean(attribute(span, ["gen_ai.tool.name", "tracey.tool.name", "tool.name"])) || String(span.name).toLowerCase().includes("tool"));
  return <div className="page">
    <button className="back-link" onClick={() => router.push("/agents")}><ArrowLeft size={15} />All agents</button>
    <PageHeader eyebrow={`${titleCase(agent.producerType)} · ${agent.environment}`} title={agent.displayName} description={agent.serviceName} actions={<><Button variant="secondary" onClick={() => router.push(`/runs?agent=${agent.agentId}`)}><Activity size={16} />Explore runs</Button><Button onClick={() => router.push(`/investigations?new=true&agent=${agent.agentId}`)}><Search size={16} />Investigate</Button></>} />
    <section className="metrics-grid"><MetricCard label="Runs · 24h" value={runs.error ? "—" : list.length} detail="Observed in SigNoz" icon={Activity} /><MetricCard label="Failure rate" value={list.length ? `${((failed / list.length) * 100).toFixed(1)}%` : "—"} detail={list.length ? `${failed} failed runs` : "No samples available"} icon={TriangleAlert} tone={failed ? "danger" : "default"} /><MetricCard label="P50 / P95 latency" value={`${duration(p50)} / ${duration(p95)}`} detail={durations.length ? `${durations.length} measured runs` : "No duration samples"} icon={Clock3} /><MetricCard label="Evidence complete" value={list.length ? `${Math.round((complete / list.length) * 100)}%` : "—"} detail="Required telemetry present" icon={ShieldCheck} /><MetricCard label="Observed tokens" value={tokenUsage ? tokenUsage.toLocaleString() : "—"} detail={tokenUsage ? "Sanitized model spans" : "Token attributes not emitted"} icon={Braces} /><MetricCard label="Estimated cost" value={costNano ? `$${(costNano / 1_000_000_000).toFixed(4)}` : "—"} detail={costNano ? "Emitted pricing telemetry" : "Cost attributes not emitted"} icon={Activity} /></section>
    <div className="two-column"><Panel title="Identity and deployment" subtitle="Registration metadata used to scope production evidence."><dl className="detail-list"><div><dt>Service</dt><dd><code>{agent.serviceName}</code></dd></div><div><dt>Environment</dt><dd>{agent.environment}</dd></div><div><dt>Producer</dt><dd>{titleCase(agent.producerType)}</dd></div><div><dt>Status</dt><dd><StatusChip value={agent.status} /></dd></div><div><dt>Normalization</dt><dd>{agent.normalizationProfile}</dd></div><div><dt>Contract</dt><dd>{agent.telemetryContractVersion}</dd></div></dl></Panel><Panel title="Telemetry readiness" subtitle="Tracey reports observed completeness—it does not invent missing signals.">{runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : list.length === 0 ? <EmptyState icon={Braces} title="No runs observed in this window" description={agent.producerType.startsWith("codex") ? "Codex telemetry is conversation-based. Start an investigation with an exact conversation ID." : "Confirm the service is exporting Tracey’s agent-run contract to the connected OpenTelemetry Collector."} /> : <div className="readiness-list"><div><CheckMark ok={true} label="Root agent runs discovered" /><CheckMark ok={complete > 0} label="Complete evidence contract observed" /><CheckMark ok={list.some(({ model }) => Boolean(model))} label="Model identity attributes observed" /></div></div>}</Panel></div>
    <Panel title="Recent runs" subtitle="Latest observed agent activity from the last 24 hours.">{runs.isLoading ? <LoadingState /> : runs.error ? <ErrorState error={runs.error} /> : list.length === 0 ? <EmptyState title="No recent runs" description="Tracey will show live runs as soon as SigNoz returns matching telemetry." /> : <div className="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Duration</th><th>Model</th><th>Started</th></tr></thead><tbody>{list.slice(0, 20).map((run) => <tr key={`${run.runId}-${run.traceId}`} onClick={() => router.push(`/runs/${run.traceId}?start=${start}&end=${end}`)} tabIndex={0}><td><code>{run.runId}</code></td><td><StatusChip value={run.status ?? run.outcome ?? "unknown"} /></td><td>{duration(run.durationMs)}</td><td>{run.model ?? "—"}</td><td>{relativeTime(run.startedAt ?? run.startTime)}</td></tr>)}</tbody></table></div>}</Panel>
    <div className="two-column"><Panel title="Models and tool performance" subtitle="Derived only from sanitized spans in the sampled runs."><dl className="detail-list"><div><dt>Models observed</dt><dd>{models.length ? models.join(", ") : "Not emitted"}</dd></div><div><dt>Tool calls</dt><dd>{toolSpans.length || "Not emitted"}</dd></div><div><dt>Tool failures</dt><dd>{toolSpans.length ? toolSpans.filter((span) => span.hasError).length : "—"}</dd></div><div><dt>Average tool latency</dt><dd>{toolSpans.length ? duration(toolSpans.reduce((sum, span) => sum + Number(span.durationMs ?? 0), 0) / toolSpans.length) : "—"}</dd></div></dl></Panel><Panel title="Deployment mapping" subtitle="Connect this agent identity to the infrastructure that runs it."><dl className="detail-list"><div><dt>Deployment identity</dt><dd><code>{agent.serviceName}</code></dd></div><div><dt>Environment</dt><dd>{agent.environment}</dd></div><div><dt>Kubernetes workload</dt><dd>Not linked in agent metadata</dd></div></dl><Button variant="secondary" onClick={() => router.push("/connectors?connector=kubernetes")}>Configure Kubernetes</Button></Panel></div>
  </div>;
}

function CheckMark({ ok, label }: { ok: boolean; label: string }) { return <div className={ok ? "check-row check-ok" : "check-row"}><span>{ok ? "✓" : "!"}</span><strong>{label}</strong></div>; }
