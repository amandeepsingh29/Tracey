import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebsiteScanner, isPublicNetworkAddress, normalizeWebsiteOrigin } from "./index.js";

describe("authorized website scanner boundaries", () => {
  it("normalizes an HTTPS link to one origin", () => {
    assert.equal(normalizeWebsiteOrigin("https://example.com/account?q=1#x").toString(), "https://example.com/");
    assert.throws(() => normalizeWebsiteOrigin("http://example.com"), /HTTPS/);
    assert.throws(() => normalizeWebsiteOrigin("https://user:pass@example.com"), /credentials/);
  });

  it("rejects private, loopback, link-local and documentation networks", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1", "2001:db8::1"]) {
      assert.equal(isPublicNetworkAddress(address), false, address);
    }
    assert.equal(isPublicNetworkAddress("192.0.2.1"), false);
    assert.equal(isPublicNetworkAddress("198.51.100.9"), false);
    assert.equal(isPublicNetworkAddress("203.0.113.9"), false);
    assert.equal(isPublicNetworkAddress("203.1.113.9"), true);
    assert.equal(isPublicNetworkAddress("198.52.100.9"), true);
    assert.equal(isPublicNetworkAddress("8.8.8.8"), true);
    assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
  });

  it("reports reproducible passive findings with evidence and remediation", () => {
    const findings = new WebsiteScanner().inspectResponse({
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "set-cookie": "session=secret; Path=/",
        "server": "example-server",
      },
      body: Buffer.from('<html><script src="http://cdn.example.test/app.js"></script></html>'),
    });
    assert.equal(findings[0]?.severity, "high");
    assert.ok(findings.some(({ title }) => title === "Credentialed wildcard CORS policy"));
    assert.ok(findings.some(({ title }) => title === "Cookie session is missing Secure"));
    assert.ok(findings.some(({ title }) => title === "HTTPS page references insecure HTTP content"));
    assert.ok(findings.every(({ findingId, evidence, remediation, standard }) => findingId.length === 16 && evidence && remediation && standard.startsWith("OWASP")));
  });

  it("returns no findings when the bounded checks are satisfied", () => {
    const findings = new WebsiteScanner().inspectResponse({
      headers: {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "set-cookie": "session=value; Secure; HttpOnly; SameSite=Lax",
      },
      body: Buffer.from("<html></html>"),
    });
    assert.deepEqual(findings, []);
  });
});
