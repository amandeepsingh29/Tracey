"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Bell, Bot, Cable, Check, CircleAlert, FileSearch, GitPullRequestArrow, Radar, Rocket, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../lib/api";
import { relativeTime, titleCase } from "../lib/format";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, Panel, StatusChip } from "../components/ui";

export function OverviewPage() {
  const router = useRouter();
  const [environment, setEnvironment] = useState("all");
  const [rangeHours, setRangeHours] = useState(24);
  const [now, setNow] = useState(() => Date.now());
  const results = useQueries({ queries: [
    { queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 },
    { queryKey: ["connectors"], queryFn: api.connectors },
    { queryKey: ["agents"], queryFn: () => api.agents() },
    { queryKey: ["actions"], queryFn: () => api.actions() },
    { queryKey: ["notifications", false], queryFn: () => api.notifications(false) },
    { queryKey: ["investigations"], queryFn: api.investigations, retry: false },
  ] });
  const [health, connectors, agents, actions, notifications, investigations] = results;
  const eligibleAgents = (agents.data?.agents ?? []).filter((agent) => (environment === "all" || agent.environment === environment) && !["codex_desktop", "codex_cli"].includes(agent.producerType));
  const windowMs = rangeHours * 3_600_000;
  const runQueries = useQueries({ queries: eligibleAgents.map((agent) => ({ queryKey: ["overview-runs", agent.agentId, rangeHours, now], queryFn: () => api.agentRuns(agent.agentId, { start: now - 2 * windowMs, end: now, limit: 100 }), retry: false })) });
  if (results.every((result) => result.isLoading)) return <div className="page"><LoadingState /></div>;
  const firstError = results.find((result) => result.error)?.error;
  const connectorList = (connectors.data?.connectors ?? []).filter(({ id }) => id !== "mcp");
  const agentList = agents.data?.agents ?? [];
  const actionList = actions.data?.actions ?? [];
  const notificationList = notifications.data?.notifications ?? [];
  const investigationList = investigations.data?.investigations ?? [];
  const observedRuns = runQueries.flatMap((query) => query.data?.runs ?? []);
  const runTime = (run: typeof observedRuns[number]) => new Date(String(run.startedAt ?? run.startTime ?? 0)).getTime();
  const currentRuns = observedRuns.filter((run) => runTime(run) >= now - windowMs);
  const previousRuns = observedRuns.filter((run) => runTime(run) < now - windowMs);
  const isFailure = (run: typeof observedRuns[number]) => ["error", "failed", "failure"].includes(String(run.status ?? run.outcome).toLowerCase());
  const failureRate = (runs: typeof observedRuns) => runs.length ? runs.filter(isFailure).length / runs.length : 0;
  const failureDelta = (failureRate(currentRuns) - failureRate(previousRuns)) * 100;
  const latencies = currentRuns.map((run) => Number(run.durationMs ?? 0)).filter((value) => value > 0).sort((a, b) => a - b);
  const p95 = latencies[Math.max(0, Math.ceil(latencies.length * .95) - 1)] ?? 0;
  const previousLatencies = previousRuns.map((run) => Number(run.durationMs ?? 0)).filter((value) => value > 0).sort((a, b) => a - b);
  const previousP95 = previousLatencies[Math.max(0, Math.ceil(previousLatencies.length * .95) - 1)] ?? 0;
  const tokens = currentRuns.reduce((sum, run) => sum + Number(run.tokenUsage?.total ?? 0), 0);
  const previousTokens = previousRuns.reduce((sum, run) => sum + Number(run.tokenUsage?.total ?? 0), 0);
  const cost = currentRuns.reduce((sum, run) => sum + Number(run.costNanoUsd ?? 0), 0) / 1_000_000_000;
  const previousCost = previousRuns.reduce((sum, run) => sum + Number(run.costNanoUsd ?? 0), 0) / 1_000_000_000;
  const pending = actionList.filter(({ status }) => status === "awaiting_approval").length;
  const failed = actionList.filter(({ status }) => ["failed", "revert_failed"].includes(status)).length;
  const recovered = actionList.filter(({ status }) => ["reverted", "succeeded"].includes(status)).length;
  const readyConnectors = connectorList.filter(({ state }) => state === "ready").length;
  const needsSetup = agentList.length === 0 || !connectorList.some(({ id, state }) => id === "signoz" && state === "ready");

  return <div className="page">
    <PageHeader eyebrow="OPERATIONS OVERVIEW" title="Know what needs attention." description="Live agent reliability, change control, and connector health in one evidence-backed workspace." actions={<><select className="header-select" value={environment} onChange={(event) => setEnvironment(event.target.value)} aria-label="Environment"><option value="all">All environments</option>{[...new Set((agents.data?.agents ?? []).map((agent) => agent.environment))].map((value) => <option key={value}>{value}</option>)}</select><select className="header-select" value={rangeHours} onChange={(event) => setRangeHours(Number(event.target.value))} aria-label="Time range"><option value={1}>Last hour</option><option value={24}>Last 24 hours</option><option value={168}>Last 7 days</option></select><button className="button button-secondary" onClick={() => { setNow(Date.now()); void Promise.all(results.map((result) => result.refetch())); }}><Radar size={16} />Refresh live data</button></>} />
    {firstError && <ErrorState error={firstError} onRetry={() => void Promise.all(results.map((result) => result.refetch()))} />}
    {needsSetup && <button className="setup-banner" onClick={() => router.push("/onboarding")}><div className="setup-icon"><Rocket /></div><div><strong>Finish setting up Tracey</strong><span>Connect telemetry, validate infrastructure, and register your first production agent.</span></div><ArrowRight /></button>}
    <section className="metrics-grid" aria-label="Operational metrics">
      <Link href="/agents"><MetricCard label="Connected agents" value={environment === "all" ? agentList.length : agentList.filter((agent) => agent.environment === environment).length} detail={agentList.length ? `${agentList.filter(({ status }) => status === "active").length} actively monitored` : "Register your first agent"} icon={Bot} /></Link>
      <Link href="/investigations"><MetricCard label="Investigations" value={investigationList.length} detail={investigationList.length ? "Grounded investigation history" : "Start your first investigation"} icon={FileSearch} /></Link>
      <Link href="/runs?status=error"><MetricCard label="Failed runs" value={currentRuns.filter(isFailure).length} detail={`${failureDelta >= 0 ? "+" : ""}${failureDelta.toFixed(1)} pp vs previous window`} icon={Activity} tone={currentRuns.some(isFailure) ? "danger" : "success"} /></Link>
      <Link href="/changes?status=awaiting_approval"><MetricCard label="Pending approvals" value={pending} detail={pending ? "Operator decision required" : "No changes waiting"} icon={GitPullRequestArrow} tone={pending ? "warning" : "default"} /></Link>
      <Link href="/connectors"><MetricCard label="Connector health" value={`${readyConnectors}/${connectorList.length || 0}`} detail={connectorList.some(({ state }) => state === "needs_configuration") ? "Setup needs attention" : "Connected systems ready"} icon={Cable} /></Link>
      <Link href="/changes"><MetricCard label="Verified outcomes" value={recovered} detail={failed ? `${failed} change failures recorded` : "No unresolved execution failures"} icon={ShieldCheck} tone={failed ? "danger" : "success"} /></Link>
      <Link href="/runs"><MetricCard label="P95 latency" value={p95 ? `${Math.round(p95)} ms` : "—"} detail={p95 && previousP95 ? `${(((p95 - previousP95) / previousP95) * 100).toFixed(1)}% vs previous window` : `${currentRuns.length} observed runs in range`} icon={Radar} /></Link>
      <Link href="/runs"><MetricCard label="Tokens / cost" value={tokens ? tokens.toLocaleString() : "—"} detail={tokens && previousTokens ? `${(((tokens - previousTokens) / previousTokens) * 100).toFixed(1)}% tokens · $${cost.toFixed(4)} (${previousCost ? `${(((cost - previousCost) / previousCost) * 100).toFixed(1)}%` : "new"})` : cost ? `$${cost.toFixed(4)} estimated from emitted pricing` : "Cost not emitted"} icon={Bot} /></Link>
    </section>
    <div className="two-column">
      <Panel title="Recent operational activity" subtitle="Real findings generated by investigations, policy decisions, and actions.">
        {notificationList.length === 0 ? <EmptyState title="No operational activity yet" description="Tracey will record approvals, connector problems, failures, and recoveries here." icon={Bell} /> : <div className="activity-list">{notificationList.slice(0, 6).map((notification) => <Link href={notification.sessionId ? `/investigations/${notification.sessionId}` : notification.category === "approval" || notification.category === "recovery" ? "/changes" : "/investigations"} key={notification.notificationId} className="activity-row"><div className={`activity-signal severity-${notification.severity}`}><CircleAlert size={16} /></div><div><strong>{notification.title}</strong><p>{notification.summary}</p><span>{relativeTime(notification.createdAt)}</span></div><StatusChip value={notification.severity} /></Link>)}</div>}
      </Panel>
      <Panel title="Connected systems" subtitle="The evidence and execution surfaces Tracey can currently reach." action={<Link className="text-link" href="/connectors">Manage <ArrowRight size={14} /></Link>}>
        {connectorList.length === 0 ? <EmptyState title="Connector status unavailable" description="Connect the Tracey API to inspect configured systems." icon={Cable} /> : <div className="connector-compact">{connectorList.map((connector) => <Link href={`/connectors?connector=${connector.id}`} key={connector.id}><div><strong>{connector.displayName}</strong><span>{titleCase(connector.category)}</span></div><StatusChip value={connector.state} /></Link>)}</div>}
      </Panel>
    </div>
    <Panel title="Recent changes" subtitle="Durable proposals and verified infrastructure outcomes." action={<Link className="text-link" href="/changes">Open change control <ArrowRight size={14} /></Link>}>
      {actionList.length === 0 ? <EmptyState title="No changes proposed" description="Evidence-backed remediation proposals will appear here before anything mutates." icon={Activity} /> : <div className="table-wrap"><table><thead><tr><th>Change</th><th>Target</th><th>Risk</th><th>Status</th><th>Created</th></tr></thead><tbody>{actionList.slice(0, 6).map((action) => <tr key={action.proposalId} onClick={() => router.push(`/changes/${action.proposalId}`)} tabIndex={0}><td><strong>{action.remediationPlan?.summary ?? titleCase(action.actionType)}</strong></td><td><code>{action.target}</code></td><td><StatusChip value={action.risk} /></td><td><StatusChip value={action.status} /></td><td>{relativeTime(action.createdAt)}</td></tr>)}</tbody></table></div>}
    </Panel>
    <footer className="data-freshness"><span className={health.data?.status === "ok" && Date.now() - Math.min(...results.filter((result) => result.dataUpdatedAt > 0).map((result) => result.dataUpdatedAt), Date.now()) < 60_000 ? "live-dot" : "offline-dot"} />API {health.data?.status === "ok" ? "connected" : "status unknown"} · Oldest visible result refreshed {relativeTime(new Date(Math.min(...results.filter((result) => result.dataUpdatedAt > 0).map((result) => result.dataUpdatedAt), Date.now())).toISOString())}</footer>
  </div>;
}

