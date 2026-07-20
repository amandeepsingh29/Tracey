"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, ExternalLink, GitBranch, Search, ShieldCheck, Timer, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, JsonView, LoadingState, PageHeader, Panel, StatusChip } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, duration } from "../lib/format";

const day = 86_400_000;

export function RunsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "all");
  const [agentFilter, setAgentFilter] = useState(params.get("agent") ?? "all");
  const [environment, setEnvironment] = useState(params.get("environment") ?? "all");
  const [model, setModel] = useState(params.get("model") ?? "");
  const [tool, setTool] = useState(params.get("tool") ?? "");
  const [rangeHours, setRangeHours] = useState(Number(params.get("hours") ?? 24));
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  const end = Date.now();
  const start = end - rangeHours * 3_600_000;
  const eligibleAgents = (agents.data?.agents ?? []).filter((agent) => !["codex_desktop", "codex_cli"].includes(agent.producerType) && (agentFilter === "all" || agent.agentId === agentFilter) && (environment === "all" || agent.environment === environment));
  const runQueries = useQueries({ queries: eligibleAgents.map((agent) => ({ queryKey: ["agent-runs", agent.agentId, "explorer", rangeHours], queryFn: () => api.agentRuns(agent.agentId, { start, end, limit: 100 }), staleTime: 30_000, retry: false })) });
  const baseRows = useMemo(() => eligibleAgents.flatMap((agent, index) => (runQueries[index]?.data?.runs ?? []).map((run) => ({ ...run, agent }))), [eligibleAgents, runQueries]);
  const needsSpanMetadata = Boolean(model.trim() || tool.trim());
  const traceQueries = useQueries({ queries: baseRows.slice(0, 50).map((run) => ({ queryKey: ["run-filter-trace", run.traceId, start, end], queryFn: () => api.trace(run.traceId, start, end), enabled: needsSpanMetadata, staleTime: 60_000, retry: false })) });
  const metadata = new Map(baseRows.slice(0, 50).map((run, index) => { const spans = traceQueries[index]?.data?.spans ?? []; const attributes = spans.map((span) => (span.attributes as Record<string, unknown> | undefined) ?? {}); return [run.traceId, { models: attributes.flatMap((item) => [item["gen_ai.request.model"], item["gen_ai.response.model"], item["llm.model_name"]]).filter(String).map(String), tools: attributes.flatMap((item) => [item["gen_ai.tool.name"], item["tracey.tool.name"], item["tool.name"]]).filter(String).map(String) }]; }));
  const rows = useMemo(() => baseRows.filter(({ runId, traceId, model: runModel, status: runStatus, outcome, agent }) => {
    const term = search.toLowerCase();
    const details = metadata.get(traceId);
    return (status === "all" || String(runStatus ?? outcome).toLowerCase() === status) && (!term || [runId, traceId, runModel, agent.displayName, agent.serviceName].some((item) => String(item ?? "").toLowerCase().includes(term)))
      && (!model || [runModel, ...(details?.models ?? [])].some((value) => String(value ?? "").toLowerCase().includes(model.toLowerCase())))
      && (!tool || (details?.tools ?? []).some((value) => value.toLowerCase().includes(tool.toLowerCase())));
  }).sort((a, b) => new Date(String(b.startedAt ?? b.startTime ?? 0)).getTime() - new Date(String(a.startedAt ?? a.startTime ?? 0)).getTime()), [baseRows, metadata, search, status, model, tool]);
  const loading = agents.isLoading || runQueries.some((entry) => entry.isLoading) || (needsSpanMetadata && traceQueries.some((entry) => entry.isLoading));
  const error = agents.error ?? runQueries.find((entry) => entry.error)?.error;
  const setFilter = (key: string, value: string) => { const next = new URLSearchParams(params.toString()); if (value && value !== "all") next.set(key, value); else next.delete(key); router.replace(`/runs?${next.toString()}`, { scroll: false }); };
  return <div className="page"><PageHeader eyebrow="OBSERVED EXECUTIONS" title="Runs and traces" description="Search real agent executions across registered producers, then inspect the observed trace without exposing prompt or tool payload contents." />
    <div className="filter-bar run-filters"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setFilter("search", event.target.value); }} placeholder="Run ID, trace, service…" /></label><select value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); setFilter("agent", event.target.value); }}><option value="all">All agents</option>{(agents.data?.agents ?? []).map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}</select><select value={environment} onChange={(event) => { setEnvironment(event.target.value); setFilter("environment", event.target.value); }}><option value="all">All environments</option>{[...new Set((agents.data?.agents ?? []).map((agent) => agent.environment))].map((value) => <option key={value}>{value}</option>)}</select><select value={status} onChange={(event) => { setStatus(event.target.value); setFilter("status", event.target.value); }} aria-label="Run status"><option value="all">All statuses</option><option value="ok">Succeeded</option><option value="error">Failed</option></select><input className="filter-input" value={model} onChange={(event) => { setModel(event.target.value); setFilter("model", event.target.value); }} placeholder="Model" aria-label="Filter by model" /><input className="filter-input" value={tool} onChange={(event) => { setTool(event.target.value); setFilter("tool", event.target.value); }} placeholder="Tool" aria-label="Filter by tool" /><select value={rangeHours} onChange={(event) => { setRangeHours(Number(event.target.value)); setFilter("hours", event.target.value); }}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></div>
    {loading ? <LoadingState label="Querying observed agent runs" /> : error ? <ErrorState error={error} /> : rows.length === 0 ? <EmptyState icon={Activity} title="No matching runs" description="Register an agent and validate its OpenTelemetry export. Tracey never fabricates run history." /> : <Panel><div className="table-wrap"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Model</th><th>Duration</th><th>Started</th></tr></thead><tbody>{rows.map((run) => <tr key={`${run.agent.agentId}-${run.runId}`} onClick={() => router.push(`/runs/${encodeURIComponent(run.traceId)}?agentId=${run.agent.agentId}&start=${new Date(String(run.startedAt ?? run.startTime ?? Date.now())).getTime() - 300_000}&end=${new Date(String(run.startedAt ?? run.startTime ?? Date.now())).getTime() + 3_600_000}`)}><td><strong>{run.runId}</strong><br /><code>{run.traceId.slice(0, 16)}…</code></td><td>{run.agent.displayName}<br /><code>{run.agent.serviceName}</code></td><td><StatusChip value={String(run.status ?? run.outcome ?? "observed")} /></td><td>{String(run.model ?? "Not emitted")}</td><td>{duration(run.durationMs)}</td><td>{dateTime(String(run.startedAt ?? run.startTime ?? ""))}</td></tr>)}</tbody></table></div></Panel>}
  </div>;
}

