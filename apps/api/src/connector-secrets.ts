import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class ConnectorSecretVault {
  private readonly key: Buffer;

  constructor(material: string) {
    if (material.length < 24) throw new Error("Connector secret encryption material must contain at least 24 characters");
    this.key = createHash("sha256").update("tracey.connector-secrets.v1\0").update(material).digest();
  }

  encrypt(secrets: Record<string, string>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("tracey.connector-config.v1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(payload: string): Record<string, string> {
    const [version, iv, tag, ciphertext] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported connector secret payload");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from("tracey.connector-config.v1"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as Record<string, string>;
  }
}
