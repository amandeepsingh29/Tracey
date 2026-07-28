---
title: "Tracey — Reliability control plane for production AI agents"
description: "Observe AI-agent runs, investigate failures with evidence, and execute verified cloud recovery through approval-first controls."
primary_cta: "Get started"
secondary_cta: "See how Tracey works"
---

# Tracey

## Know why your agents fail. Fix production with evidence.

Tracey is a reliability and cloud-operations control plane for production AI agents.

It connects agent telemetry, observability data, and Kubernetes state in one operating surface—so your team can understand failed runs, investigate incidents conversationally, prepare safe remediations, and verify that recovery actually worked.

Tracey works with Codex, Claude Code, and custom OpenTelemetry agents. Your agents stay independently deployed. Your raw telemetry stays in SigNoz. Tracey adds the operational intelligence and control layer above them.

**Primary action:** Get started

**Secondary action:** See how Tracey works

**Works with:** Codex · Claude Code · Custom OpenTelemetry agents · SigNoz · Kubernetes · MCP

---

## Your agents are running in production. Their failures should not be a mystery.

Traditional observability platforms show spans, logs, and charts. They do not understand an agent run as a sequence of model decisions, tool calls, side effects, infrastructure dependencies, and user outcomes.

When an agent fails, operators are left answering difficult questions manually:

- Which production agents are failing?
- Was the problem caused by the model, a tool, a dependency, or infrastructure?
- What changed before the failure?
- Which services and users are affected?
- Is a restart enough, or should the deployment be rolled back?
- Did the remediation actually restore agent health?

Tracey turns those disconnected signals into an evidence-backed operational workflow.

---

## One place to observe, investigate, act, and verify

### Observe every connected agent

Track registered agents across environments and understand their operational state from real telemetry.

- Run volume and outcomes
- Recent failures
- Model and tool activity
- Latency, token usage, and estimated cost when emitted
- Trace and log completeness
- Related incidents and infrastructure state

Tracey never fabricates a healthy status when telemetry is missing. Incomplete evidence is shown as incomplete evidence.

### Investigate in plain language

Ask Tracey the same questions you would ask an experienced reliability engineer:

> Which production agents failed in the last 24 hours, and what evidence explains them?

> Why did this run fail?

> Is the notes service live?

> What changed before the error rate increased?

Tracey selects bounded read tools, gathers evidence from connected systems, and returns a grounded answer with its sources and limitations attached.

### Connect the complete incident picture

Tracey correlates:

- Agent runs and decisions
- Model and tool execution
- Traces, logs, metrics, and exceptions
- Kubernetes workloads, events, rollouts, and resource health
- Incidents, prior changes, policies, and recovery history

The result is not another generic dashboard. It is an operational explanation of what happened and what should happen next.

### Prepare safe remediation

Tracey can convert an investigation into a typed remediation plan with:

- The proposed action
- Supporting evidence
- Expected impact
- Risk and confidence
- Estimated blast radius
- Verification criteria
- Recovery or rollback behavior

The model can prepare a plan. It cannot directly mutate infrastructure.

### Approve changes with full context

Every proposed change is evaluated by a deterministic policy engine before execution.

Operators can review:

- What will change
- Why Tracey recommends it
- Which resources are affected
- Which policy allowed or denied it
- Whether approval is required
- How success will be measured
- What happens if verification fails

Generic Kubernetes apply, patch, and delete operations always require explicit administrator confirmation.

### Verify recovery—not just API acceptance

A successful API response does not prove that production recovered.

After an approved action, Tracey checks:

- Workload readiness
- Replica recovery
- Rollout state
- Error-rate changes
- Latency changes
- Minimum evidence requirements

If a permitted action causes a regression, Tracey can execute its defined recovery path and verify the system again.

---

## From incident to verified recovery

### 1. Connect

Connect SigNoz for observability and Kubernetes for infrastructure investigation. Add Codex, Claude Code, custom OpenTelemetry agents, or an allowlisted MCP server.

### 2. Observe

