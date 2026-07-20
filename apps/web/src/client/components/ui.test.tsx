import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { Activity } from "lucide-react";
import { Button, EmptyState, ErrorState, LoadingState, MetricCard, Modal, PageHeader, StatusChip } from "./ui";

describe("Tracey UI states", () => {
  it("communicates lifecycle state with readable text, not color alone", () => {
    render(<><StatusChip value="awaiting_approval" /><StatusChip value="failed" /><StatusChip value="succeeded" /></>);
    expect(screen.getByText("Awaiting Approval")).toBeVisible();
    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("Succeeded")).toBeVisible();
  });

  it("provides useful empty and recoverable error actions", () => {
    const retry = vi.fn();
    render(<><EmptyState title="No runs" description="Connect telemetry to begin." /><ErrorState error={new Error("SigNoz unavailable")} onRetry={retry} /></>);
    expect(screen.getByText("Connect telemetry to begin.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps loading and partial-data states explicit", () => {
    render(<><LoadingState label="Checking Kubernetes" /><MetricCard label="P95 latency" value="—" detail="Latency attributes not emitted" icon={Activity} /></>);
    expect(screen.getByRole("status")).toHaveTextContent("Checking Kubernetes");
    expect(screen.getByText("Latency attributes not emitted")).toBeVisible();
  });

  it("labels confirmation dialogs and prevents disabled submission", () => {
    const close = vi.fn(); const submit = vi.fn();
    render(<Modal open title="Approve change" onClose={close}><Button disabled onClick={submit}>Execute</Button></Modal>);
    expect(screen.getByRole("dialog", { name: "Approve change" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Execute" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("has no essential automated accessibility violations", async () => {
    const { container } = render(<main><PageHeader title="Agents" description="Production agent health" /><StatusChip value="active" /><EmptyState title="No agents" description="Register an agent to begin." action={<Button>Register agent</Button>} /></main>);
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
