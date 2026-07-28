"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Bot, Check, ChevronDown, Download, History, MessageSquare, PanelRight,
  Plus, Send, ShieldCheck, Sparkles, TriangleAlert, UserRound, X,
} from "lucide-react";
import Image from "next/image";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ErrorState, LoadingState, StatusChip } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, relativeTime } from "../lib/format";
import { usePersistedDraft } from "../lib/usePersistedDraft";

const starterPrompts = [
  {
    label: "Inspect Kubernetes health",
    prompt: "Inspect active Kubernetes pods across connected namespaces and report unhealthy workloads.",
  },
  {
    label: "Find failed agent runs",
    prompt: "Which production agents have failed runs in the last 24 hours, and what evidence explains them?",
  },
  {
    label: "Review recent Codex activity",
    prompt: "Search recent Codex activity from the last 24 hours and summarize tool calls, failures, and latency.",
  },
];

function conversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact;
}

const operatorModes = ["observe", "recommend", "approval"] as const;
type OperatorMode = (typeof operatorModes)[number];

const modeDescriptions: Record<OperatorMode, string> = {
  observe: "Investigate only. No change proposals or execution.",
  recommend: "Recommend changes without executing them.",
  approval: "Every infrastructure change waits for human approval.",
};

const modeLabels: Record<OperatorMode, string> = {
  observe: "Observe",
  recommend: "Recommend",
  approval: "Approval",
};

function PolicyModeControl() {
  const client = useQueryClient();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const query = useQuery({ queryKey: ["policies"], queryFn: api.policies });
  const record = query.data?.policies.find((item) => item.scopeType === "global" && item.scopeId === "default");
  const mode = record?.policy.mode;
  const visibleMode = mode && operatorModes.includes(mode as OperatorMode) ? mode as OperatorMode : undefined;
  const save = useMutation({
    mutationFn: (nextMode: OperatorMode) => {
      if (!record) throw new Error("No global autonomy policy is configured.");
      return api.savePolicy("global", "default", { ...record.policy, mode: nextMode });
    },
    onSuccess: async () => {
      detailsRef.current?.removeAttribute("open");
      await client.invalidateQueries({ queryKey: ["policies"] });
    },
  });
  const chooseMode = (nextMode: OperatorMode) => {
    if (nextMode === mode) {
      detailsRef.current?.removeAttribute("open");
      return;
    }
    save.mutate(nextMode);
  };

  return <details className="composer-mode-control" ref={detailsRef}>
    <summary aria-label={`Tracey mode: ${visibleMode ? modeLabels[visibleMode] : "unavailable"}`}>
      <ShieldCheck />
      <span>{query.isLoading ? "Loading mode" : visibleMode ? modeLabels[visibleMode] : mode ? "Advanced mode active" : "Mode unavailable"}</span>
      <ChevronDown />
    </summary>
    <div className="composer-mode-menu">
      <header><strong>Tracey mode</strong><span>Controls how evidence can become action.</span></header>
      {!visibleMode && mode && <div className="mode-confirmation"><TriangleAlert /><div><strong>Unattended mode is active</strong><p>Select Approval to require confirmation before infrastructure changes.</p></div></div>}
      <div className="composer-mode-options">{operatorModes.map((item) => <button type="button" key={item} className={item === mode ? "active" : ""} disabled={!record || save.isPending} onClick={() => chooseMode(item)}>
        <span><ShieldCheck /></span>
        <div><strong>{modeLabels[item]}</strong><small>{modeDescriptions[item]}</small></div>
        {item === mode && <Check />}
      </button>)}</div>
      {save.error && <p className="composer-mode-error">{save.error.message}</p>}
    </div>
  </details>;
}