Tracey discovers registered agent identities and queries their real production telemetry without taking ownership of the agent application.

### 3. Investigate

Start from an alert, failed run, incident, trace, conversation, or natural-language question. Tracey gathers bounded evidence across connected systems.

### 4. Decide

Tracey prepares a typed remediation plan. The policy engine evaluates environment, resource scope, action type, risk, confidence, blast radius, cooldowns, concurrency, and maintenance windows.

### 5. Execute

Approved changes are sent to a separately authenticated restricted executor. Every execution is idempotent and auditable.

### 6. Verify

Tracey compares workload and observability health after the change. It records success only when the configured evidence passes.

### 7. Recover

If verification detects a regression, Tracey follows the permitted rollback or recovery path and verifies the recovered state.

---

## Built for real agent operations

### Agent fleet

Manage Codex, Claude Code, and custom OpenTelemetry agents across services and environments. See health, run history, telemetry readiness, failures, and related incidents.

### Run and trace explorer

Inspect a run from its root through model calls, tool execution, downstream services, errors, and critical-path latency.

### Evidence-bound investigations

Use a conversational workspace without losing operational rigor. Tool activity, grounding status, evidence references, and investigation history remain attached to the conversation.

### Incident workspace

Track impact, severity, affected agents, investigation history, ownership, changes, verification, and recovery in one durable timeline.

### Change control

Preview proposed remediations, inspect risk and blast radius, approve or reject actions, and follow the complete execution timeline.

### Policy and autonomy

Choose how much authority Tracey has for each environment and workload. Keep production approval-first or permit narrowly scoped automatic recovery.

### Operational inbox

Receive triggered investigations, connector problems, approval requests, execution failures, and recovery outcomes inside Tracey at `/notifs`. Slack, email, or PagerDuty are not required for the core workflow.

### Connector control

Test connectivity and permissions, save encrypted connector credentials, monitor readiness, and reconfigure, disable, or remove integrations without exposing stored secrets in the browser.

---

## Autonomy that matches your operating model

Tracey supports five operating modes.

### Observe

Read-only investigation. Every mutation is denied.

### Recommend

Tracey can prepare and store remediation plans, but it cannot execute them.

### Approval

Every mutation waits for administrator approval. This is the recommended starting mode for production teams.

### Guarded autopilot

Reversible, allowlisted actions can execute automatically within configured risk, confidence, environment, workload, cooldown, concurrency, and blast-radius limits.

### Full autopilot

Broader allowlisted execution for teams with mature policies and operational controls. Mandatory prohibitions still apply.

No mode gives the model a shell or unrestricted cloud credentials.

---

## Connect the systems you already use

### SigNoz

Tracey uses SigNoz as the system of record for traces, logs, and metrics. It queries bounded telemetry and leaves raw observability data in place.

**Available capabilities:** agent-run discovery, trace investigation, log and exception analysis, metrics, before-and-after comparisons, and recovery evidence.

### Kubernetes

Inspect workloads and perform approved, typed remediation through separate investigator and executor identities.

**Available capabilities:** pod and deployment health, logs, events, rollouts, replica history, resource usage, services, ingress, autoscaling, disruption budgets, restarts, rollbacks, scaling, resource updates, Jobs, CronJobs, and bounded resource changes.

### Codex

Normalize privacy-safe Codex Desktop and CLI OpenTelemetry events into agent runs, model activity, tool activity, failures, latency, and token evidence.

For developer workstations, Tracey can read the matching local Codex session to build a complete prompt-to-action graph. This local forensic connector can be disabled and does not export captured conversation content back to SigNoz.

### Claude Code

Observe Claude Code interactions through native OpenTelemetry export and a producer-specific normalization profile.

Tracey does not require filesystem access to the connected development environment.

### Custom OpenTelemetry agents

Connect framework-independent agents through stable OpenTelemetry service identity and Tracey’s documented run contract.

The agent stays in its own repository and deployment. Tracey does not vendor or execute its source code.

### MCP

