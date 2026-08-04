"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, Globe2, RefreshCw, ScanSearch, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { relativeTime, titleCase } from "../lib/format";
import type { WebsiteFinding, WebsiteScan, WebsiteTarget } from "../types";
import { Button, EmptyState, ErrorState, Field, LoadingState, PageHeader, Panel, StatusChip } from "../components/ui";

type Verification = { targetId: string; origin: string; path: string; content: string; instructions: string };

export function WebsiteSecurityPage() {
  const client = useQueryClient();
  const [verification, setVerification] = useState<Verification>();
  const [selectedTargetId, setSelectedTargetId] = useState<string>();
  const [selectedScanId, setSelectedScanId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const targets = useQuery({ queryKey: ["website-targets"], queryFn: api.websiteTargets });
  const scans = useQuery({
    queryKey: ["website-scans", selectedTargetId],
    queryFn: () => api.websiteScans(selectedTargetId),
    refetchInterval: (query) => query.state.data?.scans.some(({ status }) => status === "queued" || status === "running") ? 2_000 : false,
  });
  const selectedTarget = targets.data?.targets.find(({ targetId }) => targetId === selectedTargetId);
  const selectedScan = scans.data?.scans.find(({ scanId }) => scanId === selectedScanId) ?? scans.data?.scans[0];

  useEffect(() => {
    if (!selectedTargetId && targets.data?.targets[0]) setSelectedTargetId(targets.data.targets[0].targetId);
  }, [selectedTargetId, targets.data]);
  useEffect(() => {
    if (selectedScan?.scanId && selectedScan.scanId !== selectedScanId) setSelectedScanId(selectedScan.scanId);
  }, [selectedScan?.scanId, selectedScanId]);

  const addTarget = useMutation({
    mutationFn: api.createWebsiteTarget,
    onSuccess: async ({ target, verification: issued }) => {
      await client.invalidateQueries({ queryKey: ["website-targets"] });
      setSelectedTargetId(target.targetId);
      setError(undefined);
      if (issued) setVerification({ targetId: target.targetId, origin: target.origin, ...issued });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const verify = useMutation({
    mutationFn: ({ targetId, token }: { targetId: string; token: string }) => api.verifyWebsiteTarget(targetId, token),
    onSuccess: async ({ target }) => {
      await client.invalidateQueries({ queryKey: ["website-targets"] });
      setVerification(undefined); setSelectedTargetId(target.targetId); setError(undefined);
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const startScan = useMutation({
    mutationFn: api.createWebsiteScan,
    onSuccess: async ({ scan }) => {
      setSelectedScanId(scan.scanId); setError(undefined);
      await client.invalidateQueries({ queryKey: ["website-scans"] });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const submitTarget = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    addTarget.mutate(String(data.get("url") ?? ""));
  };
  const copyToken = async () => {
    if (!verification) return;
    await navigator.clipboard.writeText(verification.content);
    setCopied(true); window.setTimeout(() => setCopied(false), 1_500);
  };
  const summary = selectedScan?.result?.summary;
  const totalFindings = summary ? Object.values(summary).reduce((sum, count) => sum + count, 0) : 0;

  return <div className="page website-security-page">
    <PageHeader eyebrow="AUTHORIZED WEBSITE REVIEW" title="Website security" description="Verify a website you control, then run a bounded, read-only security review. Tracey makes GET requests only, stays on the verified origin, and never sends attack payloads." actions={<Button variant="secondary" onClick={() => { void targets.refetch(); void scans.refetch(); }}><RefreshCw size={15} />Refresh</Button>} />
    <div className="security-boundary"><ShieldCheck /><div><strong>Ownership is required before any scan</strong><p>Tracey checks a one-time file on the website. The current scanner examines transport, headers, cookies, CORS, and page references; it is not a penetration test.</p></div></div>
    <div className="security-layout">
      <div className="security-sidebar">
        <Panel title="Add a website" subtitle="Only HTTPS origins are accepted."><form className="form-stack" onSubmit={submitTarget}><Field label="Website URL" hint="Example: https://app.example.com"><input name="url" type="url" required placeholder="https://your-site.com" /></Field>{error && <p className="form-error" role="alert">{error}</p>}<Button disabled={addTarget.isPending}>{addTarget.isPending ? "Preparing verification…" : "Verify ownership"}</Button></form></Panel>
        <Panel title="Your websites" subtitle="Select a verified target to scan.">{targets.isLoading ? <LoadingState /> : targets.error ? <ErrorState error={targets.error} onRetry={() => void targets.refetch()} /> : !targets.data?.targets.length ? <EmptyState icon={Globe2} title="No websites added" description="Add an HTTPS URL to begin ownership verification." /> : <div className="security-target-list">{targets.data.targets.map((target) => <button key={target.targetId} className={target.targetId === selectedTargetId ? "active" : ""} onClick={() => { setSelectedTargetId(target.targetId); setSelectedScanId(undefined); }}><span><strong>{target.origin}</strong><small>{target.verifiedAt ? `Verified ${relativeTime(target.verifiedAt)}` : "Waiting for ownership proof"}</small></span><StatusChip value={target.status} /></button>)}</div>}</Panel>
      </div>
      <div className="security-main">
        {verification && verification.targetId === selectedTargetId ? <VerificationPanel verification={verification} copied={copied} busy={verify.isPending} onCopy={() => void copyToken()} onVerify={() => verify.mutate({ targetId: verification.targetId, token: verification.content })} /> : !selectedTarget ? <Panel><EmptyState icon={ScanSearch} title="Choose a website" description="Add or select a website to view verification and scans." /></Panel> : selectedTarget.status !== "verified" ? <Panel title="Verification token unavailable" subtitle="For safety, Tracey shows a token only once."><EmptyState icon={TriangleAlert} title="Issue a new verification token" description="Submit this website URL again. Tracey will replace the old token and show the new value once." /></Panel> : <>
          <Panel title={selectedTarget.origin} subtitle="Ownership verified. Scans are queued durably and continue if you leave this page." action={<Button onClick={() => startScan.mutate(selectedTarget.targetId)} disabled={startScan.isPending || selectedScan?.status === "queued" || selectedScan?.status === "running"}><ScanSearch size={16} />{startScan.isPending ? "Queueing…" : "Run security review"}</Button>}>
            <div className="scan-scope"><span><Check />GET only</span><span><Check />Same origin</span><span><Check />No payloads</span><span><Check />512 KiB response limit</span></div>
          </Panel>
          <div className="security-results-grid">
            <Panel title="Scan history" subtitle="Newest scans first.">{scans.isLoading ? <LoadingState /> : scans.error ? <ErrorState error={scans.error} onRetry={() => void scans.refetch()} /> : !scans.data?.scans.length ? <EmptyState icon={ScanSearch} title="No scans yet" description="Run the first bounded review for this website." /> : <div className="scan-history">{scans.data.scans.map((scan) => <button key={scan.scanId} className={scan.scanId === selectedScan?.scanId ? "active" : ""} onClick={() => setSelectedScanId(scan.scanId)}><span><strong>{relativeTime(scan.createdAt)}</strong><small>{scan.result ? `${scan.result.findings.length} findings · HTTP ${scan.result.statusCode}` : scan.errorType ?? "Waiting for worker"}</small></span><StatusChip value={scan.status} /></button>)}</div>}</Panel>
            <Panel title="Latest result" subtitle={selectedScan ? `Requested ${relativeTime(selectedScan.createdAt)}` : "No scan selected"}>{!selectedScan ? <EmptyState title="No result selected" description="Choose a scan to inspect its evidence." /> : selectedScan.status === "queued" || selectedScan.status === "running" ? <LoadingState label={selectedScan.status === "queued" ? "Waiting for a worker" : "Reviewing the verified website"} /> : selectedScan.status === "failed" ? <ErrorState error={new Error(`Scan failed: ${selectedScan.errorType ?? "unknown error"}`)} /> : <ScanResult scan={selectedScan} total={totalFindings} summary={summary!} />}</Panel>
          </div>
        </>}
      </div>
    </div>
  </div>;
}

function VerificationPanel({ verification, copied, busy, onCopy, onVerify }: { verification: Verification; copied: boolean; busy: boolean; onCopy: () => void; onVerify: () => void }) {
  return <Panel title="Prove website ownership" subtitle={`Publish one file on ${verification.origin}.`}><ol className="verification-instructions"><li>Create <code>{verification.path}</code> on your website.</li><li>Put this exact single line in the file:</li></ol><div className="verification-token"><code>{verification.content}</code><Button variant="secondary" onClick={onCopy}>{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? "Copied" : "Copy"}</Button></div><p className="connection-note">The URL must be publicly reachable over HTTPS and return this value with HTTP 200.</p><div className="panel-footer-actions"><Button onClick={onVerify} disabled={busy}>{busy ? "Checking website…" : "I published the file"}</Button></div></Panel>;
}

function ScanResult({ scan, total, summary }: { scan: WebsiteScan; total: number; summary: Record<WebsiteFinding["severity"], number> }) {
  const result = scan.result!;
  return <div className="scan-result"><div className="finding-summary"><div><strong>{total}</strong><span>Total findings</span></div>{(["high", "medium", "low", "info"] as const).map((severity) => <div key={severity} className={`severity-${severity}`}><strong>{summary[severity]}</strong><span>{titleCase(severity)}</span></div>)}</div><dl className="scan-metadata"><div><dt>Response</dt><dd>HTTP {result.statusCode}</dd></div><div><dt>TLS</dt><dd>{result.tls?.protocol ?? "Not reported"}</dd></div><div><dt>Requests</dt><dd>{result.scope.requestsMade} GET</dd></div><div><dt>Evidence hash</dt><dd><code>{result.bodySha256.slice(0, 12)}…</code></dd></div></dl>{result.findings.length ? <div className="finding-list">{result.findings.map((finding) => <article key={finding.findingId}><header><StatusChip value={finding.severity} /><strong>{finding.title}</strong><code>{finding.standard}</code></header><p>{finding.evidence}</p><footer><strong>Fix</strong><span>{finding.remediation}</span></footer></article>)}</div> : <div className="scan-clear"><ShieldCheck /><div><strong>No issues found by this bounded review</strong><p>This does not prove the website is vulnerability-free. It only means the checks listed in scope did not produce a finding.</p></div></div>}</div>;
}
