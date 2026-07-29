"use client";

import {
  BrainCircuit, CheckCircle2, ChevronDown, CircleDot, Clock3, Code2, Eye,
  EyeOff, FileJson2, GitBranch, KeyRound, ListTree, MessageSquareText,
  ShieldAlert, Terminal, XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CodexExecutionGraph, ExecutionGraphNode } from "../types";
import { dateTime, duration, titleCase } from "../lib/format";
import { Button, JsonView, MetricCard, Panel, StatusChip } from "./ui";

type View = "graph" | "timeline" | "evidence" | "raw";

function NodeIcon({ kind }: { kind: ExecutionGraphNode["kind"] }) {
  if (kind === "prompt") return <MessageSquareText />;
  if (kind === "tool") return <Terminal />;
  if (kind === "result") return <Code2 />;
  if (kind === "decision") return <ShieldAlert />;
  if (kind === "final") return <CheckCircle2 />;
  if (kind === "reasoning") return <BrainCircuit />;
  return <CircleDot />;
}

export function ExecutionGraphDetail({
  graph,
  refreshingSensitive,
  onRevealSensitive,
  onHideSensitive,
}: {
  graph: CodexExecutionGraph;
  refreshingSensitive: boolean;
  onRevealSensitive: () => void;
  onHideSensitive: () => void;
}) {
  const [view, setView] = useState<View>("graph");
  const [selectedId, setSelectedId] = useState(graph.nodes[0]?.nodeId);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const selected = useMemo(
    () => graph.nodes.find(({ nodeId }) => nodeId === selectedId) ?? graph.nodes[0],
    [graph.nodes, selectedId],
  );
  const failed = graph.nodes.filter(({ status }) => status === "failed").length;
  const tools = graph.nodes.filter(({ kind }) => kind === "tool").length;
  const sensitive = graph.nodes.filter(({ sensitive: value }) => value).length;
  const edgeByTarget = new Map(graph.edges.map((edge) => [edge.to, edge]));

  return <>
    <div className="metrics-grid execution-detail-metrics">
      <MetricCard icon={ListTree} label="Observed steps" value={graph.nodes.length} detail={`${tools} tool call${tools === 1 ? "" : "s"}`} />
      <MetricCard icon={XCircle} label="Failed steps" value={failed} detail={failed ? "Failure content available" : "No observed failures"} tone={failed ? "danger" : "default"} />
      <MetricCard icon={Clock3} label="Duration" value={duration(graph.durationMs)} detail={`${dateTime(graph.startedAt)} start`} />
      <MetricCard icon={GitBranch} label="Evidence" value={`${Math.round(graph.evidenceCompleteness * 100)}%`} detail={graph.contentSource === "local_session" ? graph.evidence.length ? "SigNoz + local session" : "Local execution session" : "SigNoz telemetry only"} />
    </div>

    <div className={`forensic-strip ${graph.sensitiveValuesIncluded ? "forensic-strip-revealed" : ""}`}>
      <span><KeyRound /></span>
      <div>
        <strong>{graph.sensitiveValuesIncluded ? "Sensitive values visible for this session" : "Local forensic content connected"}</strong>
        <p>{graph.contentSource === "local_session"
          ? `${sensitive} step${sensitive === 1 ? "" : "s"} contain credential-like values. Prompts, responses, commands and outputs are otherwise shown in full.`
          : "The local execution session was not found, so this graph contains only telemetry emitted to SigNoz."}</p>
      </div>
      {graph.contentSource === "local_session" && sensitive > 0 && (graph.sensitiveValuesIncluded
        ? <Button variant="secondary" onClick={onHideSensitive} disabled={refreshingSensitive}><EyeOff />Hide sensitive values</Button>
        : <Button variant="secondary" onClick={() => setConfirmReveal(true)} disabled={refreshingSensitive}><Eye />Reveal sensitive values</Button>)}
    </div>

    {confirmReveal && !graph.sensitiveValuesIncluded && <div className="forensic-confirmation">
      <div><ShieldAlert /><span><strong>Reveal credential and authentication material?</strong><small>Values will be fetched from the local execution session and rendered in this browser. They are not sent to SigNoz or Tracey’s model.</small></span></div>
      <footer><Button variant="ghost" onClick={() => setConfirmReveal(false)}>Cancel</Button><Button onClick={() => { setConfirmReveal(false); onRevealSensitive(); }} disabled={refreshingSensitive}><KeyRound />Reveal for this session</Button></footer>
    </div>}

    <div className="execution-view-tabs" role="tablist" aria-label="Execution detail views">
      {([
        ["graph", ListTree, "Graph"],
        ["timeline", Clock3, "Timeline"],
        ["evidence", GitBranch, "Evidence"],
        ["raw", FileJson2, "Raw events"],
      ] as const).map(([value, Icon, label]) => <button key={value} role="tab" aria-selected={view === value} className={view === value ? "active" : ""} onClick={() => setView(value)}><Icon />{label}</button>)}
    </div>

    {view === "graph" && <div className="execution-graph-layout">
      <Panel className="execution-tree-panel" title="Prompt-to-action graph" subtitle="Solid connectors are directly correlated. Dashed connectors indicate timestamp-based sequence.">
        <div className="execution-tree">
          {graph.nodes.map((node, index) => {
            const edge = edgeByTarget.get(node.nodeId);
            return <div className={`execution-tree-step tree-kind-${node.kind}`} key={node.nodeId}>
              {index > 0 && <div className={`tree-connector ${edge?.certainty === "observed" ? "observed" : "inferred"}`}><span>{edge?.relationship === "tool_result" ? "result" : edge?.certainty}</span><ChevronDown /></div>}
              <button className={selected?.nodeId === node.nodeId ? "selected" : ""} onClick={() => setSelectedId(node.nodeId)}>
                <span className="tree-node-icon"><NodeIcon kind={node.kind} /></span>
                <span className="tree-node-copy"><small>{titleCase(node.kind)} · {dateTime(node.timestamp)}</small><strong>{node.label}</strong><p>{node.summary}</p></span>
                <span className="tree-node-meta">{node.durationMs !== undefined && <small>{duration(node.durationMs)}</small>}<StatusChip value={node.status} />{node.sensitive && <KeyRound aria-label="Contains sensitive values" />}</span>
              </button>
            </div>;
          })}
        </div>
      </Panel>
      <Panel className="execution-node-inspector" title="Step details" subtitle="Complete developer-facing content for the selected step.">
        {selected ? <div className="node-inspector-body">
          <header><span className="tree-node-icon"><NodeIcon kind={selected.kind} /></span><div><small>{titleCase(selected.kind)}</small><h3>{selected.label}</h3></div><StatusChip value={selected.status} /></header>
          <dl><div><dt>Observed at</dt><dd>{dateTime(selected.timestamp)}</dd></div><div><dt>Source</dt><dd>{selected.source === "codex_session" ? "Local execution session" : "SigNoz"}</dd></div>{selected.durationMs !== undefined && <div><dt>Duration</dt><dd>{duration(selected.durationMs)}</dd></div>}<div><dt>Sensitive content</dt><dd>{selected.sensitive ? graph.sensitiveValuesIncluded ? "Visible" : "Protected" : "None detected"}</dd></div></dl>
          {selected.content ? <pre className="execution-content">{selected.content}</pre> : <p className="content-unavailable">This producer did not emit content for this step.</p>}
          <JsonView value={selected.attributes} label="Step attributes and raw record" />
        </div> : <p className="content-unavailable">Select a graph node to inspect it.</p>}
      </Panel>
    </div>}

    {view === "timeline" && <Panel title="Execution timeline" subtitle="Every observed local or telemetry event in timestamp order."><div className="table-wrap"><table className="execution-timeline"><thead><tr><th>Time</th><th>Step</th><th>Status</th><th>Duration</th><th>Source</th></tr></thead><tbody>{graph.nodes.map((node) => <tr key={node.nodeId} onClick={() => { setSelectedId(node.nodeId); setView("graph"); }}><td>{dateTime(node.timestamp)}</td><td><strong>{node.label}</strong><small>{node.summary}</small></td><td><StatusChip value={node.status} /></td><td>{node.durationMs === undefined ? "—" : duration(node.durationMs)}</td><td>{node.source === "codex_session" ? "Local session" : "SigNoz"}</td></tr>)}</tbody></table></div></Panel>}

    {view === "evidence" && <div className="two-column execution-evidence">
      <Panel title="Source evidence" subtitle={`${graph.evidence.length} telemetry references attached to this turn.`}><div className="evidence-reference-list">{graph.evidence.map((reference, index) => <div key={`${reference.sourceTraceId}:${reference.sourceSpanId ?? index}`}><span><GitBranch /></span><div><strong>{reference.eventName}</strong><small>{dateTime(reference.timestamp)}</small><code>{reference.sourceTraceId}{reference.sourceSpanId ? ` · ${reference.sourceSpanId}` : ""}</code></div></div>)}</div></Panel>
      <Panel title="Evidence limits" subtitle="Tracey states where correlation is incomplete instead of inventing causality."><div className="limitation-list">{graph.limitations.length ? graph.limitations.map((limitation) => <p key={limitation}><ShieldAlert />{limitation}</p>) : <p><CheckCircle2 />No evidence limitations were reported for this turn.</p>}</div></Panel>
    </div>}

    {view === "raw" && <Panel title="Raw execution events" subtitle={graph.sensitiveValuesIncluded ? "Sensitive values are currently included in this local browser view." : "Raw event structure with detected credentials protected."}><JsonView value={graph.rawEvents} label={`${graph.rawEvents.length} raw records`} /></Panel>}
  </>;
}
