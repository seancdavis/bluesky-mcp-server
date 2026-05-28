import { createHmac, timingSafeEqual } from "node:crypto";

export interface UploadTokenPayload {
  uploadId: string;
  filename: string;
  contentType: string;
  size: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.MCP_UPLOAD_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      "MCP_UPLOAD_SIGNING_SECRET is not set; upload token operations are disabled",
    );
  }
  return secret;
}

function payloadPart(payload: UploadTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function signUploadToken(payload: UploadTokenPayload): string {
  const header = payloadPart(payload);
  const sig = createHmac("sha256", getSecret()).update(header).digest();
  return `${header}.${sig.toString("base64url")}`;
}

export type VerifyResult =
  | { ok: true; payload: UploadTokenPayload }
  | { ok: false; reason: "invalid_signature" | "expired" | "malformed" };

export function verifyUploadToken(token: string): VerifyResult {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1 || dotIdx === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }

  const header = token.slice(0, dotIdx);
  const sigPart = token.slice(dotIdx + 1);

  const expectedSig = createHmac("sha256", getSecret()).update(header).digest();

  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigPart, "base64url");
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  if (
    actualSig.length !== expectedSig.length ||
    !timingSafeEqual(actualSig, expectedSig)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as UploadTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