Expose Tracey’s bounded investigation capabilities over authenticated MCP, or connect an external MCP server through an explicit read-tool allowlist.

### Platform roadmap

AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub are future typed adapters. They should not be presented as available until each integration has real permissions, policy, verification, rollback, and production evidence.

---

## Designed around evidence, not confident guesses

Tracey separates three things that ordinary agent chat often mixes together:

1. **Observed facts** returned by connected systems
2. **Deterministic calculations** produced by Tracey
3. **Hypotheses** that still require more evidence

If a connector is unavailable, a query fails, or telemetry is incomplete, Tracey reports the limitation. It does not replace missing operational data with a plausible answer.

That evidence contract applies to investigations, remediation plans, approvals, execution, verification, and recovery.

---

## A safer boundary between AI and production

Tracey is designed so that model intelligence and infrastructure authority remain separate.

- The model selects bounded read tools and prepares plans.
- The policy engine makes deterministic authorization decisions.
- The executor uses a separate authenticated identity.
- Every mutation is typed and scope-checked.
- Every action has an idempotency key.
- Every lifecycle transition is persisted.
- Every success claim requires verification.
- Every permitted rollback requires verification of the recovered state.

Tracey does not provide:

- Arbitrary shell execution
- Kubernetes Secret access
- Namespace deletion
- Database deletion
- Direct model-to-cloud access
- Silent mutation without policy evaluation

---

## Privacy by default

Operational insight should not require sending sensitive application content to a model provider.

Tracey’s default data boundary excludes:

- Prompts and model responses
- Tool arguments and tool results
- Credentials and tokens
- Personal data
- Kubernetes Secret values
- Raw private application content

Tracey sends bounded, redacted operational summaries to the configured model provider. Raw traces, logs, and metrics remain in SigNoz. Tracey stores its own registrations, investigations, policies, notifications, action history, executor receipts, and bounded semantic summaries in PostgreSQL with pgvector.

---

## Tracey is a control plane—not another agent framework

Your agents remain independent.

```text
Codex / Claude Code / custom OpenTelemetry agents
                         |
                         v
              OpenTelemetry Collector
                         |
                         v
                      SigNoz
                         |
                         v
         Investigator -> Planner -> Policy Engine
                                           |
                              approval or permitted automation
                                           |
                                           v
                                Restricted Executor
                                           |
                                 Verify -> Recover
                                           |
                                           v
                            PostgreSQL + pgvector audit store
```

Tracey owns:

- The API
- The operator web application
- The investigation and planning layer
- The distributed worker
- The policy engine
- The restricted executor
- PostgreSQL and pgvector persistence
- The connector framework

Tracey does not own:

- Your agent source code
- Your agent deployment
- SigNoz
- Your Kubernetes cluster
- Your model provider
- Your MCP servers

This boundary keeps Tracey reusable across teams, agent frameworks, and infrastructure environments.

---

## Who Tracey is for

### AI platform teams

Operate multiple agent services with consistent telemetry, incident investigation, policy, and recovery controls.

### Site reliability engineers

Connect agent behavior with service and Kubernetes evidence without learning every agent framework’s internal event format.

### Engineering teams shipping agents

Understand failures across models, tools, dependencies, and infrastructure while keeping the agent independently deployed.

### Security and operations leaders

Introduce AI-assisted operations without granting a model unrestricted production access.

---

## Common operational questions Tracey can answer

- Which agents have failed recently?
- What evidence explains this run’s failure?
- Which tool or dependency is contributing the most latency?
- Did a deployment change precede the incident?
- Which services are affected?
- Is the Kubernetes workload healthy?
- Did error rate or latency improve after remediation?
- Was a rollback completed and verified?
- Which policy permitted this action?
- Who approved and executed the change?
- Which connectors are unhealthy or missing required permissions?

The answer is limited by the telemetry and infrastructure access connected to Tracey. Missing evidence is always surfaced.

---

## Frequently asked questions

### Does Tracey replace SigNoz?

No. SigNoz remains the telemetry backend and system of record for traces, logs, and metrics. Tracey adds agent semantics, investigation, policy, controlled execution, verification, recovery, and the operator experience above it.

