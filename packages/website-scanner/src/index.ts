import { createHash, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 512 * 1_024;
const TargetUrlSchema = z.string().url().transform((value) => new URL(value));
const VerificationTokenSchema = z.string().regex(/^tracey-verify-[A-Za-z0-9_-]{32,128}$/);

export type FindingSeverity = "info" | "low" | "medium" | "high";
export interface WebsiteFinding {
  findingId: string;
  title: string;
  severity: FindingSeverity;
  category: "transport" | "headers" | "cookies" | "cors" | "content" | "information_exposure";
  evidence: string;
  remediation: string;
  standard: string;
}

export interface WebsiteScanResult {
  origin: string;
  scannedAt: string;
  statusCode: number;
  finalUrl: string;
  contentType?: string;
  responseBytes: number;
  bodySha256: string;
  tls?: { protocol?: string; validTo?: string; issuer?: string };
  findings: WebsiteFinding[];
  summary: Record<FindingSeverity, number>;
  scope: { requestsMade: number; methods: ["GET"]; activePayloads: false; sameOriginOnly: true };
}

export interface WebsiteScannerOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowHttpForTests?: boolean;
  resolve?: typeof dnsLookup;
}

interface SafeResponse {
  url: URL;
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  tls?: WebsiteScanResult["tls"];
  requestsMade: number;
}

function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

export function isPublicNetworkAddress(address: string): boolean {
  const ipv4 = ipv4Octets(address);
  if (ipv4) {
    const [a = 0, b = 0, c = 0] = ipv4;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || a >= 224
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicNetworkAddress(normalized.slice(7));
  return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8"));
}

export function normalizeWebsiteOrigin(input: string, allowHttpForTests = false): URL {
  const parsed = TargetUrlSchema.parse(input);
  if (parsed.username || parsed.password) throw new Error("Website URL must not contain credentials");
  if (parsed.protocol !== "https:" && !(allowHttpForTests && parsed.protocol === "http:")) {
    throw new Error("Website scanning requires an HTTPS origin");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name.toLowerCase()] = value;
  }
  return result;
}

