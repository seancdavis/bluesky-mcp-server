import { getStore } from "@netlify/blobs";

const STORE_NAME = "mcp-uploads";

export interface StagedUploadMetadata {
  contentType: string;
  filename: string;
  [k: string]: unknown;
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export async function writeStagedUpload(
  uploadId: string,
  bytes: Uint8Array,
  metadata: StagedUploadMetadata,
): Promise<void> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await store().set(uploadId, buf, { metadata });
}

export interface StagedUpload {
  bytes: Uint8Array;
  metadata: StagedUploadMetadata;
}

export async function readStagedUpload(uploadId: string): Promise<StagedUpload | null> {
  const result = await store().getWithMetadata(uploadId, { type: "arrayBuffer" });
  if (!result) return null;
  return {
    bytes: new Uint8Array(result.data),
    metadata: result.metadata as unknown as StagedUploadMetadata,
  };
}

export async function getStagedUploadMetadata(
  uploadId: string,
): Promise<StagedUploadMetadata | null> {
  const result = await store().getMetadata(uploadId);
  if (!result) return null;
  return result.metadata as unknown as StagedUploadMetadata;
}

export async function deleteStagedUpload(uploadId: string): Promise<void> {
  await store().delete(uploadId);
}