export function InvestigationsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const client = useQueryClient();
  const traceId = params.get("traceId");
  const traceStart = params.get("start");
  const traceEnd = params.get("end");
  const tracePrompt = useMemo(() => traceId && traceStart && traceEnd
    ? `Analyze trace ${traceId} between epoch milliseconds ${traceStart} and ${traceEnd}. Report only observed status, latency, tool calls, failures, and missing evidence. Use Tracey tools and cite the returned trace evidence.`
    : "", [traceEnd, traceId, traceStart]);
  const [draft, setDraft] = useState(tracePrompt);
  useEffect(() => { if (tracePrompt) setDraft(tracePrompt); }, [tracePrompt]);
  const query = useQuery({ queryKey: ["investigations"], queryFn: api.investigations });
  const create = useMutation({
    mutationFn: ({ title }: { title: string; prompt: string }) => api.createInvestigation(title),
    onSuccess: async (session, variables) => {
      await client.invalidateQueries({ queryKey: ["investigations"] });
      router.push(`/investigations/${session.sessionId}?prompt=${encodeURIComponent(variables.prompt)}`);
    },
  });
  const startConversation = (prompt: string) => {
    const content = prompt.trim();
    if (!content || create.isPending) return;
    create.mutate({ title: conversationTitle(content), prompt: content });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startConversation(draft);
  };
  const sessions = query.data?.investigations ?? [];

  return <div className="investigation-home-page">
    <aside className="chat-history">
      <header><div><span>TRACEY</span><strong>Conversations</strong></div><button onClick={() => setDraft("")} aria-label="New conversation"><Plus /></button></header>
      <div className="chat-history-list">
        {query.isLoading ? <LoadingState label="Loading conversations" /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : sessions.length === 0 ? <p className="history-empty">Your investigations will appear here.</p> : sessions.map((session) => <button key={session.sessionId} onClick={() => router.push(`/investigations/${session.sessionId}`)}><MessageSquare /><span><strong>{session.title}</strong><small>{relativeTime(session.updatedAt)}</small></span></button>)}
      </div>
    </aside>
    <section className="chat-home-main">
      <div className="chat-home-content">
        <div className="tracey-orb" aria-hidden="true"><Image src="/crumbles-logo.png" alt="" width={48} height={49} priority /></div>
        <p className="chat-kicker">AI RELIABILITY INVESTIGATOR</p>
        <h1>What should we investigate?</h1>
        <form className="chat-start-composer" onSubmit={submit}>
          <textarea
            autoFocus
            rows={3}
            maxLength={8000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message Tracey"
            aria-label="Start a Tracey investigation"
            disabled={create.isPending}
          />
          <footer><PolicyModeControl /><span>Tracey can make mistakes. Verify critical changes before approval.</span><button aria-label="Start investigation" disabled={create.isPending || !draft.trim()}><Send /></button></footer>
        </form>
        {create.error && <p className="composer-error" role="alert">{create.error.message}</p>}
        <div className="chat-suggestions">{starterPrompts.map((item) => <button key={item.label} onClick={() => startConversation(item.prompt)} disabled={create.isPending}><Sparkles /><span>{item.label}</span></button>)}</div>
      </div>
    </section>
  </div>;
}

