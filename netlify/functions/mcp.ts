import express from "express";
import type { Request, Response } from "express";
import serverless from "serverless-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { setupMCPServer } from "../mcp-server/index.js";
import { bearerAuth } from "./_shared/auth.js";

const app = express();
app.use(express.json());
app.use(bearerAuth);

// The SDK's StreamableHTTPServerTransport requires the request's Accept header
// to include both `application/json` and `text/event-stream`. Some clients
// (notably older `mcp-remote` builds) only send `application/json` and get a 406.
// We can only respond in JSON or SSE anyway, so normalizing this is safe.
app.use((req, _res, next) => {
  const accept = req.headers["accept"];
  if (
    typeof accept !== "string" ||
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    req.headers["accept"] = "application/json, text/event-stream";
  }
  next();
});

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = setupMCPServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless POST-only." },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless POST-only." },
    id: null,
  });
});

export const handler = serverless(app);
