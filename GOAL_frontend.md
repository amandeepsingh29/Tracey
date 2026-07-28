# Goal: Production-Ready Tracey UI/UX

Transform Tracey from an operational prototype into a clear, reliable product that users can onboard, understand, investigate incidents with, approve changes through, and operate without editing configuration files manually.

## Progress snapshot

Last updated: 2026-07-22

- Production Next.js App Router frontend builds successfully.
- Overview, onboarding, agents, runs, incidents, investigations, changes, connectors, policies, notifications, and settings routes exist and use Tracey APIs through a server-side credential proxy.
- Durable incident timelines and expanded in-product notification operations have been added to the API and PostgreSQL schema.
- UI-managed connector setup now tests access, stores credentials with authenticated encryption, activates SigNoz/Kubernetes runtime adapters, and supports reconfigure, disable, and delete without returning secrets to the browser.
- Automated verification passes across the complete workspace: production build, all package type checks and tests, 32 API tests, and 7 frontend state/accessibility/draft tests.
- Live product verification passes against PostgreSQL, SigNoz, OpenRouter, and a real local Kubernetes cluster: 12 product routes, connector permissions, registered-agent discovery, observed run details, an evidence-bound investigation with 16 durable references, a preserved follow-up, and rejection of unapproved execution.
- Responsive browser verification passes at 390px mobile and 1440px desktop without horizontal overflow.

## 1. Product foundation

- [x] Define primary user: engineer operating production AI agents.
- [x] Establish the core journey: Connect -> Observe -> Investigate -> Remediate -> Verify.
- [x] Define consistent terminology for agents, runs, incidents, investigations, changes, and connectors.
- [x] Create a unified design system for colors, typography, spacing, buttons, forms, tables, alerts, and status badges.
- [x] Make desktop layouts responsive for smaller screens.
- [x] Replace Streamlit with a production web frontend.
- [x] Preserve the existing Tracey API rather than duplicating backend logic in the frontend.

## 2. Application navigation

- [x] Create persistent sidebar navigation.
- [x] Add these primary pages:
  - [x] Overview
  - [x] Agents
  - [x] Incidents
  - [x] Investigations
  - [x] Changes
  - [x] Connectors
  - [x] Policies
  - [x] Notifications
  - [x] Settings
- [x] Add a global "Ask Tracey" entry point.
- [x] Add breadcrumbs on detail pages.
- [x] Preserve page and filter state during navigation.
- [x] Add global search for agents, runs, incidents, and changes.

## 3. First-time onboarding

- [x] Detect when Tracey has not been configured.
- [x] Show a concise product explanation.
- [x] Provide a guided onboarding checklist.
- [x] Guide users through:
  - [x] Connect observability backend
  - [x] Connect Kubernetes
  - [x] Discover or register an agent
  - [x] Validate telemetry
  - [x] Run the first investigation
- [x] Show onboarding progress.
- [x] Allow users to leave and resume onboarding.
- [x] Provide Test Connection actions.
- [x] Show actionable fixes for connection failures.
- [x] Avoid requiring manual environment-file editing for normal connector setup.
- [x] Store connector configuration securely.

## 4. Connector experience

- [x] Build a connector catalog.
- [x] Show available, connected, unhealthy, and upcoming connectors.
- [x] Create dedicated setup flows for:
  - [x] SigNoz
  - [x] Kubernetes
  - [x] Codex
  - [x] Claude Code
  - [x] Generic OpenTelemetry
  - [x] MCP
- [x] Explain what each connector enables.
- [x] Display required permissions before connection.
- [x] Test credentials and endpoint connectivity.
- [x] Validate actual permissions, not only network connectivity.
- [x] Show last successful check and latest error.
- [x] Support reconnect, reconfigure, disable, and delete.
- [x] Never display stored credential values.
- [x] Add connector health to the Overview page.

## 5. Overview dashboard

- [x] Show connected-agent count.
- [x] Show active incidents.
- [x] Show failed runs and failure-rate change.
- [x] Show pending approvals.
- [x] Show recent successful and failed changes.
- [x] Show recent recoveries and rollbacks.
- [x] Show connector and telemetry health.
- [x] Show latency, token, and cost trends.
- [x] Add configurable environment and time-range filters.
- [x] Make every dashboard card link to supporting details.
- [x] Avoid placeholder or fabricated metrics.
- [x] Provide useful empty states when no data exists.

## 6. Agent management

- [x] Create an agent directory.
- [x] Support search and filters by environment, status, producer, and service.
- [x] Create an agent detail page showing:
  - [x] Current health
  - [x] Run volume
  - [x] Success and failure rates
  - [x] P50/P95 latency
  - [x] Token usage
  - [x] Estimated cost
  - [x] Models used
  - [x] Tool-call performance
  - [x] Recent failed runs
  - [x] Related incidents
  - [x] Deployment information
  - [x] Telemetry completeness
- [x] Allow investigation creation from an agent page.
- [x] Clearly identify missing or incomplete telemetry.

## 7. Runs and traces

- [x] Create a searchable run explorer.
- [x] Support filters for agent, environment, status, model, tool, and time range.
- [x] Create an individual run detail page.
- [x] Visualize the run graph and critical path.
- [x] Show model calls, decisions, retrieval, tools, and infrastructure spans.
- [x] Show failure location and error classification.
- [x] Distinguish observed values from inferred conclusions.
- [x] Link runs to SigNoz without forcing users to inspect SigNoz first.
- [x] Show complete local prompts, responses, tool inputs, outputs, commands, and raw events in the execution detail page.
- [x] Add an explicit local forensic reveal flow for credential and authentication material without exporting it to SigNoz or the investigation model.

## 8. Incident management

