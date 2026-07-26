"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, Bot, Boxes, ExternalLink, GitBranch, RefreshCw, Search, ShieldCheck, Timer, TriangleAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, EmptyState, ErrorState, JsonView, LoadingState, MetricCard, PageHeader, Panel, StatusChip } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, duration, titleCase } from "../lib/format";

const day = 86_400_000;
const shortId = (value: string, length = 20) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function RunsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "all");
  const [producer, setProducer] = useState(params.get("producer") ?? "all");
  const [environment, setEnvironment] = useState(params.get("environment") ?? "all");
  const [model, setModel] = useState(params.get("model") ?? "");
  const [tool, setTool] = useState(params.get("tool") ?? "");
  const [rangeHours, setRangeHours] = useState(Number(params.get("hours") ?? 24));
  const end = Date.now();
  const start = end - rangeHours * 3_600_000;
  const feed = useQuery({ queryKey: ["executions", rangeHours], queryFn: () => api.executions(start, end), staleTime: 30_000, retry: false });
  const rows = useMemo(() => (feed.data?.executions ?? []).filter((execution) => {
    const term = search.toLowerCase();
    return (status === "all" || execution.status === status)
      && (producer === "all" || execution.producerType === producer)
      && (environment === "all" || execution.environment === environment)
      && (!term || [execution.runId, execution.traceId, execution.conversationId, execution.producerName, execution.serviceName].some((item) => String(item ?? "").toLowerCase().includes(term)))
      && (!model || execution.model?.toLowerCase().includes(model.toLowerCase()))
      && (!tool || execution.tools.some((value) => value.toLowerCase().includes(tool.toLowerCase())));
  }), [environment, feed.data?.executions, model, producer, search, status, tool]);
  const setFilter = (key: string, value: string) => { const next = new URLSearchParams(params.toString()); if (value && value !== "all") next.set(key, value); else next.delete(key); router.replace(`/runs?${next.toString()}`, { scroll: false }); };
  const sources = feed.data?.sources ?? [];
  const failed = (feed.data?.executions ?? []).filter(({ status: value }) => value === "failed").length;
  const activeSources = sources.filter(({ status: value }) => value === "complete").length;
  const environments = [...new Set((feed.data?.executions ?? []).map((item) => item.environment))];
  const openExecution = (execution: NonNullable<typeof feed.data>["executions"][number]) => {
    if (execution.traceId) {
      const executionStart = Date.parse(execution.startedAt);
      router.push(`/runs/${encodeURIComponent(execution.traceId)}?start=${executionStart - 300_000}&end=${executionStart + 3_600_000}`);
      return;
    }
    if (execution.conversationId) {
      router.push(`/investigations?new=true&prompt=${encodeURIComponent(`Investigate Codex conversation ${execution.conversationId} for service ${execution.serviceName} over the last ${rangeHours} hours.`)}`);
    }
  };
  return <div className="page runs-page"><PageHeader eyebrow="OBSERVED EXECUTIONS" title="Runs and traces" description="One live feed for Codex, Claude Code, and custom OpenTelemetry agents. Tracey shows operational metadata while keeping prompts, responses, and private tool payloads out of the interface." actions={<><Button variant="secondary" disabled={feed.isFetching} onClick={() => void feed.refetch()}><RefreshCw size={15} />Refresh</Button><Link className="button button-primary" href="/agents">Add an agent</Link></>} />
    {feed.isLoading ? <LoadingState label="Querying connected execution sources" /> : feed.error ? <ErrorState error={feed.error} onRetry={() => void feed.refetch()} /> : <>
      <div className="metrics-grid execution-metrics"><MetricCard icon={Activity} label="Observed executions" value={feed.data?.executions.length ?? 0} detail={`Last ${rangeHours === 168 ? "7 days" : `${rangeHours} hour${rangeHours === 1 ? "" : "s"}`}`} /><MetricCard icon={TriangleAlert} label="Failed" value={failed} detail={failed ? "Failure evidence emitted" : "No observed failures"} tone={failed ? "danger" : "default"} /><MetricCard icon={Boxes} label="Active sources" value={`${activeSources}/${sources.length}`} detail={`${feed.data?.registeredAgentCount ?? 0} registered agents`} /><MetricCard icon={ShieldCheck} label="Privacy" value="Metadata only" detail="No prompts or tool payloads" /></div>
      <Panel className="execution-sources" title="Connected execution sources" subtitle="Each source reports its own query result; one unavailable producer does not hide the others."><div className="execution-source-grid">{sources.map((source) => <div key={source.sourceId}><span className="source-icon">{source.producerType.startsWith("codex") ? <Bot /> : source.producerType === "claude_code" ? <Activity /> : <Wrench />}</span><div><strong>{source.displayName}</strong><code>{source.serviceName ?? titleCase(source.producerType)}</code>{source.limitation && <small>{source.limitation}</small>}</div><span className="source-count">{source.observedExecutions}</span><StatusChip value={source.status} /></div>)}</div></Panel>
      <div className="filter-bar run-filters"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setFilter("search", event.target.value); }} placeholder="Run, conversation, trace, service…" /></label><select value={producer} onChange={(event) => { setProducer(event.target.value); setFilter("producer", event.target.value); }}><option value="all">All producers</option><option value="codex_desktop">Codex</option><option value="claude_code">Claude Code</option><option value="custom_otel">Custom OTel</option></select><select value={environment} onChange={(event) => { setEnvironment(event.target.value); setFilter("environment", event.target.value); }}><option value="all">All environments</option>{environments.map((value) => <option key={value}>{value}</option>)}</select><select value={status} onChange={(event) => { setStatus(event.target.value); setFilter("status", event.target.value); }} aria-label="Execution status"><option value="all">All statuses</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="observed">Observed</option></select><input className="filter-input" value={model} onChange={(event) => { setModel(event.target.value); setFilter("model", event.target.value); }} placeholder="Model" aria-label="Filter by model" /><input className="filter-input" value={tool} onChange={(event) => { setTool(event.target.value); setFilter("tool", event.target.value); }} placeholder="Tool" aria-label="Filter by tool" /><select value={rangeHours} onChange={(event) => { setRangeHours(Number(event.target.value)); setFilter("hours", event.target.value); }}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></div>
      {rows.length === 0 ? <EmptyState icon={Activity} title={feed.data?.executions.length ? "No executions match these filters" : "No executions observed in this window"} description={feed.data?.registeredAgentCount ? "The connected sources were queried successfully. Expand the time window or validate that the producer emits Tracey’s run contract." : "Codex sources were queried directly. Register Claude Code or a custom OpenTelemetry service to add its observed runs to this feed."} action={<div className="empty-actions"><Button variant="secondary" onClick={() => { setRangeHours(168); setFilter("hours", "168"); }}>Search 7 days</Button><Link className="button button-primary" href="/agents">Register an agent</Link></div>} /> : <Panel className="execution-table"><div className="table-wrap"><table><thead><tr><th>Execution</th><th>Producer</th><th>Status</th><th>Model</th><th>Tools</th><th>Tokens</th><th>Duration</th><th>Started</th></tr></thead><tbody>{rows.map((execution) => {
        const secondaryId = execution.conversationId && execution.conversationId !== execution.runId
          ? { label: "Conversation", value: execution.conversationId }
          : execution.traceId && execution.traceId !== execution.runId
            ? { label: "Trace", value: execution.traceId }
            : undefined;
        return <tr key={execution.executionId} className={execution.traceId || execution.conversationId ? "clickable" : ""} onClick={() => openExecution(execution)}>
          <td className="execution-identity"><span className="execution-id-label">{execution.runId === execution.traceId ? "Trace" : "Run"}</span><strong title={execution.runId}>{shortId(execution.runId, 24)}</strong>{secondaryId && <span className="execution-secondary" title={secondaryId.value}><small>{secondaryId.label}</small><code>{shortId(secondaryId.value, 17)}</code></span>}</td>
          <td className="execution-producer"><strong>{execution.producerName}</strong><code>{execution.serviceName}</code></td>
          <td><StatusChip value={execution.status} /></td>
          <td>{execution.model ?? <span className="muted-dash" aria-label="Model not emitted">—</span>}</td>
          <td>{execution.tools.length ? <span className="execution-tools">{execution.tools.slice(0, 2).map((name) => <code key={name}>{name}</code>)}{execution.tools.length > 2 && <small>+{execution.tools.length - 2}</small>}</span> : <span className="muted-dash" aria-label="No tools emitted">—</span>}</td>
          <td>{execution.inputTokens || execution.outputTokens ? `${(execution.inputTokens ?? 0) + (execution.outputTokens ?? 0)}` : "—"}</td>
          <td>{execution.durationMs === undefined ? "—" : duration(execution.durationMs)}</td>
          <td className="execution-started">{dateTime(execution.startedAt)}</td>
        </tr>;
      })}</tbody></table></div>{feed.data?.truncated && <p className="table-note">Showing the newest {rows.length} executions. Narrow the filters or time range for a more focused result.</p>}</Panel>}
    </>}
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
