"use client";

import {
  Activity, Bot, Cable, ChevronRight, CircleGauge, Command, FileSearch,
  GitPullRequestArrow, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { api } from "../lib/api";

const navigation = [
  { href: "/", label: "Overview", icon: CircleGauge },
  { href: "/runs", label: "Runs", icon: Activity },
  { href: "/investigations", label: "Investigate", icon: FileSearch },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/connectors", label: "Connectors", icon: Cable },
  { href: "/changes", label: "Changes", icon: GitPullRequestArrow },
  { href: "/settings", label: "Settings", icon: Settings },
];

const labels: Record<string, string> = { agents: "Agents", runs: "Runs", incidents: "Incidents", investigations: "Investigations", changes: "Changes", connectors: "Connectors", policies: "Policies", notifs: "Notifications", notifications: "Notifications", settings: "Settings", onboarding: "Get started" };

export function Shell({ children }: PropsWithChildren) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = useMemo(() => pathname.split("/").filter(Boolean), [pathname]);

  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem("tracey.sidebar-collapsed") === "true");
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setMobileOpen(false); }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("tracey.sidebar-collapsed", String(next));
      return next;
    });
  };

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark" aria-hidden="true"><Image src="/crumbles-logo.png" alt="" width={38} height={39} priority /></div><div><strong>Tracey</strong><span>Reliability control plane</span></div><button className="sidebar-collapse-button" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Minimize sidebar"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Expand sidebar" : "Minimize sidebar"}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X /></button></div>
      <nav aria-label="Primary navigation">{navigation.map(({ href, label, icon: Icon }) => { const active = href === "/" ? pathname === "/" : pathname.startsWith(href); return <Link key={href} href={href} className={active ? "active" : ""} title={sidebarCollapsed ? label : undefined} aria-label={sidebarCollapsed ? label : undefined} onClick={() => setMobileOpen(false)}><Icon size={18} aria-hidden="true" /><span>{label}</span></Link>; })}</nav>
      <div className="sidebar-footer"><div className="environment-dot"><span />System connected</div><p>Approval-first operations</p></div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <div className="workspace">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></button>
        <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Tracey</Link>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><ChevronRight size={14} />{index === crumbs.length - 1 ? <strong>{labels[crumb] ?? (crumb.length > 16 ? "Detail" : crumb)}</strong> : <Link href={`/${crumbs.slice(0, index + 1).join("/")}`}>{labels[crumb] ?? crumb}</Link>}</span>)}</nav>
        <div className="topbar-actions"><button className="search-trigger" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Search Tracey</span><kbd>⌘ K</kbd></button><button className="ask-button" onClick={() => router.push("/investigations?new=true")}><Command size={16} />Ask Tracey</button></div>
      </header>
      <main id="main-content">{children}</main>
    </div>
    {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} onNavigate={(path) => { setSearchOpen(false); router.push(path); }} />}
  </div>;
}

function CommandPalette({ onClose, onNavigate }: { onClose: () => void; onNavigate: (path: string) => void }) {
  const [value, setValue] = useState("");
  const agents = useQuery({ queryKey: ["agents", "global-search"], queryFn: () => api.agents(), staleTime: 30_000 });
  const actions = useQuery({ queryKey: ["actions", "global-search"], queryFn: () => api.actions(), staleTime: 30_000 });
  const term = value.trim().toLowerCase();
  const pages = navigation.filter((item) => item.label.toLowerCase().includes(term)).map((item) => ({ path: item.href, label: item.label, meta: "Page", icon: item.icon }));
  const entities = term.length < 2 ? [] : [
    ...(agents.data?.agents ?? []).filter((item) => [item.displayName, item.serviceName, item.environment].some((text) => text.toLowerCase().includes(term))).slice(0, 4).map((item) => ({ path: `/agents/${item.agentId}`, label: item.displayName, meta: `Agent · ${item.serviceName}`, icon: Bot })),
    ...(actions.data?.actions ?? []).filter((item) => [item.target, item.reason, item.actionType].some((text) => text.toLowerCase().includes(term))).slice(0, 4).map((item) => ({ path: `/changes/${item.proposalId}`, label: item.remediationPlan?.summary ?? item.actionType, meta: `Change · ${item.target}`, icon: GitPullRequestArrow })),
  ];
  const results = [...entities, ...pages].slice(0, 12);
  return <div className="command-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Search Tracey"><div className="command-input"><Search /><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="Find agents, runs, and changes…" aria-label="Search" /><kbd>ESC</kbd></div><div className="command-results">{results.map(({ path, label, meta, icon: Icon }) => <button key={path} onClick={() => onNavigate(path)}><Icon size={17} /><span><strong>{label}</strong><small>{meta}</small></span><ChevronRight size={15} /></button>)}{value && <button onClick={() => onNavigate(`/runs?search=${encodeURIComponent(value)}`)}><Activity size={17} /><span><strong>Search observed runs</strong><small>Run ID, trace ID, model, or service matching “{value}”</small></span><ChevronRight size={15} /></button>}</div></section></div>;
}
