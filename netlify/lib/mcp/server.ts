import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, toolsByName, type ToolResult } from "./tools";

const SERVER_INFO = { name: "bluesky-mcp-server", version: "0.1.0" };

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build a fresh low-level MCP Server wired to the Bluesky tool registry.
 *
 * The SDK owns the JSON-RPC framing and the initialize/ping handshake; we only
 * register the tools/list and tools/call handlers, reusing the same tool
 * definitions (and their JSON-Schema `inputSchema`s) as before.
 *
 * A new instance is created per request because the HTTP transport runs in
 * stateless mode — there is no long-lived session to share across calls.
 */
export function buildServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(
      (t): Tool => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Tool["inputSchema"],
      }),
    ),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      const tool = toolsByName.get(name);
      if (!tool) {
        return toolError(`Error: Unknown tool: ${name}`) as CallToolResult;
      }
      try {
        return (await tool.handler(args ?? {})) as CallToolResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Error: ${message}`) as CallToolResult;
      }
    },
  );

  return server;
}
