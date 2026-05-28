import type { Config, Context } from "@netlify/functions";
import { verifyUploadToken } from "../lib/mcp/upload-tokens";
import { writeStagedUpload } from "../lib/uploads";

export default async (req: Request, context: Context) => {
  if (req.method !== "PUT") {
    return new Response("Method not allowed", { status: 405 });
  }

  const token = context.params?.token;
  if (!token) {
    return Response.json({ error: "missing_token" }, { status: 400 });
  }

  const verification = verifyUploadToken(token);
  if (!verification.ok) {
    const status = verification.reason === "expired" ? 410 : 401;
    return Response.json({ error: verification.reason }, { status });
  }

  const { payload } = verification;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType !== payload.contentType) {
    return Response.json(
      { error: "content_type_mismatch", expected: payload.contentType, got: contentType },
      { status: 400 },
    );
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) {
    return Response.json({ error: "empty_body" }, { status: 400 });
  }
  if (buf.byteLength > payload.size) {
    return Response.json(
      { error: "size_mismatch", declared: payload.size, actual: buf.byteLength },
      { status: 413 },
    );
  }

  try {
    await writeStagedUpload(payload.uploadId, new Uint8Array(buf), {
      contentType: payload.contentType,
      filename: payload.filename,
    });
    return Response.json({ uploadHandle: payload.uploadId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MCP-upload] error: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
};

export const config: Config = {
  path: "/mcp/upload/:token",
};
