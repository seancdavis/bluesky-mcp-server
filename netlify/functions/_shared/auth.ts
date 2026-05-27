import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Server misconfigured: MCP_BEARER_TOKEN is not set." },
      id: null,
    });
    return;
  }

  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing or malformed Authorization header." },
      id: null,
    });
    return;
  }

  const provided = Buffer.from(header.slice("Bearer ".length));
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Invalid bearer token." },
      id: null,
    });
    return;
  }

  next();
}
