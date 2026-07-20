import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { InvestigationService } from "@tracey/investigation";
import { createTraceyMcpServer } from "@tracey/mcp-server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerTokenMatches } from "./auth.js";

export interface TraceyMcpHttpEndpoint {
  handle(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  close(): Promise<void>;
}

export function createTraceyMcpHttpEndpoint(options: {
  investigations: InvestigationService;
  bearerToken: string;
  allowedHosts: ReadonlySet<string>;
}): TraceyMcpHttpEndpoint {
  const activeServers = new Set<ReturnType<typeof createTraceyMcpServer>>();

  return {
    async handle(request, reply) {
      if (!options.allowedHosts.has(request.hostname.toLowerCase())) {
        return reply.code(421).send({ error: "Host is not allowed for the Tracey MCP endpoint" });
      }
      if (!bearerTokenMatches(request.headers.authorization, options.bearerToken)) {
        reply.header("www-authenticate", 'Bearer realm="tracey-mcp"');
        return reply.code(401).send({ error: "Valid bearer authentication is required" });
      }
      if (request.method !== "POST") {
        reply.header("allow", "POST");
        return reply.code(405).send({ error: "This stateless JSON MCP endpoint accepts POST requests only" });
      }

      const mcpServer = createTraceyMcpServer(options.investigations);
      const transport = new WebStandardStreamableHTTPServerTransport(
        {
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        } as unknown as WebStandardStreamableHTTPServerTransportOptions,
      );
      activeServers.add(mcpServer);
      try {
        // Stateless MCP requires an isolated server/transport pair per request.
        await mcpServer.connect(transport as Transport);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const webRequest = new Request(
          `${request.protocol}://${request.headers.host ?? request.hostname}${request.url}`,
          {
            method: request.method,
            headers,
            body: JSON.stringify(request.body),
          },
        );
        const response = await transport.handleRequest(webRequest, { parsedBody: request.body });
        reply.code(response.status);
        response.headers.forEach((value, name) => reply.header(name, value));
        const body = Buffer.from(await response.arrayBuffer());
        return reply.send(body.length === 0 ? undefined : body);
      } catch (error) {
        request.log.error({ err: error }, "Tracey MCP transport failed");
        return reply.code(500).send({ error: "Tracey MCP transport failed" });
      } finally {
        await mcpServer.close();
        activeServers.delete(mcpServer);
      }
    },
    async close() {
      await Promise.all([...activeServers].map((server) => server.close()));
      activeServers.clear();
    },
  };
}
