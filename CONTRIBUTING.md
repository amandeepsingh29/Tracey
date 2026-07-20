# Contributing to Tracey

Thank you for helping improve Tracey.

## Development setup

Tracey requires Node.js 22 or newer and pnpm 11.7.0.

```bash
git clone https://github.com/amandeepsingh29/Tracey.git
cd Tracey
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Configure `.env` with development-only credentials. Never commit `.env`, access tokens, service-account keys, exported telemetry containing private content, or Kubernetes Secret values.

Follow the local startup instructions in [README.md](README.md).

## Before submitting a change

Run the complete local verification suite:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to a live connector should also include scope-matched integration evidence. Runtime APIs must not return fixtures, fabricated operational results, or placeholder metrics.

## Pull requests

- Keep each pull request focused on one coherent change.
- Describe the user-facing outcome and important design decisions.
- Include tests for new behavior and regressions.
- Document configuration, migrations, permissions, and operational risks.
- Add screenshots for visible UI changes.
- Keep external agent applications outside this repository.
- Do not advertise a provider adapter until it has real integration and verification evidence.

## Safety expectations

Tracey deliberately separates model reasoning, policy decisions, and infrastructure execution. Contributions must preserve these boundaries:

- No arbitrary shell or pod-exec capability.
- No LLM access to cloud credentials or mutation adapters.
- No Kubernetes Secret values in investigation results.
- No mutation without deterministic policy evaluation.
- No success result without post-action verification.
- Generic Kubernetes apply, patch, and delete operations must remain confirmation-only.

Please report security concerns privately as described in [SECURITY.md](SECURITY.md).
