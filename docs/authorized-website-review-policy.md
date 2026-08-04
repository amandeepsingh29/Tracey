# Authorized website review policy

Tracey's website review is available only after the operator proves control of
the exact HTTPS origin with a one-time file token. Verification authorizes the
current bounded review; it is not permission to test related domains,
subdomains, IP addresses, third-party services, or authenticated user areas.

## Current permitted scope

- One `GET` request to the verified origin, plus same-origin redirects.
- No active payloads, form submissions, authentication attempts, crawling,
  brute force, fuzzing, mutation, or exploit validation.
- A 10-second request timeout and 512 KiB response limit.
- Private, loopback, link-local, documentation, multicast, and other
  non-public network addresses are rejected before and after DNS resolution.
- At most one active scan per target. Durable workers retry transient failures
  no more than the job's recorded attempt limit.

The stored audit record includes the tenant, verified target, requesting actor,
scan and job identifiers, timestamps, terminal status, bounded scope, response
metadata, evidence hash, deterministic findings, and failure type. Credentials
and response bodies are not stored by this scanner.

## Requirements before browser-driven or active checks

Do not add browser automation, crawling, authenticated checks, attack payloads,
or exploit validation until all of the following exist and are reviewed:

1. Written authorization naming the legal owner, exact origins and paths,
   allowed techniques, excluded systems, test window, and emergency contact.
2. Per-target request, concurrency, bandwidth, and daily quotas enforced before
   dispatch, with a tenant and target kill switch.
3. Revalidation of DNS and every redirect, plus protection against rebinding
   and access to cloud metadata or private networks.
4. Tamper-evident audit events for every navigation, request, payload, tool,
   response class, model decision, cancellation, and operator approval.
5. Explicit handling rules for credentials, personal data, session state,
   screenshots, response content, retention, export, and deletion.
6. A non-destructive default profile, isolated execution environment, tested
   cancellation, and a human approval boundary for every higher-risk technique.

Until those controls are implemented, Tracey must fail closed and expose only
the current deterministic, passive review. A completed review must never be
described as proof that a website is safe or vulnerability-free.
