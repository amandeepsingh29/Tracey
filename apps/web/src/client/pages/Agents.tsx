"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Bot, Braces, Clock3, Plus, Search, ShieldCheck, TriangleAlert } from "lucide-react";
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
    <PageHeader eyebrow="AGENT FLEET" title="Production agents" description="Discover health, telemetry readiness, runs, tools, and incidents for every connected agent." actions={<Button onClick={() => setRegisterOpen(true)}><Plus size={16} />Register agent</Button>} />
    <div className="filter-bar"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents or services" aria-label="Search agents" /></label><select value={environment} onChange={(event) => setEnvironment(event.target.value)} aria-label="Filter by environment"><option value="all">All environments</option>{environments.map((value) => <option key={value}>{value}</option>)}</select><select value={producer} onChange={(event) => setProducer(event.target.value)} aria-label="Filter by producer"><option value="all">All producers</option><option value="codex_desktop">Codex Desktop</option><option value="codex_cli">Codex CLI</option><option value="claude_code">Claude Code</option><option value="custom_otel">Custom OpenTelemetry</option></select></div>
    {query.isLoading ? <LoadingState label="Loading registered agents" /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : filtered.length === 0 ? <EmptyState icon={Bot} title={query.data?.agents.length ? "No agents match these filters" : "No production agents registered"} description={query.data?.agents.length ? "Adjust the search or environment filters." : "Register a Codex, Claude Code, or custom OpenTelemetry agent to begin monitoring real runs."} action={!query.data?.agents.length && <Button onClick={() => setRegisterOpen(true)}><Plus size={16} />Register first agent</Button>} /> : <div className="agent-grid">{filtered.map((agent) => <AgentCard key={agent.agentId} agent={agent} />)}</div>}
    <RegisterAgentModal open={registerOpen} onClose={() => setRegisterOpen(false)} />
  </div>;
}

function AgentCard({ agent }: { agent: Agent }) {
  return <Link href={`/agents/${agent.agentId}`} className="agent-card"><header><div className="agent-avatar"><Bot /></div><StatusChip value={agent.status} /></header><h2>{agent.displayName}</h2><code>{agent.serviceName}</code><div className="agent-meta"><span>{titleCase(agent.producerType)}</span><span>{agent.environment}</span></div><footer><span>Updated {relativeTime(agent.updatedAt)}</span><ArrowRight size={16} /></footer></Link>;
}

function RegisterAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const mutation = useMutation({ mutationFn: api.createAgent, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["agents"] }); onClose(); }, onError: (failure) => setError(failure.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(undefined);
    const values = new FormData(event.currentTarget);
    mutation.mutate({ displayName: String(values.get("displayName")), serviceName: String(values.get("serviceName")), producerType: String(values.get("producerType")) as Agent["producerType"], environment: String(values.get("environment")), normalizationProfile: String(values.get("normalizationProfile")), telemetryContractVersion: String(values.get("telemetryContractVersion")) });
  };
  return <Modal open={open} onClose={onClose} title="Register production agent" description="Tracey stores only service identity and telemetry-contract metadata—never agent credentials."><form className="form-stack" onSubmit={submit}><div className="form-grid"><Field label="Display name"><input name="displayName" required maxLength={128} placeholder="Support triage agent" /></Field><Field label="Service name" hint="Must match OpenTelemetry service.name"><input name="serviceName" required pattern="[A-Za-z0-9_.\-/]+" placeholder="support-agent-api" /></Field><Field label="Producer"><select name="producerType" defaultValue="custom_otel"><option value="custom_otel">Custom OpenTelemetry</option><option value="codex_desktop">Codex Desktop</option><option value="codex_cli">Codex CLI</option><option value="claude_code">Claude Code</option></select></Field><Field label="Environment"><input name="environment" required defaultValue="development" /></Field><Field label="Normalization profile"><input name="normalizationProfile" required defaultValue="tracey.agent.v1" /></Field><Field label="Telemetry contract"><input name="telemetryContractVersion" required defaultValue="1.0.0" /></Field></div>{error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={mutation.isPending}>{mutation.isPending ? "Registering…" : "Register agent"}</Button></footer></form></Modal>;
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
  const incidents = useQuery({ queryKey: ["incidents", agentId], queryFn: () => api.incidents(), enabled: Boolean(agent), retry: false });
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
  const relatedIncidents = (incidents.data?.incidents ?? []).filter((incident) => incident.affectedAgentIds.includes(agentId));
  return <div className="page">
    <button className="back-link" onClick={() => router.push("/agents")}><ArrowLeft size={15} />All agents</button>
    <PageHeader eyebrow={`${titleCase(agent.producerType)} · ${agent.environment}`} title={agent.displayName} description={agent.serviceName} actions={<><Button variant="secondary" onClick={() => router.push(`/runs?agent=${agent.agentId}`)}><Activity size={16} />Explore runs</Button><Button onClick={() => router.push(`/investigations?new=true&agent=${agent.agentId}`)}><Search size={16} />Investigate</Button></>} />
    <section className="metrics-grid"><MetricCard label="Runs · 24h" value={runs.error ? "—" : list.length} detail="Observed in SigNoz" icon={Activity} /><MetricCard label="Failure rate" value={list.length ? `${((failed / list.length) * 100).toFixed(1)}%` : "—"} detail={list.length ? `${failed} failed runs` : "No samples available"} icon={TriangleAlert} tone={failed ? "danger" : "default"} /><MetricCard label="P50 / P95 latency" value={`${duration(p50)} / ${duration(p95)}`} detail={durations.length ? `${durations.length} measured runs` : "No duration samples"} icon={Clock3} /><MetricCard label="Evidence complete" value={list.length ? `${Math.round((complete / list.length) * 100)}%` : "—"} detail="Required telemetry present" icon={ShieldCheck} /><MetricCard label="Observed tokens" value={tokenUsage ? tokenUsage.toLocaleString() : "—"} detail={tokenUsage ? "Sanitized model spans" : "Token attributes not emitted"} icon={Braces} /><MetricCard label="Estimated cost" value={costNano ? `$${(costNano / 1_000_000_000).toFixed(4)}` : "—"} detail={costNano ? "Emitted pricing telemetry" : "Cost attributes not emitted"} icon={Activity} /></section>
    <div className="two-column"><Panel title="Identity and deployment" subtitle="Registration metadata used to scope production evidence."><dl className="detail-list"><div><dt>Service</dt><dd><code>{agent.serviceName}</code></dd></div><div><dt>Environment</dt><dd>{agent.environment}</dd></div><div><dt>Producer</dt><dd>{titleCase(agent.producerType)}</dd></div><div><dt>Status</dt><dd><StatusChip value={agent.status} /></dd></div><div><dt>Normalization</dt><dd>{agent.normalizationProfile}</dd></div><div><dt>Contract</dt><dd>{agent.telemetryContractVersion}</dd></div></dl></Panel><Panel title="Telemetry readiness" subtitle="Tracey reports observed completeness—it does not invent missing signals.">{runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : list.length === 0 ? <EmptyState icon={Braces} title="No runs observed in this window" description={agent.producerType.startsWith("codex") ? "Codex telemetry is conversation-based. Start an investigation with an exact conversation ID." : "Confirm the service is exporting Tracey’s agent-run contract to the connected OpenTelemetry Collector."} /> : <div className="readiness-list"><div><CheckMark ok={true} label="Root agent runs discovered" /><CheckMark ok={complete > 0} label="Complete evidence contract observed" /><CheckMark ok={list.some(({ model }) => Boolean(model))} label="Model identity attributes observed" /></div></div>}</Panel></div>
    <Panel title="Recent runs" subtitle="Latest observed agent activity from the last 24 hours.">{runs.isLoading ? <LoadingState /> : runs.error ? <ErrorState error={runs.error} /> : list.length === 0 ? <EmptyState title="No recent runs" description="Tracey will show live runs as soon as SigNoz returns matching telemetry." /> : <div className="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Duration</th><th>Model</th><th>Started</th></tr></thead><tbody>{list.slice(0, 20).map((run) => <tr key={`${run.runId}-${run.traceId}`} onClick={() => router.push(`/runs/${run.traceId}?start=${start}&end=${end}`)} tabIndex={0}><td><code>{run.runId}</code></td><td><StatusChip value={run.status ?? run.outcome ?? "unknown"} /></td><td>{duration(run.durationMs)}</td><td>{run.model ?? "—"}</td><td>{relativeTime(run.startedAt ?? run.startTime)}</td></tr>)}</tbody></table></div>}</Panel>
    <div className="two-column"><Panel title="Models and tool performance" subtitle="Derived only from sanitized spans in the sampled runs."><dl className="detail-list"><div><dt>Models observed</dt><dd>{models.length ? models.join(", ") : "Not emitted"}</dd></div><div><dt>Tool calls</dt><dd>{toolSpans.length || "Not emitted"}</dd></div><div><dt>Tool failures</dt><dd>{toolSpans.length ? toolSpans.filter((span) => span.hasError).length : "—"}</dd></div><div><dt>Average tool latency</dt><dd>{toolSpans.length ? duration(toolSpans.reduce((sum, span) => sum + Number(span.durationMs ?? 0), 0) / toolSpans.length) : "—"}</dd></div></dl></Panel><Panel title="Related incidents and deployment"><dl className="detail-list"><div><dt>Related incidents</dt><dd>{relatedIncidents.length}</dd></div><div><dt>Deployment identity</dt><dd><code>{agent.serviceName}</code></dd></div><div><dt>Environment</dt><dd>{agent.environment}</dd></div><div><dt>Kubernetes workload</dt><dd>Not linked in agent metadata</dd></div></dl>{relatedIncidents.length > 0 && <div className="related-list">{relatedIncidents.map((incident) => <button key={incident.incidentId} onClick={() => router.push(`/incidents/${incident.incidentId}`)}><strong>{incident.title}</strong><StatusChip value={incident.status} /></button>)}</div>}</Panel></div>
  </div>;
}

function CheckMark({ ok, label }: { ok: boolean; label: string }) { return <div className={ok ? "check-row check-ok" : "check-row"}><span>{ok ? "✓" : "!"}</span><strong>{label}</strong></div>; }
