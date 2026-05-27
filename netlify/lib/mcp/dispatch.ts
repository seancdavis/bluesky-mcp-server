import {
  ERROR_CODES,
  error,
  isNotification,
  isRequest,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol";
import { tools, toolsByName, type ToolResult } from "./tools";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "bluesky-mcp-server", version: "0.1.0" };

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function callTool(params: unknown): Promise<ToolResult> {
  if (!params || typeof params !== "object") {
    return toolError("Error: Invalid tool call params");
  }
  const { name, arguments: args } = params as {
    name?: string;
    arguments?: unknown;
  };
  if (typeof name !== "string") {
    return toolError("Error: Missing tool name");
  }
  const tool = toolsByName.get(name);
  if (!tool) {
    return toolError(`Error: Unknown tool: ${name}`);
  }
  const callArgs =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  try {
    return await tool.handler(callArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Error: ${message}`);
  }
}

export async function dispatch(msg: unknown): Promise<JsonRpcResponse | null> {
  if (!isRequest(msg)) {
    return error(null, ERROR_CODES.INVALID_REQUEST, "Invalid request");
  }

  const req = msg as JsonRpcRequest;
  const id = req.id ?? null;

  if (isNotification(req)) return null;

  try {
    switch (req.method) {
      case "initialize":
        return success(id, {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });

      case "tools/list":
        return success(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call":
        return success(id, await callTool(req.params));

      case "ping":
        return success(id, {});

      default:
        return error(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[MCP] dispatch error:", err);
    return error(id, ERROR_CODES.INTERNAL_ERROR, message);
  }
}