- [x] Create an incident inbox.
- [x] Support open, investigating, monitoring, resolved, and dismissed states.
- [x] Show severity, affected agents, environment, start time, and impact.
- [x] Correlate related failed runs, deployments, logs, and Kubernetes events.
- [x] Allow users to create an investigation from an incident.
- [x] Support incident ownership and notes.
- [x] Link incidents to proposed and executed changes.
- [x] Preserve a complete incident timeline.

## 9. Investigation workspace

- [x] Build a unified investigation page.
- [x] Show an executive summary first.
- [x] Show affected agents, services, users, and environments.
- [x] Present an ordered incident timeline.
- [x] Display agent and infrastructure evidence together.
- [x] Separate:
  - [x] Observed facts
  - [x] Tracey's hypotheses
  - [x] Missing evidence
  - [x] Recommendations
- [x] Attach evidence references to every technical claim.
- [x] Embed contextual Tracey chat.
- [x] Let users ask follow-up questions without losing investigation state.
- [x] Show tool calls and grounding status in an understandable format.
- [x] Allow remediation proposals to be created from findings.
- [x] Support sharing or exporting an investigation report.

## 10. Change preview and approval

- [x] Create a Changes inbox.
- [x] Clearly separate pending, approved, executing, succeeded, failed, and reverted changes.
- [x] Show the exact target cluster, namespace, kind, and resource.
- [x] Show immutable action parameters.
- [x] Generate a before-and-after diff.
- [x] Show supporting evidence and recommendation reasoning.
- [x] Show confidence, risk, and blast radius.
- [x] Show expected impact and possible downtime.
- [x] Show verification and rollback plans.
- [x] Provide:
  - [x] Approve and execute
  - [x] Reject
  - [x] Request revision
  - [x] Schedule
  - [x] Explain this change
- [x] Export for manual execution
- [x] Require reconfirmation when an approved proposal changes.
- [x] Prevent double execution through idempotency.
- [x] Display the approving user and approval time.

## 11. Execution, verification, and recovery

- [x] Show live action progress.
- [x] Display each durable lifecycle transition.
- [x] Show executor acceptance and resource response.
- [x] Show Kubernetes readiness progress.
- [x] Show pre-action and post-action health comparison.
- [x] Explain verification failures.
- [x] Show rollback recommendation or automatic recovery state.
- [x] Display recovery verification.
- [x] Provide manual recovery actions when automatic rollback is unavailable.
- [x] Ensure the final state always communicates what actually happened.

## 12. Policies and autonomy

- [x] Explain each autonomy mode in plain language.
- [x] Default new installations to approval mode.
- [x] Provide policy templates for common environments.
- [x] Show which policy applies to a proposed action.
- [x] Preview the effect of policy changes.
- [x] Explain why an action was allowed, denied, or sent for approval.
- [x] Clearly display environment, namespace, workload, risk, and action scopes.
- [x] Keep advanced controls collapsed by default.
- [x] Warn before enabling autopilot.
- [x] Preserve an immutable policy-version history.

## 13. Notifications

- [x] Make `/notifs` a full in-product operations inbox.
- [x] Categorize incidents, approvals, failures, recoveries, and connector problems.
- [x] Support unread, severity, environment, and category filters.
- [x] Link every notification to its source object.
- [x] Support mark read, mark all read, archive, and dismiss.
- [x] Provide notification preferences.
- [x] Keep external Slack/email/PagerDuty delivery optional.

## 14. UX reliability

- [x] Add loading states and progress indicators.
- [x] Add retry actions for recoverable errors.
- [x] Prevent duplicate form submissions.
- [x] Preserve unsaved form changes.
- [x] Use confirmation dialogs for destructive operations.
- [x] Provide actionable error messages.
- [x] Add proper empty states to every page.
- [x] Handle API, connector, database, and executor outages gracefully.
- [x] Prevent stale data from appearing current.
- [x] Show timestamps and last-refresh state.
- [x] Support manual and automatic refresh.
- [x] Meet essential accessibility requirements.
- [x] Add keyboard navigation and visible focus states.

## 15. Security and privacy UX

- [x] Never return connector secrets to the browser.
- [x] Redact credentials and sensitive telemetry.
- [x] Explain requested connector permissions.
- [x] Show the effective identity used by each connector.
- [x] Warn about cluster-wide permissions.
- [x] Record connector, policy, approval, and execution changes.
- [x] Prepare UI boundaries for future OIDC and multi-user RBAC.
- [x] Keep local no-login mode limited to loopback/private development use.

## 16. Testing and verification

- [x] Add frontend unit and component tests.
- [x] Add API contract tests.
- [x] Add end-to-end onboarding tests.
- [x] Test connector success and failure flows.
- [x] Test empty, loading, partial-data, and error states.
- [x] Test investigation creation and follow-up chat.
- [x] Test approval rejection and unapproved execution prevention.
- [x] Test successful execution and verification.
- [x] Test failed verification and rollback presentation.
- [x] Test responsive layouts.
- [x] Test accessibility.
- [x] Test against real Tracey APIs and live local integrations.
- [x] Do not use fabricated runtime data in production paths.

## Completion criteria

The UI/UX milestone is complete only when a new user can:

- [x] Understand Tracey without reading the repository documentation.
- [x] Connect SigNoz and Kubernetes through the product.
- [x] Register or discover an agent.
- [x] Confirm telemetry is working.
- [x] Identify a failed run.
- [x] Open and understand an evidence-backed investigation.
- [x] Review an exact remediation diff.
- [x] Approve the change.
- [x] Follow execution and verification.
- [x] Understand success, failure, or rollback.
- [x] Complete this entire workflow without editing environment files or using `kubectl`.