### Does Tracey run my agents?

No. Connected agents remain in their own repositories and deployments. They export OpenTelemetry data and register their service identity with Tracey.

### Which agents can Tracey observe?

Tracey currently supports Codex Desktop, Codex CLI, Claude Code, and custom agents that emit OpenTelemetry using the documented run contract.

### Can Tracey control production infrastructure?

Tracey can investigate Kubernetes and execute approved, typed Kubernetes actions through a restricted executor. Infrastructure scope and allowed actions are controlled by deterministic policies and dedicated identities.

### Can the model directly run cloud commands?

No. The model can select bounded investigation tools and prepare remediation plans. It cannot directly call the infrastructure adapter, access a shell, or bypass the policy engine.

### What happens before a change is executed?

Tracey validates the plan, evaluates policy, calculates risk and blast radius, checks authorization, captures pre-action evidence, and requests approval when required.

### How does Tracey know a remediation worked?

It checks Kubernetes readiness and compares post-action SigNoz health against the configured baseline. API acceptance alone is not treated as recovery.

### Does Tracey send prompts or application content to the model provider?

Not by default. OpenRouter-bound tool results are reduced to privacy-safe operational evidence. Raw prompts, responses, credentials, tool payloads, and personal data are excluded.

### Can Tracey work without an LLM provider?

Deterministic telemetry queries and stored diagnoses do not require a model-provider key. Agentic chat, natural-language tool selection, trigger-driven reasoning, and remediation planning require an OpenRouter-compatible provider.

### Is Tracey a hosted SaaS?

The current product is deployable into an organization-controlled environment. Teams provide their SigNoz workspace, PostgreSQL, Kubernetes identities, ingress, TLS, secret management, and optional identity provider.

### Does Tracey support AWS, GCP, Azure, Terraform, or GitHub today?

Not as production execution adapters yet. They are part of the platform direction and should remain labeled as upcoming until genuine integrations and verification exist.

---

## Bring production agents into one reliability workflow

Connect your observability backend. Register your agents. Ask Tracey what failed. Move from evidence to an approved change—and from execution to verified recovery—without giving a model unrestricted production access.

**Primary action:** Get started with Tracey

**Secondary action:** Review the architecture

---

## Website implementation notes

These notes guide the website built from this document and are not intended as public page copy.

### Recommended navigation

- Product
- How it works
- Integrations
- Safety
- Architecture
- FAQ
- Get started

### Recommended page hierarchy

1. Hero with one strong product screenshot
2. Problem statement
3. Core Observe → Investigate → Act → Verify capabilities
4. Product workflow
5. Investigation workspace screenshot
6. Change approval and verification screenshot
7. Connector catalog
8. Autonomy modes
9. Safety and privacy
10. Architecture
11. FAQ
12. Final call to action

### Recommended screenshots

- Agent fleet and agent detail
- Chat-centric investigation workspace
- Evidence panel attached to an answer
- Change preview with risk, policy, and approval state
- Execution timeline with verification or rollback
- Connector catalog and connection health

Use genuine product screenshots. Do not insert fabricated metrics, customer logos, testimonials, incident counts, or performance claims.

### Tone

- Calm and operational
- Technical but understandable
- Evidence-first
- Confident without overclaiming
- Focused on production reliability rather than generic “AI magic”

### Visual direction

- Editorial, product-led layout
- Warm neutral background with dark ink typography
- Restrained indigo accent
- Clear evidence, risk, approval, and recovery states
- Large product screenshots with minimal decorative effects
- Avoid excessive gradients, glowing cards, floating icons, and generic AI imagery

### Claim boundary

Advertise SigNoz and Kubernetes as the implemented production adapters. Present Codex, Claude Code, generic OpenTelemetry, and MCP as supported telemetry or tool connectors. Keep AWS, GCP, Azure, Argo CD, Helm, Terraform, and GitHub clearly marked as roadmap items until their real adapters are implemented and verified.