export function InvestigationDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const sessionId = params.sessionId ?? "";
  const router = useRouter();
  const client = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);
  const promptSent = useRef(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [messageDraft, setMessageDraft] = usePersistedDraft(`tracey.investigation-draft.${sessionId}`);
  const sessions = useQuery({ queryKey: ["investigations"], queryFn: api.investigations });
  const messages = useQuery({ queryKey: ["messages", sessionId], queryFn: () => api.messages(sessionId), refetchInterval: 15_000 });
  const actions = useQuery({ queryKey: ["actions"], queryFn: () => api.actions(), refetchInterval: 5_000 });
  const send = useMutation({
    mutationFn: (content: string) => api.chat(sessionId, content),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["messages", sessionId] }),
        client.invalidateQueries({ queryKey: ["actions"] }),
        client.invalidateQueries({ queryKey: ["investigations"] }),
      ]);
    },
  });
  useEffect(() => {
    const prompt = searchParams.get("prompt");
    if (prompt && !promptSent.current) {
      promptSent.current = true;
      send.mutate(prompt);
    }
  }, [searchParams]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.data?.messages.length, send.isPending]);
  const session = sessions.data?.investigations.find((item) => item.sessionId === sessionId);
  const relatedActions = actions.data?.actions.filter((action) => action.sessionId === sessionId) ?? [];
  const pendingAction = relatedActions.find((action) => action.status === "awaiting_approval");
  const assistantMessages = messages.data?.messages.filter((message) => message.role === "assistant") ?? [];
  const latestAssistant = assistantMessages.at(-1);
  const evidence = assistantMessages.flatMap((message) => message.evidenceRefs);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = messageDraft.trim();
    if (!content) return;
    send.mutate(content, { onSuccess: () => setMessageDraft("") });
  };
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  const approve = useMutation({
    mutationFn: async (proposalId: string) => {
      await api.decideAction(proposalId, "approved");
      return api.executeAction(proposalId);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["actions"] }),
        client.invalidateQueries({ queryKey: ["messages", sessionId] }),
        client.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
  });
  const reject = useMutation({
    mutationFn: (proposalId: string) => api.decideAction(proposalId, "rejected"),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["actions"] }),
        client.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
  });
  const exportReport = () => {
    const lines = [
      `# ${session?.title ?? "Tracey investigation"}`, "", `Exported: ${new Date().toISOString()}`, "",
      ...(messages.data?.messages ?? []).flatMap((message) => [
        `## ${message.role === "assistant" ? "Tracey" : "Operator"} · ${dateTime(message.createdAt)}`,
        "", message.content, "",
      ]),
    ];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    link.download = `tracey-investigation-${sessionId}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return <div className="investigation-chat-page">
    <aside className={`chat-history detail-history ${historyOpen ? "open" : ""}`}>
      <header><button className="history-back" onClick={() => router.push("/investigations")}><ArrowLeft />Investigations</button><button onClick={() => setHistoryOpen(false)} aria-label="Close conversation history"><X /></button></header>
      <button className="new-chat-button" onClick={() => router.push("/investigations")}><Plus />New conversation</button>
      <div className="chat-history-list">{(sessions.data?.investigations ?? []).map((item) => <button key={item.sessionId} className={item.sessionId === sessionId ? "active" : ""} onClick={() => { setHistoryOpen(false); router.push(`/investigations/${item.sessionId}`); }}><MessageSquare /><span><strong>{item.title}</strong><small>{relativeTime(item.updatedAt)}</small></span></button>)}</div>
    </aside>

    <section className="chat-workspace">
      <header className="chat-workspace-header">
        <div className="chat-title">
          <button onClick={() => setHistoryOpen(true)} aria-label="Open conversation history"><History /></button>
          <div><strong>{session?.title ?? "Tracey investigation"}</strong><span>{latestAssistant?.grounding ? `${latestAssistant.grounding.replaceAll("_", " ")} · ` : ""}{evidence.length} evidence reference{evidence.length === 1 ? "" : "s"}</span></div>
        </div>
        <div className="chat-header-actions">
          <button onClick={() => setContextOpen((value) => !value)} className={contextOpen ? "active" : ""}><PanelRight />Context</button>
          <button onClick={exportReport} disabled={!messages.data?.messages.length} aria-label="Export investigation"><Download /></button>
        </div>
      </header>

      <div className="chat-scroll">
        <div className="chat-thread">
          {messages.isLoading ? <LoadingState /> : messages.error ? <ErrorState error={messages.error} onRetry={() => void messages.refetch()} /> : !messages.data?.messages.length ? <div className="chat-empty">
            <div className="tracey-orb" aria-hidden="true"><Image src="/crumbles-logo.png" alt="" width={48} height={49} /></div>
            <h2>Start the investigation</h2>
            <p>Give Tracey an agent, service, trace, namespace, or symptom. It will gather evidence before making technical claims.</p>
            <div className="chat-suggestions">{starterPrompts.slice(0, 2).map((item) => <button key={item.label} onClick={() => send.mutate(item.prompt)}><Sparkles /><span>{item.label}</span></button>)}</div>
          </div> : messages.data.messages.map((message) => <article key={message.messageId} className={`chat-turn chat-turn-${message.role}`}>
            <div className="chat-turn-avatar">{message.role === "assistant" ? <Bot /> : <UserRound />}</div>
            <div className="chat-turn-content">
              <header><strong>{message.role === "assistant" ? "Tracey" : "You"}</strong><span>{dateTime(message.createdAt)}</span>{message.grounding && <StatusChip value={message.grounding} />}</header>
              <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ table: ({ children, ...props }) => <div className="markdown-table-wrap"><table {...props}>{children}</table></div> }}>{message.content}</ReactMarkdown></div>
              {message.evidenceRefs.length > 0 && <details className="chat-evidence"><summary>{message.evidenceRefs.length} source{message.evidenceRefs.length === 1 ? "" : "s"} used</summary>{message.evidenceRefs.map((reference, index) => <div key={reference.traceId ? `${reference.traceId}-${reference.spanId ?? index}` : `${reference.sourceType}-${reference.sourceId ?? index}`}><code>{reference.traceId ? `${reference.traceId}${reference.spanId ? ` / ${reference.spanId}` : ""}` : `${reference.sourceType ?? "tool"} · ${reference.sourceId ?? reference.signal ?? "observation"}`}</code>{reference.observation && <p>{reference.observation}</p>}</div>)}</details>}
            </div>
          </article>)}
          {send.isPending && <article className="chat-turn chat-turn-assistant"><div className="chat-turn-avatar"><Bot /></div><div className="chat-turn-content"><header><strong>Tracey</strong></header><div className="thinking"><span /><span /><span />Gathering evidence…</div></div></article>}
          <div ref={endRef} />
        </div>
      </div>

      <div className="chat-composer-dock">
        {pendingAction && <section className="composer-approval-card" aria-live="polite">
          <div className="approval-card-icon"><ShieldCheck /></div>
          <div className="approval-card-copy">
            <header><span>Approval required</span><code>{pendingAction.proposalId.slice(0, 8)}</code></header>
            <strong>{pendingAction.remediationPlan?.summary ?? `${pendingAction.actionType} ${pendingAction.target}`}</strong>
            <p>{pendingAction.target} · {pendingAction.risk} risk{pendingAction.remediationPlan?.expectedImpact ? ` · ${pendingAction.remediationPlan.expectedImpact}` : ""}</p>
          </div>
          <div className="approval-card-actions">
            <button className="approval-reject" disabled={approve.isPending || reject.isPending} onClick={() => reject.mutate(pendingAction.proposalId)}><X />Reject</button>
            <button className="approval-accept" disabled={approve.isPending || reject.isPending} onClick={() => approve.mutate(pendingAction.proposalId)}><Check />{approve.isPending ? "Executing…" : "Approve & run"}</button>
          </div>
        </section>}
        {(approve.error || reject.error) && <p className="approval-error" role="alert">{(approve.error ?? reject.error)?.message}</p>}
        <form className="chatgpt-composer" onSubmit={submit}>
          <textarea
            name="content"
            rows={1}
            maxLength={8000}
            value={messageDraft}
            onChange={(event) => setMessageDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask Tracey a follow-up"
            aria-label="Message Tracey"
            disabled={send.isPending}
          />
          <PolicyModeControl />
          <button aria-label="Send message" disabled={send.isPending || !messageDraft.trim()}><Send /></button>
        </form>
        <p>Enter to send · Shift + Enter for a new line · Changes always require policy evaluation</p>
        {send.error && <p className="composer-error" role="alert">{send.error.message}</p>}
      </div>
    </section>

    {contextOpen && <aside className="chat-context-drawer">
      <header><div><span>INVESTIGATION CONTEXT</span><strong>Evidence and actions</strong></div><button onClick={() => setContextOpen(false)} aria-label="Close investigation context"><X /></button></header>
      <section className="context-summary"><p>{latestAssistant?.content.split("\n").find((line) => line.trim()) ?? "No grounded summary yet."}</p></section>
      <dl className="context-stats"><div><dt>Status</dt><dd><StatusChip value={session?.status ?? "active"} /></dd></div><div><dt>Messages</dt><dd>{messages.data?.messages.length ?? 0}</dd></div><div><dt>Evidence</dt><dd>{evidence.length}</dd></div><div><dt>Changes</dt><dd>{relatedActions.length}</dd></div></dl>
      <section className="context-section"><header><strong>Evidence</strong><span>{evidence.length}</span></header>{evidence.length === 0 ? <p>No tool evidence returned yet.</p> : <div className="context-evidence-list">{evidence.slice(0, 20).map((item, index) => <div key={`${item.traceId ?? item.sourceId ?? "evidence"}-${index}`}><code>{item.traceId ?? item.sourceId ?? item.signal}</code><span>{item.signal ?? item.sourceType ?? "trace"}</span>{item.observation && <p>{item.observation}</p>}</div>)}</div>}</section>
      <section className="context-section"><header><strong>Related changes</strong><span>{relatedActions.length}</span></header>{relatedActions.length === 0 ? <p>No remediation proposed. Ask Tracey after the evidence supports a specific change.</p> : <div className="context-change-list">{relatedActions.map((action) => <button key={action.proposalId} onClick={() => router.push(`/changes/${action.proposalId}`)}><span><strong>{action.remediationPlan?.summary ?? action.actionType}</strong><code>{action.target}</code></span><StatusChip value={action.status} /></button>)}</div>}</section>
    </aside>}
    {historyOpen && <button className="chat-drawer-scrim" onClick={() => setHistoryOpen(false)} aria-label="Close conversation history" />}
  </div>;
}
