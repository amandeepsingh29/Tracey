import { createHash } from "node:crypto";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { instrumentToolCall, type ToolResultClass } from "@tracey/instrumentation";
import { emitOperationalLog, tracer } from "@tracey/telemetry";

export interface ObservedMcpClientConfig {
  serverUrl: string;
  serverName: string;
  bearerToken?: string;
  allowedReadTools: ReadonlySet<string>;
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxTools?: number;
  maxArgumentsBytes?: number;
  maxResultBytes?: number;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  allowed: boolean;
  denialReason?: string;
}

export interface McpToolCallResult {
  content?: unknown;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  raw: unknown;
}

export class McpToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolDeniedError";
  }
}

export class McpToolArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolArgumentsError";
  }
}

export class McpToolResultSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolResultSizeError";
  }
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new McpToolArgumentsError(
      `MCP value must be JSON serializable: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
}

export function validateToolArguments(value: Record<string, unknown>, maxBytes: number): void {
  const size = jsonBytes(value);
  if (size > maxBytes) {
    throw new McpToolArgumentsError(`MCP tool arguments exceed the ${maxBytes}-byte limit`);
  }
}

export function toolDenialReason(tool: ListedTool, allowedReadTools: ReadonlySet<string>): string | undefined {
  if (!allowedReadTools.has(tool.name)) return "Tool is not present in MCP_ALLOWED_READ_TOOLS";
  if (tool.annotations?.destructiveHint === true) return "Server marks this tool as destructive";
  if (tool.annotations?.readOnlyHint === false) return "Server explicitly marks this tool as non-read-only";
  if (tool.execution?.taskSupport === "required") return "Task-based MCP tools are not supported by the read-only MVP";
  return undefined;
}

function descriptor(tool: ListedTool, allowedReadTools: ReadonlySet<string>): McpToolDescriptor {
  const denialReason = toolDenialReason(tool, allowedReadTools);
  const annotations = tool.annotations
    ? {
        ...(tool.annotations.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
        ...(tool.annotations.destructiveHint === undefined
          ? {}
          : { destructiveHint: tool.annotations.destructiveHint }),
        ...(tool.annotations.idempotentHint === undefined ? {} : { idempotentHint: tool.annotations.idempotentHint }),
        ...(tool.annotations.openWorldHint === undefined ? {} : { openWorldHint: tool.annotations.openWorldHint }),
      }
    : undefined;
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    allowed: denialReason === undefined,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
    ...(denialReason ? { denialReason } : {}),
  };
}

function classifyMcpError(error: unknown): Exclude<ToolResultClass, "success"> {
  if (error instanceof McpToolDeniedError) return "denied";
  if (error instanceof McpToolArgumentsError) return "invalid";
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) return "timeout";
  return "upstream_error";
}

export class ObservedMcpClient {
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private connecting: Promise<void> | undefined;
  private cachedTools: { expiresAt: number; tools: ListedTool[] } | undefined;

  constructor(private readonly config: ObservedMcpClientConfig) {
    new URL(config.serverUrl);
    if (config.allowedReadTools.size > 500) throw new Error("MCP read-tool allowlist cannot exceed 500 entries");
  }

  private get connectTimeoutMs(): number {
    return this.config.connectTimeoutMs ?? 10_000;
  }

  private get toolTimeoutMs(): number {
    return this.config.toolTimeoutMs ?? 15_000;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    this.connecting ??= this.openConnection();
    try {
      await this.connecting;
    } catch (error) {
      this.client = undefined;
      this.transport = undefined;
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    const client = new Client({ name: "tracey", version: "0.1.0" });
    client.onerror = (error) => {
      emitOperationalLog("ERROR", "MCP transport error", {
        "tracey.mcp.server.name": this.config.serverName,
        "error.type": error.name,
      });
    };
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.transport = undefined;
        this.cachedTools = undefined;
      }
    };

    const headers = this.config.bearerToken
      ? { authorization: `Bearer ${this.config.bearerToken}` }
      : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.serverUrl), {
      ...(headers ? { requestInit: { headers } } : {}),
      reconnectionOptions: {
        maxReconnectionDelay: 1_000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 0,
      },
    });
    // SDK 1.x publishes Transport.sessionId as optional while exact optional
    // properties are enabled here; it remains the same runtime transport contract.
    await client.connect(transport as Transport, {
      timeout: this.connectTimeoutMs,
      maxTotalTimeout: this.connectTimeoutMs,
    });
    this.client = client;
    this.transport = transport;
  }

  private async discoverTools(): Promise<ListedTool[]> {
    await this.ensureConnected();
    if (this.cachedTools && this.cachedTools.expiresAt > Date.now()) return this.cachedTools.tools;
    const client = this.client;
    if (!client) throw new Error("MCP client disconnected during tool discovery");

    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await tracer.startActiveSpan(
        "mcp.tools.list",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "tracey.mcp.server.name": this.config.serverName,
            "tracey.tool.transport": "mcp",
          },
        },
        async (span) => {
          try {
            const value = await client.listTools(
              cursor ? { cursor } : undefined,
              { timeout: this.connectTimeoutMs, maxTotalTimeout: this.connectTimeoutMs },
            );
            span.setStatus({ code: SpanStatusCode.OK });
            return value;
          } catch (error) {
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
      tools.push(...response.tools);
      cursor = response.nextCursor;
      pages += 1;
      if (pages > 50 || tools.length > (this.config.maxTools ?? 500)) {
        throw new Error("MCP tool discovery exceeded configured bounds");
      }
    } while (cursor);

    const serializedBytes = jsonBytes(tools);
    if (serializedBytes > 1_048_576) throw new Error("MCP tool schemas exceed the 1 MiB discovery limit");
    this.cachedTools = { expiresAt: Date.now() + 60_000, tools };
    return tools;
  }

  async listTools(): Promise<{ server: { name: string; version?: string }; tools: McpToolDescriptor[] }> {
    const tools = await this.discoverTools();
    const version = this.client?.getServerVersion();
    return {
      server: {
        name: this.config.serverName,
        ...(version?.version ? { version: version.version } : {}),
      },
      tools: tools.map((tool) => descriptor(tool, this.config.allowedReadTools)),
    };
  }

  async callReadTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const tools = await this.discoverTools();
    const tool = tools.find((candidate) => candidate.name === name);
    const serverVersion = this.client?.getServerVersion()?.version;
    const schemaVersion = tool
      ? `sha256:${createHash("sha256").update(JSON.stringify(tool.inputSchema)).digest("hex")}`
      : undefined;

    return instrumentToolCall<McpToolCallResult>(
      {
        toolName: name,
        ...(schemaVersion ? { schemaVersion } : {}),
        transport: "mcp",
        mcpServerName: this.config.serverName,
        ...(serverVersion ? { mcpServerVersion: serverVersion } : {}),
        sideEffect: "read",
        timeoutMs: this.toolTimeoutMs,
        classifyResult: (result) => (result.isError ? "upstream_error" : "success"),
        classifyError: classifyMcpError,
      },
      async (): Promise<McpToolCallResult> => {
        if (!tool) throw new McpToolDeniedError("MCP server did not advertise the requested tool");
        const denialReason = toolDenialReason(tool, this.config.allowedReadTools);
        if (denialReason) throw new McpToolDeniedError(denialReason);
        validateToolArguments(args, this.config.maxArgumentsBytes ?? 65_536);
        const client = this.client;
        if (!client) throw new Error("MCP client disconnected before tool execution");

        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: this.toolTimeoutMs, maxTotalTimeout: this.toolTimeoutMs },
        );
        const resultBytes = jsonBytes(result);
        if (resultBytes > (this.config.maxResultBytes ?? 1_048_576)) {
          throw new McpToolResultSizeError("MCP tool result exceeds the configured response limit");
        }
        if ("toolResult" in result) return { raw: result };
        return {
          raw: result,
          content: result.content,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result.isError === undefined ? {} : { isError: result.isError }),
        };
      },
    );
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.cachedTools = undefined;
    if (transport) {
      try {
        await transport.terminateSession();
      } catch {
        // Servers may legitimately return 405 when session termination is unsupported.
      }
    }
    await client?.close();
  }
}
