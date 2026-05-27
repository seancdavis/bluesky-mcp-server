import type { Config, Context } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { dispatch } from "../lib/mcp/dispatch";
import { ERROR_CODES, error } from "../lib/mcp/protocol";

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
    return Response.json(error(null, ERROR_CODES.PARSE_ERROR, "Parse error"));
  }

  const response = await dispatch(body);
  if (response === null) {
    return new Response(null, { status: 204 });
  }
  return Response.json(response);
};

export const config: Config = {
  path: "/mcp",
};
