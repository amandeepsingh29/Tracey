"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, ArrowRight, Bot, Boxes, ExternalLink, GitBranch, MessageSquareText, RefreshCw, Search, ShieldCheck, Timer, TriangleAlert, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button, EmptyState, ErrorState, JsonView, LoadingState, MetricCard, PageHeader, Panel, StatusChip } from "../components/ui";
import { ExecutionGraphDetail } from "../components/ExecutionGraph";
import { api } from "../lib/api";
import { dateTime, duration, titleCase } from "../lib/format";
import type { TraceDetails } from "../types";

const day = 86_400_000;
const shortId = (value: string, length = 20) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
type TraceSpanView = NonNullable<TraceDetails["spans"]>[number];

function spanTree(spans: TraceSpanView[]) {
  const byId = new Map(spans.flatMap((span) => span.spanId ? [[span.spanId, span] as const] : []));
  const children = new Map<string, TraceSpanView[]>();
  const roots: TraceSpanView[] = [];
  const startedAt = (span: TraceSpanView) => Number(span.startTimeMs ?? 0);
  for (const span of spans) {
    if (span.parentSpanId && byId.has(span.parentSpanId)) {
      children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
    } else {
      roots.push(span);
    }
  }
  roots.sort((left, right) => startedAt(left) - startedAt(right));
  for (const values of children.values()) values.sort((left, right) => startedAt(left) - startedAt(right));
  const ordered: Array<{ span: TraceSpanView; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (span: TraceSpanView, depth: number) => {
    if (span.spanId && visited.has(span.spanId)) return;
    if (span.spanId) visited.add(span.spanId);
    ordered.push({ span, depth });
    for (const child of span.spanId ? children.get(span.spanId) ?? [] : []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const span of spans) if (!span.spanId || !visited.has(span.spanId)) visit(span, 0);
  return ordered;
}

function spanAttribute(span: TraceSpanView, key: string) {
  const attributes = span.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return undefined;
  const value = (attributes as Record<string, unknown>)[key];
  return typeof value === "string" ? value : value === undefined || value === null ? undefined : String(value);
}

function readableContent(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function agentExchange(spans: TraceSpanView[]) {
  const root = spans.find((span) => !span.parentSpanId && span.name === "agent.run")
    ?? spans.find((span) => span.name === "agent.run");
  const events: Array<{ kind: string; label: string; input?: string; output?: string; detail?: string }> = [];
  const prompt = root && spanAttribute(root, "tracey.content.input");
  if (prompt) events.push({ kind: "prompt", label: "User prompt", input: prompt });
  const ordered = [...spans].sort((left, right) => Number(left.startTimeMs ?? 0) - Number(right.startTimeMs ?? 0));
  for (const span of ordered) {
    if (span === root) continue;
    const input = spanAttribute(span, "tracey.content.input");
    const output = spanAttribute(span, "tracey.content.output");
    if (String(span.name ?? "").startsWith("chat ") && (input || output)) {
      events.push({
        kind: "model",
        label: spanAttribute(span, "tracey.model.route") === "semantic-router" ? "Router model exchange" : "Agent model exchange",
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...((spanAttribute(span, "gen_ai.request.model") ?? span.name) ? { detail: String(spanAttribute(span, "gen_ai.request.model") ?? span.name) } : {}),
      });
    } else if (span.name === "agent.decision") {
      events.push({
        kind: "decision",
        label: "Agent decision",
        output: spanAttribute(span, "tracey.decision.selected") ?? "Decision observed",
        ...(spanAttribute(span, "tracey.decision.policy") ? { detail: spanAttribute(span, "tracey.decision.policy") as string } : {}),
      });
    } else if (String(span.name ?? "").startsWith("execute_tool")) {
      events.push({
        kind: "tool",
        label: String(span.name).replace("execute_tool ", "Tool · "),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...(spanAttribute(span, "tracey.tool.side_effect") ? { detail: spanAttribute(span, "tracey.tool.side_effect") as string } : {}),
      });
    }
  }
  const finalResponse = root && spanAttribute(root, "tracey.content.output");
  if (finalResponse) events.push({ kind: "final", label: "Final answer", output: finalResponse });
  return events;
}

export function RunsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [conversationLookup, setConversationLookup] = useState("");
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
  const recentCodex = useQuery({ queryKey: ["recent-codex-conversations"], queryFn: () => api.recentCodexConversations(168, 40), staleTime: 15_000, retry: false });
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
  const recentTurns = recentCodex.data?.conversations ?? [];
  const openExecution = (execution: NonNullable<typeof feed.data>["executions"][number]) => {
    const executionStart = Date.parse(execution.startedAt);
    if (execution.conversationId) {
      const query = new URLSearchParams({
        conversationId: execution.conversationId,
        serviceName: execution.serviceName,
        at: String(executionStart),
        start: String(executionStart - 3_600_000),
        end: String(executionStart + Math.min(167, Math.max(1, rangeHours)) * 3_600_000),
      });
      router.push(`/runs/${encodeURIComponent(execution.executionId)}?${query.toString()}`);
      return;
    }
    if (execution.traceId) {
      router.push(`/runs/${encodeURIComponent(execution.traceId)}?start=${executionStart - 300_000}&end=${executionStart + 3_600_000}`);
      return;
    }
  };
  const openCodexTurn = (turn: NonNullable<typeof recentCodex.data>["conversations"][number]) => {
    const executionStart = Date.parse(turn.startedAt);
    const query = new URLSearchParams({
      conversationId: turn.conversationId,
      serviceName: "codex-app-server",
      turnIndex: String(turn.turnIndex),
      at: String(executionStart),
      start: String(Math.max(0, executionStart - 3_600_000)),
      end: String(executionStart + day),
    });
    router.push(`/runs/${encodeURIComponent(`codex:${turn.conversationId}:${turn.turnIndex}`)}?${query.toString()}`);
  };
  const openConversation = () => {
    const conversationId = conversationLookup.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) return;
    const now = Date.now();
    const query = new URLSearchParams({
      conversationId,
      serviceName: "codex-app-server",
      start: String(now - 7 * day),
      end: String(now),
    });
    router.push(`/runs/${encodeURIComponent(`conversation:${conversationId}`)}?${query.toString()}`);
  };
  const lookupValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationLookup.trim());
  return <div className="page runs-page"><PageHeader eyebrow="AGENT ACTIVITY" title="What did my agents do?" description="Start with a recent Codex prompt, then open its complete prompt-to-action graph. Advanced telemetry from every connected agent remains available below." actions={<Button variant="secondary" disabled={feed.isFetching || recentCodex.isFetching} onClick={() => { void feed.refetch(); void recentCodex.refetch(); }}><RefreshCw size={15} />Refresh activity</Button>} />
    <Panel className="recent-codex-panel" title="Recent Codex prompts" subtitle="Each item is one prompt and everything it caused. Choose one to see model responses, commands, tool results, failures, and the final answer.">
      <form className="conversation-lookup" onSubmit={(event) => { event.preventDefault(); openConversation(); }}>
        <label><Search size={16} /><input value={conversationLookup} onChange={(event) => setConversationLookup(event.target.value)} placeholder="Paste a Codex conversation ID" aria-label="Codex conversation ID" /></label>
        <Button disabled={!lookupValid}>Open latest turn</Button>
      </form>
      {recentCodex.isLoading ? <LoadingState label="Finding your recent Codex prompts" />
        : recentCodex.error ? <ErrorState error={recentCodex.error} onRetry={() => void recentCodex.refetch()} />
          : recentTurns.length === 0 ? <EmptyState icon={MessageSquareText} title="No recent local Codex prompts found" description="Use Codex normally, then refresh this page. Tracey will list each observed prompt here." />
            : <div className="codex-turn-list">{recentTurns.slice(0, 16).map((turn) => <article key={`${turn.conversationId}:${turn.turnIndex}`}>
              <span className="codex-turn-icon"><MessageSquareText /></span>
              <div className="codex-turn-copy"><div className="codex-turn-meta"><strong>Codex · Turn {turn.turnIndex}</strong><span>{dateTime(turn.startedAt)}</span></div><p>{turn.prompt}</p><footer><code title={turn.conversationId}>{shortId(turn.conversationId, 22)}</code><span>{turn.eventCount} steps</span><span>{turn.toolNames.length} tools</span><StatusChip value={turn.status} /></footer></div>
              <Button variant="secondary" onClick={() => openCodexTurn(turn)}>View graph<ArrowRight size={15} /></Button>
            </article>)}</div>}
    </Panel>

    <div className="execution-section-heading"><div><p>ADVANCED ACTIVITY</p><h2>All observed executions</h2><span>Use this table when you need traces, services, models, tokens, or non-Codex agents.</span></div><Link className="button button-secondary" href="/agents">Manage agents</Link></div>
    {feed.isLoading ? <LoadingState label="Querying connected execution sources" /> : feed.error ? <ErrorState error={feed.error} onRetry={() => void feed.refetch()} /> : <>
      <div className="metrics-grid execution-metrics"><MetricCard icon={Activity} label="Observed executions" value={feed.data?.executions.length ?? 0} detail={`Last ${rangeHours === 168 ? "7 days" : `${rangeHours} hour${rangeHours === 1 ? "" : "s"}`}`} /><MetricCard icon={TriangleAlert} label="Failed" value={failed} detail={failed ? "Failure evidence emitted" : "No observed failures"} tone={failed ? "danger" : "default"} /><MetricCard icon={Boxes} label="Active sources" value={`${activeSources}/${sources.length}`} detail={`${feed.data?.registeredAgentCount ?? 0} registered agents`} /><MetricCard icon={ShieldCheck} label="Execution detail" value="Available" detail="Open a run to inspect its evidence" /></div>
      <Panel className="execution-sources" title="Connected execution sources" subtitle="Each source reports its own query result; one unavailable producer does not hide the others."><div className="execution-source-grid">{sources.map((source) => <div key={source.sourceId}><span className="source-icon">{source.producerType.startsWith("codex") ? <Bot /> : source.producerType === "claude_code" ? <Activity /> : <Wrench />}</span><div><strong>{source.displayName}</strong><code>{source.serviceName ?? titleCase(source.producerType)}</code>{source.limitation && <small>{source.limitation}</small>}</div><span className="source-count">{source.observedExecutions}</span><StatusChip value={source.status} /></div>)}</div></Panel>
      <div className="filter-bar run-filters"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setFilter("search", event.target.value); }} placeholder="Run, conversation, trace, service…" /></label><select value={producer} onChange={(event) => { setProducer(event.target.value); setFilter("producer", event.target.value); }}><option value="all">All producers</option><option value="codex_desktop">Codex</option><option value="claude_code">Claude Code</option><option value="custom_otel">Custom OTel</option></select><select value={environment} onChange={(event) => { setEnvironment(event.target.value); setFilter("environment", event.target.value); }}><option value="all">All environments</option>{environments.map((value) => <option key={value}>{value}</option>)}</select><select value={status} onChange={(event) => { setStatus(event.target.value); setFilter("status", event.target.value); }} aria-label="Execution status"><option value="all">All statuses</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="observed">Observed</option></select><input className="filter-input" value={model} onChange={(event) => { setModel(event.target.value); setFilter("model", event.target.value); }} placeholder="Model" aria-label="Filter by model" /><input className="filter-input" value={tool} onChange={(event) => { setTool(event.target.value); setFilter("tool", event.target.value); }} placeholder="Tool" aria-label="Filter by tool" /><select value={rangeHours} onChange={(event) => { setRangeHours(Number(event.target.value)); setFilter("hours", event.target.value); }}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></div>
      {rows.length === 0 ? <EmptyState icon={Activity} title={feed.data?.executions.length ? "No executions match these filters" : "No executions observed in this window"} description={feed.data?.registeredAgentCount ? "The connected sources were queried successfully. Expand the time window or validate that the producer emits Tracey’s run contract." : "Use the recent Codex prompt list above, or register Claude Code or a custom OpenTelemetry agent."} action={<div className="empty-actions"><Button variant="secondary" onClick={() => { setRangeHours(168); setFilter("hours", "168"); }}>Search 7 days</Button><Link className="button button-primary" href="/agents">Register an agent</Link></div>} /> : <Panel className="execution-table"><div className="table-wrap"><table><thead><tr><th>Execution</th><th>Producer</th><th>Status</th><th>Model</th><th>Tools</th><th>Tokens</th><th>Duration</th><th>Started</th><th>Details</th></tr></thead><tbody>{rows.map((execution) => {
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
          <td>{execution.traceId || execution.conversationId ? <Button variant="secondary" onClick={(event) => { event.stopPropagation(); openExecution(execution); }}>{execution.conversationId ? "View graph" : "View trace"}<ArrowRight size={14} /></Button> : <span className="muted-dash">Unavailable</span>}</td>
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
  const conversationId = search.get("conversationId") ?? "";
  const serviceName = search.get("serviceName") ?? "codex-app-server";
  const at = Number(search.get("at")) || undefined;
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const graphQuery = useQuery({
    queryKey: ["codex-execution-graph", conversationId, start, end, serviceName, at, includeSensitive],
    queryFn: () => api.codexExecutionGraph(conversationId, { start, end, serviceName, ...(at ? { at } : {}), includeSensitive }),
    enabled: Boolean(conversationId),
    retry: false,
  });
  const query = useQuery({ queryKey: ["trace", traceId, start, end], queryFn: () => api.trace(traceId, start, end), enabled: !conversationId });
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  if (conversationId) {
    if (graphQuery.isLoading) return <div className="page"><LoadingState label="Assembling prompt-to-action graph" /></div>;
    if (graphQuery.error || !graphQuery.data) return <div className="page"><button className="back-link" onClick={() => router.push("/runs")}><ArrowLeft size={15} />Recent Codex prompts</button><ErrorState error={graphQuery.error ?? new Error("Execution graph not found")} onRetry={() => void graphQuery.refetch()} /></div>;
    const graph = graphQuery.data;
    const prompt = graph.nodes.find(({ kind }) => kind === "prompt")?.summary;
    return <div className="page execution-detail-page"><button className="back-link" onClick={() => router.push("/runs")}><ArrowLeft size={15} />Recent Codex prompts</button><PageHeader eyebrow={`CODEX CONVERSATION · TURN ${graph.turnIndex}`} title={prompt ?? `Codex turn ${graph.turnIndex}`} description={`This is what your prompt caused, in order—from model work to commands, tool results, failures, and the final response. ${graph.model ? `Model: ${graph.model}.` : ""}`} actions={<Link className="button button-secondary" href={`/investigations?new=true&prompt=${encodeURIComponent(`Investigate Codex conversation ${graph.conversationId}, turn ${graph.turnIndex}, from ${start} to ${end}.`)}`}><ShieldCheck size={16} />Ask Tracey about this</Link>} />
      <ExecutionGraphDetail graph={graph} refreshingSensitive={graphQuery.isFetching} onRevealSensitive={() => setIncludeSensitive(true)} onHideSensitive={() => setIncludeSensitive(false)} />
    </div>;
  }
  if (query.isLoading) return <div className="page"><LoadingState label="Loading observed trace" /></div>;
  if (query.error || !query.data) return <div className="page"><ErrorState error={query.error ?? new Error("Trace not found")} /></div>;
  const spans = query.data.spans ?? [];
  const ranked = [...spans].sort((a, b) => Number(b.durationMs ?? 0) - Number(a.durationMs ?? 0));
  const tree = spanTree(spans);
  const exchange = agentExchange(spans);
  const failures = spans.filter((span) => span.hasError);
  const signozUrl = connectors.data?.connectors.find((connector) => connector.id === "signoz")?.configuration?.publicConfig.apiUrl;
  return <div className="page"><button className="back-link" onClick={() => router.back()}><ArrowLeft size={15} />Runs</button><PageHeader eyebrow="TRACE EVIDENCE" title={`Run ${traceId.slice(0, 12)}…`} description="See what the user asked, how the agent routed the request, each model exchange, tool inputs and results, and the final answer." actions={<>{typeof signozUrl === "string" && <a className="button button-ghost" href={`${signozUrl.replace(/\/$/, "")}/trace/${traceId}`} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open in SigNoz</a>}<Link className="button button-secondary" href={`/investigations?new=true&traceId=${encodeURIComponent(traceId)}&start=${start}&end=${end}`}><ShieldCheck size={16} />Investigate</Link></>} />
    <div className="metrics-grid"><div className="metric-card"><div className="metric-icon"><GitBranch size={18} /></div><p>Observed spans</p><strong>{spans.length}</strong><span>Returned by SigNoz</span></div><div className="metric-card tone-danger"><div className="metric-icon"><TriangleAlert size={18} /></div><p>Error spans</p><strong>{failures.length}</strong><span>No inferred failures included</span></div><div className="metric-card"><div className="metric-icon"><Timer size={18} /></div><p>Critical span</p><strong>{duration(Number(ranked[0]?.durationMs ?? 0))}</strong><span>{ranked[0]?.name ?? "No spans"}</span></div></div>
    <Panel title="Agent conversation" subtitle="Chronological developer view of the prompt, routing, model exchanges, tool work, and response. Credential-like values are redacted before export.">{exchange.length === 0 ? <EmptyState title="Content was not captured for this run" description="This trace predates developer content capture. Generate a new Notes Agent run to inspect the complete exchange." /> : <div className="agent-exchange">{exchange.map((event, index) => <article className={`exchange-${event.kind}`} key={`${event.kind}-${index}`}><header><span>{event.kind}</span><strong>{event.label}</strong>{event.detail && <small>{event.detail}</small>}</header>{event.input && <div><span>{event.kind === "prompt" ? "Prompt" : "Input"}</span><pre>{readableContent(event.input)}</pre></div>}{event.output && <div><span>{event.kind === "final" ? "Response" : "Output"}</span><pre>{readableContent(event.output)}</pre></div>}</article>)}</div>}</Panel>
    <Panel title="Run execution tree" subtitle="Every observed span is shown in parent-child order, from the agent request through model calls, tools, and database work.">{tree.length === 0 ? <EmptyState title="No span graph returned" description="The trace exists but its normalized span fields were not available in this query window." /> : <div className="span-waterfall span-tree">{tree.map(({ span, depth }, index) => <div className={String(span.name ?? "").startsWith("execute_tool") ? "span-tool-row" : ""} style={{ paddingLeft: `${10 + Math.min(depth, 8) * 22}px` }} key={String(span.spanId ?? index)}><span className={span.hasError ? "span-error" : ""} style={{ width: `${Math.max(8, Number(span.durationMs ?? 0) / Math.max(1, Number(ranked[0]?.durationMs ?? 1)) * 100)}%` }} /><strong>{depth > 0 && <span className="span-tree-branch">↳</span>}{span.name ?? "Unnamed span"}</strong><small>{span.serviceName ?? "unknown service"} · {duration(Number(span.durationMs ?? 0))}</small>{span.hasError && <StatusChip value="failed" />}</div>)}</div>}</Panel>
    <div className="two-column"><Panel title="Observed facts"><JsonView value={{ traceId, spans, evidence: query.data.evidence, query: query.data.query }} label="Sanitized trace evidence" /></Panel><Panel title="Inferred analysis"><JsonView value={{ analysis: query.data.analysis, diagnosis: query.data.diagnosis }} label="Tracey inference" /></Panel></div>
    <p className="privacy-note"><ExternalLink size={14} /> Developer capture is available only for explicitly enabled non-production agents. Credential-like values are redacted before telemetry leaves the agent.</p>
  </div>;
}