export function RunDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const start = Number(search.get("start")) || Date.now() - day;
  const end = Number(search.get("end")) || Date.now();
  const query = useQuery({ queryKey: ["trace", traceId, start, end], queryFn: () => api.trace(traceId, start, end) });
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  if (query.isLoading) return <div className="page"><LoadingState label="Loading observed trace" /></div>;
  if (query.error || !query.data) return <div className="page"><ErrorState error={query.error ?? new Error("Trace not found")} /></div>;
  const spans = query.data.spans ?? [];
  const critical = [...spans].sort((a, b) => Number(b.durationMs ?? 0) - Number(a.durationMs ?? 0)).slice(0, 8);
  const failures = spans.filter((span) => span.hasError);
  const signozUrl = connectors.data?.connectors.find((connector) => connector.id === "signoz")?.configuration?.publicConfig.apiUrl;
  return <div className="page"><button className="back-link" onClick={() => router.back()}><ArrowLeft size={15} />Runs</button><PageHeader eyebrow="TRACE EVIDENCE" title={`Run ${traceId.slice(0, 12)}…`} description="Observed span data is shown separately from Tracey’s inferred diagnosis. Sensitive attributes remain server-side and redacted." actions={<>{typeof signozUrl === "string" && <a className="button button-ghost" href={`${signozUrl.replace(/\/$/, "")}/trace/${traceId}`} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open in SigNoz</a>}<Link className="button button-secondary" href={`/investigations?new=true&traceId=${encodeURIComponent(traceId)}&start=${start}&end=${end}`}><ShieldCheck size={16} />Investigate</Link></>} />
    <div className="metrics-grid"><div className="metric-card"><div className="metric-icon"><GitBranch size={18} /></div><p>Observed spans</p><strong>{spans.length}</strong><span>Returned by SigNoz</span></div><div className="metric-card tone-danger"><div className="metric-icon"><TriangleAlert size={18} /></div><p>Error spans</p><strong>{failures.length}</strong><span>No inferred failures included</span></div><div className="metric-card"><div className="metric-icon"><Timer size={18} /></div><p>Critical span</p><strong>{duration(Number(critical[0]?.durationMs ?? 0))}</strong><span>{critical[0]?.name ?? "No spans"}</span></div></div>
    <Panel title="Run graph and critical path" subtitle="Ordered by observed duration; parent identifiers preserve the execution graph.">{critical.length === 0 ? <EmptyState title="No span graph returned" description="The trace exists but its normalized span fields were not available in this query window." /> : <div className="span-waterfall">{critical.map((span, index) => <div key={String(span.spanId ?? index)}><span className={span.hasError ? "span-error" : ""} style={{ width: `${Math.max(8, Number(span.durationMs ?? 0) / Math.max(1, Number(critical[0]?.durationMs ?? 1)) * 100)}%` }} /><strong>{span.name ?? "Unnamed span"}</strong><small>{span.serviceName ?? "unknown service"} · {duration(Number(span.durationMs ?? 0))}</small>{span.hasError && <StatusChip value="failed" />}</div>)}</div>}</Panel>
    <div className="two-column"><Panel title="Observed facts"><JsonView value={{ traceId, spans, evidence: query.data.evidence, query: query.data.query }} label="Sanitized trace evidence" /></Panel><Panel title="Inferred analysis"><JsonView value={{ analysis: query.data.analysis, diagnosis: query.data.diagnosis }} label="Tracey inference" /></Panel></div>
    <p className="privacy-note"><ExternalLink size={14} /> Prompt text, outputs, credentials, and private tool payloads are not rendered by this interface.</p>
  </div>;
}
