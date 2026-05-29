import type { Config, Context } from "@netlify/functions";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { checkBearer } from "../lib/mcp/bearer";
import { buildServer } from "../lib/mcp/server";

export default async (req: Request, _context: Context) => {
  if (!checkBearer(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // Bridge the Web Request/Response into the Node req/res that the SDK's
  // StreamableHTTPServerTransport expects.
  const { req: nodeReq, res: nodeRes } = toReqRes(req);

  // Stateless: a brand-new server + transport per request, no session id.
  // enableJsonResponse makes the transport answer with a single application/json
  // body instead of opening an SSE stream — the right fit for a serverless POST.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  nodeRes.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(nodeReq, nodeRes, body);

  return toFetchResponse(nodeRes);
};

export const config: Config = {
  path: "/mcp",
};
