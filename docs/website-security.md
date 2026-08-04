# Authorized website security

Tracey's Website security workspace provides a conservative first review for a
website the operator controls. It is deliberately narrower than a penetration
test and does not authorize testing unrelated domains, third-party services, or
infrastructure discovered from a page.

## User flow

1. Open `/security` and submit an HTTPS URL.
2. Publish the one-time token at
   `/.well-known/tracey-verification.txt` on that exact origin.
3. Ask Tracey to verify the file. Tracey stores only a SHA-256 hash of the
   token; the plaintext is shown once.
4. Queue a review. PostgreSQL records a durable job and any worker may lease it.
5. Inspect findings, response metadata, the content hash, and remediation in
   the UI.

Re-submitting an unverified origin rotates its token. A verified origin does not
issue another token.

## Enforced boundary

- HTTPS only.
- The hostname is resolved by the scanner and private, loopback, link-local,
  reserved, documentation, multicast, and IPv4-mapped private addresses are
  rejected.
- Redirects must retain the verified origin and stop after three hops.
- Only GET is used. No forms, credentials, cookies, login flows, or attack
  payloads are sent.
- The response is limited to 512 KiB and each request has a ten-second timeout.
- The worker retries transient failures through leased PostgreSQL jobs and moves
  exhausted work to the dead-letter state.

The current checks cover HTTPS transport metadata, HSTS, CSP, MIME sniffing,
frame protection, referrer policy, CORS, cookie flags, implementation headers,
and insecure HTTP page references. Findings cite the relevant OWASP Web
Security Testing Guide family and include the exact bounded observation and a
remediation.

## Operational requirements

The API and worker both require `DATABASE_URL`. The worker must have outbound
DNS and HTTPS access to verified public websites. Apply migrations before
starting either service so `website_targets`, `website_scans`, and
`durable_jobs` exist. Administrators add and verify targets; operators can queue
reviews; authenticated viewers can read results.

The scanner never reports “safe.” Zero findings means only that the listed
bounded checks produced no result for that response.