export function OnboardingPage() {
  const connectors = useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.agents() });
  const router = useRouter();
  if (connectors.isLoading || agents.isLoading) return <div className="page"><LoadingState label="Checking your Tracey workspace" /></div>;
  if (connectors.error || agents.error) return <div className="page"><ErrorState error={connectors.error ?? agents.error} onRetry={() => { void connectors.refetch(); void agents.refetch(); }} /></div>;
  const list = connectors.data?.connectors ?? [];
  const steps = [
    { title: "Connect observability", description: "Give Tracey access to traces, logs, and metrics in SigNoz.", done: list.some(({ id, state }) => id === "signoz" && state === "ready"), path: "/connectors?connector=signoz" },
    { title: "Connect infrastructure", description: "Validate Kubernetes investigation and approved execution permissions.", done: list.some(({ id, state }) => id === "kubernetes" && state === "ready"), path: "/connectors?connector=kubernetes" },
    { title: "Register an agent", description: "Identify a Codex, Claude Code, or OpenTelemetry service to monitor.", done: (agents.data?.agents.length ?? 0) > 0, path: "/agents?register=true" },
    { title: "Validate telemetry", description: "Open a registered agent and confirm production runs are arriving.", done: false, path: "/agents" },
    { title: "Run the first investigation", description: "Ask Tracey a grounded question about your connected systems.", done: false, path: "/investigations?new=true" },
  ];
  const completed = steps.filter(({ done }) => done).length;
  return <div className="page onboarding-page">
    <PageHeader eyebrow="GET STARTED" title="From telemetry to verified recovery." description="Connect the systems Tracey needs, validate the evidence path, and complete your first investigation." />
    <Panel className="onboarding-progress"><div className="progress-copy"><span>{completed} of {steps.length} complete</span><strong>{Math.round((completed / steps.length) * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${(completed / steps.length) * 100}%` }} /></div></Panel>
    <div className="onboarding-steps">{steps.map((step, index) => <button key={step.title} onClick={() => router.push(step.path)} className={step.done ? "step-done" : ""}><div className="step-number">{step.done ? <Check /> : index + 1}</div><div><strong>{step.title}</strong><p>{step.description}</p></div><ArrowRight /></button>)}</div>
    <Panel className="product-promise"><div className="promise-icon"><ShieldCheck /></div><div><p className="eyebrow">WHAT TRACEY DOES</p><h2>Evidence first. Confirmation before change.</h2><p>Tracey connects agent behavior with infrastructure state, explains failures using observed evidence, proposes an exact remediation, and verifies the outcome after approval.</p></div></Panel>
  </div>;
}