function header(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function finding(input: Omit<WebsiteFinding, "findingId">): WebsiteFinding {
  return { findingId: createHash("sha256").update(`${input.category}:${input.title}`).digest("hex").slice(0, 16), ...input };
}

export class WebsiteScanner {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly allowHttpForTests: boolean;
  private readonly resolve: typeof dnsLookup;

  constructor(options: WebsiteScannerOptions = {}) {
    this.timeoutMs = z.number().int().min(1_000).max(30_000).parse(options.timeoutMs ?? 10_000);
    this.maxResponseBytes = z.number().int().min(1_024).max(MAX_RESPONSE_BYTES).parse(options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
    this.allowHttpForTests = options.allowHttpForTests ?? false;
    this.resolve = options.resolve ?? dnsLookup;
  }

  async verifyOwnership(originInput: string, tokenInput: string): Promise<void> {
    const origin = normalizeWebsiteOrigin(originInput, this.allowHttpForTests);
    const token = VerificationTokenSchema.parse(tokenInput);
    const verificationUrl = new URL("/.well-known/tracey-verification.txt", origin);
    const response = await this.get(verificationUrl, origin.origin);
    if (response.statusCode !== 200) throw new Error(`Ownership verification returned HTTP ${response.statusCode}`);
    const actual = Buffer.from(response.body.toString("utf8").trim());
    const expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Ownership verification content does not match the issued token");
    }
  }

  async scan(originInput: string): Promise<WebsiteScanResult> {
    const origin = normalizeWebsiteOrigin(originInput, this.allowHttpForTests);
    const response = await this.get(origin, origin.origin, {
      origin: "https://tracey-security-scan.invalid",
      "user-agent": "Tracey-Authorized-Security-Scanner/1.0",
    });
    const findings = this.inspectResponse(response);
    const contentType = header(response.headers, "content-type");
    const summary: Record<FindingSeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
    for (const item of findings) summary[item.severity] += 1;
    return {
      origin: origin.origin,
      scannedAt: new Date().toISOString(),
      statusCode: response.statusCode,
      finalUrl: response.url.toString(),
      ...(contentType ? { contentType } : {}),
      responseBytes: response.body.byteLength,
      bodySha256: createHash("sha256").update(response.body).digest("hex"),
      ...(response.tls ? { tls: response.tls } : {}),
      findings,
      summary,
      scope: { requestsMade: response.requestsMade, methods: ["GET"], activePayloads: false, sameOriginOnly: true },
    };
  }

  inspectResponse(response: Pick<SafeResponse, "headers" | "body">): WebsiteFinding[] {
    const findings: WebsiteFinding[] = [];
    const hsts = header(response.headers, "strict-transport-security");
    if (!hsts) findings.push(finding({ title: "HSTS is not enabled", severity: "medium", category: "transport", evidence: "The HTTPS response has no Strict-Transport-Security header.", remediation: "Set Strict-Transport-Security with an appropriate max-age after confirming every subdomain supports HTTPS.", standard: "OWASP WSTG-CONF-07" }));
    const csp = header(response.headers, "content-security-policy");
    if (!csp) findings.push(finding({ title: "Content Security Policy is missing", severity: "medium", category: "headers", evidence: "The response has no Content-Security-Policy header.", remediation: "Deploy a restrictive CSP header and roll it out with reporting before enforcement.", standard: "OWASP WSTG-CONF-12" }));
    else if (/unsafe-(inline|eval)/i.test(csp)) findings.push(finding({ title: "Content Security Policy allows unsafe script execution", severity: "low", category: "headers", evidence: "The CSP contains unsafe-inline or unsafe-eval.", remediation: "Replace unsafe script directives with nonces or hashes and remove unsafe-eval dependencies.", standard: "OWASP WSTG-CONF-12" }));
    if (!header(response.headers, "x-content-type-options")?.toLowerCase().includes("nosniff")) findings.push(finding({ title: "MIME sniffing protection is missing", severity: "low", category: "headers", evidence: "X-Content-Type-Options: nosniff was not observed.", remediation: "Return X-Content-Type-Options: nosniff on application responses.", standard: "OWASP WSTG-CONF-14" }));
    if (!header(response.headers, "x-frame-options") && !csp?.toLowerCase().includes("frame-ancestors")) findings.push(finding({ title: "Clickjacking protection is missing", severity: "medium", category: "headers", evidence: "Neither X-Frame-Options nor CSP frame-ancestors was observed.", remediation: "Set CSP frame-ancestors to the exact origins allowed to frame the application.", standard: "OWASP WSTG-CLNT-09" }));
    if (!header(response.headers, "referrer-policy")) findings.push(finding({ title: "Referrer policy is not explicit", severity: "low", category: "headers", evidence: "The response has no Referrer-Policy header.", remediation: "Set a policy such as strict-origin-when-cross-origin based on application requirements.", standard: "OWASP WSTG-CONF-14" }));
    const cors = header(response.headers, "access-control-allow-origin");
    const credentials = header(response.headers, "access-control-allow-credentials")?.toLowerCase() === "true";
    if (cors === "*" && credentials) findings.push(finding({ title: "Credentialed wildcard CORS policy", severity: "high", category: "cors", evidence: "The response combines Access-Control-Allow-Origin: * with credentials enabled.", remediation: "Return a validated explicit origin and never combine credentialed requests with a wildcard origin.", standard: "OWASP WSTG-CLNT-07" }));
    else if (cors === "*") findings.push(finding({ title: "Wildcard CORS policy", severity: "low", category: "cors", evidence: "Access-Control-Allow-Origin permits every origin.", remediation: "Restrict cross-origin access when responses are not intentionally public.", standard: "OWASP WSTG-CLNT-07" }));
    const cookies = response.headers["set-cookie"];
    for (const cookie of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
      const name = cookie.split("=", 1)[0] || "cookie";
      if (!/;\s*secure(?:;|$)/i.test(cookie)) findings.push(finding({ title: `Cookie ${name} is missing Secure`, severity: "medium", category: "cookies", evidence: `A Set-Cookie header for ${name} did not include Secure.`, remediation: "Mark session and sensitive cookies Secure.", standard: "OWASP WSTG-SESS-02" }));
      if (!/;\s*httponly(?:;|$)/i.test(cookie)) findings.push(finding({ title: `Cookie ${name} is accessible to scripts`, severity: "medium", category: "cookies", evidence: `A Set-Cookie header for ${name} did not include HttpOnly.`, remediation: "Mark cookies HttpOnly unless client-side JavaScript must read them.", standard: "OWASP WSTG-SESS-02" }));
      if (!/;\s*samesite=/i.test(cookie)) findings.push(finding({ title: `Cookie ${name} has no SameSite policy`, severity: "low", category: "cookies", evidence: `A Set-Cookie header for ${name} did not include SameSite.`, remediation: "Set SameSite=Lax or Strict unless a documented cross-site flow requires None.", standard: "OWASP WSTG-SESS-02" }));
    }
    for (const exposed of ["server", "x-powered-by"]) {
      const value = header(response.headers, exposed);
      if (value) findings.push(finding({ title: `${exposed} exposes implementation details`, severity: "info", category: "information_exposure", evidence: `${exposed} is present in the response.`, remediation: `Remove or generalize the ${exposed} response header.`, standard: "OWASP WSTG-INFO-08" }));
    }
    const html = response.body.toString("utf8");
    if (/\b(?:action|src|href)\s*=\s*["']http:\/\//i.test(html)) findings.push(finding({ title: "HTTPS page references insecure HTTP content", severity: "medium", category: "content", evidence: "The bounded HTML response contains an absolute http:// action or resource URL.", remediation: "Serve every active resource and form target over HTTPS.", standard: "OWASP WSTG-CRYP-03" }));
    return findings.sort((left, right) => ["high", "medium", "low", "info"].indexOf(left.severity) - ["high", "medium", "low", "info"].indexOf(right.severity));
  }

  private async get(url: URL, requiredOrigin: string, headers: Record<string, string> = {}, redirects = 0): Promise<SafeResponse> {
    if (url.origin !== requiredOrigin) throw new Error("Website scanner refuses cross-origin redirects");
    normalizeWebsiteOrigin(url.origin, this.allowHttpForTests);
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const response = await new Promise<SafeResponse>((resolvePromise, reject) => {
      const request = requester(url, {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", ...headers },
        timeout: this.timeoutMs,
        lookup: (hostname, _options, callback) => {
          this.resolve(hostname, { family: 0, all: false, verbatim: true }, (error, address, family) => {
            if (error) { callback(error, "", 0); return; }
            if (typeof address !== "string" || !isPublicNetworkAddress(address)) {
              callback(new Error("Website resolves to a private or reserved network address"), "", 0);
              return;
            }
            callback(null, address, typeof family === "number" ? family : 0);
          });
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > this.maxResponseBytes) {
            request.destroy(new Error("Website response exceeds the scanner size limit"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const socket = incoming.socket as TLSSocket;
          const certificate = url.protocol === "https:" ? socket.getPeerCertificate?.() : undefined;
          resolvePromise({
            url,
            statusCode: incoming.statusCode ?? 0,
            headers: normalizeHeaders(incoming.headers),
            body: Buffer.concat(chunks),
            ...(url.protocol === "https:" ? { tls: {
              ...(socket.getProtocol?.() ? { protocol: socket.getProtocol()! } : {}),
              ...(certificate?.valid_to ? { validTo: certificate.valid_to } : {}),
              ...(certificate?.issuer?.O ? { issuer: Array.isArray(certificate.issuer.O) ? certificate.issuer.O.join(", ") : certificate.issuer.O } : {}),
            } } : {}),
            requestsMade: 1,
          });
        });
      });
      request.once("timeout", () => request.destroy(new Error("Website request timed out")));
      request.once("error", reject);
      request.end();
    });
    const location = header(response.headers, "location");
    if (location && [301, 302, 303, 307, 308].includes(response.statusCode)) {
      if (redirects >= 3) throw new Error("Website exceeded the redirect limit");
      const redirected = await this.get(new URL(location, url), requiredOrigin, headers, redirects + 1);
      return { ...redirected, requestsMade: response.requestsMade + redirected.requestsMade };
    }
    return response;
  }
}
