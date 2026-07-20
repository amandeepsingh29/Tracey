"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Inbox, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { titleCase } from "../lib/format";

export function StatusChip({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = ["ready", "active", "succeeded", "executed", "healthy", "evidence_bound"].includes(normalized)
    ? "success"
    : ["failed", "critical", "rejected", "revert_failed", "unhealthy"].includes(normalized)
      ? "danger"
      : ["awaiting_approval", "warning", "needs_configuration", "verifying", "executing", "reverting"].includes(normalized)
        ? "warning"
        : "neutral";
  return <span className={`status-chip status-${tone}`}><span aria-hidden="true" />{titleCase(value)}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      <p className="page-description">{description}</p>
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

export function Panel({ children, className = "", title, subtitle, action }: PropsWithChildren<{ className?: string; title?: string; subtitle?: string; action?: ReactNode }>) {
  return <section className={`panel ${className}`}>
    {(title || action) && <header className="panel-header"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</header>}
    {children}
  </section>;
}

export function MetricCard({ label, value, detail, icon: Icon, tone = "default" }: { label: string; value: ReactNode; detail: string; icon: LucideIcon; tone?: string }) {
  return <div className={`metric-card tone-${tone}`}>
    <div className="metric-icon"><Icon size={18} aria-hidden="true" /></div>
    <p>{label}</p><strong>{value}</strong><span>{detail}</span>
  </div>;
}

export function EmptyState({ title, description, action, icon: Icon = Inbox }: { title: string; description: string; action?: ReactNode; icon?: LucideIcon }) {
  return <div className="empty-state"><div className="empty-icon"><Icon aria-hidden="true" /></div><h2>{title}</h2><p>{description}</p>{action}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong while loading this view.";
  return <div className="error-state" role="alert"><AlertTriangle aria-hidden="true" /><div><h3>Couldn’t load this data</h3><p>{message}</p></div>{onRetry && <Button variant="secondary" onClick={onRetry}><RefreshCw size={16} />Retry</Button>}</div>;
}

export function LoadingState({ label = "Loading live Tracey data" }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><span>{label}</span></div>;
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Modal({ open, title, description, onClose, children }: PropsWithChildren<{ open: boolean; title: string; description?: string; onClose: () => void }>) {
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X /></button></header>
      {children}
    </section>
  </div>;
}

export function JsonView({ value, label = "Technical details" }: { value: unknown; label?: string }) {
  return <details className="json-view"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function SegmentedControl({ options, value, onChange, label }: { options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map((option) => <button key={option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)} aria-pressed={value === option.value}>{option.label}</button>)}</div>;
}
