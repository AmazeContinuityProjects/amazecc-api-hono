/**
 * QBank paper storage abstraction.
 *
 * Preferred backend: a native Cloudflare R2 binding (`PAPERS_BUCKET`).
 * Fallback: S3-compatible credentials (B2_* — same names the Next.js API used),
 * so a Backblaze B2 or AWS S3 bucket works without touching code.
 * If neither is configured, callers should answer 503 "storage not configured".
 */
import { getWorkerEnv } from "../env";
import { AwsClient } from "aws4fetch";

export function storageMode(): "r2" | "s3" | null {
  const env = getWorkerEnv();
  if (env.PAPERS_BUCKET) return "r2";
  if (env.B2_REGION && env.B2_ENDPOINT && env.B2_ACCESS_KEY_ID && env.B2_SECRET_ACCESS_KEY && env.B2_BUCKET_NAME) return "s3";
  return null;
}

export function storageUnavailable(): Response {
  return Response.json(
    { success: false, error: "Storage not configured. Bind an R2 bucket as PAPERS_BUCKET, or set B2_REGION/B2_ENDPOINT/B2_ACCESS_KEY_ID/B2_SECRET_ACCESS_KEY/B2_BUCKET_NAME." },
    { status: 503 }
  );
}

/** PUT an object (PDF) under `key`. Returns false when storage is not configured. */
export async function storagePut(key: string, body: ArrayBuffer, contentType: string): Promise<boolean> {
  const env = getWorkerEnv();
  if (env.PAPERS_BUCKET) {
    await env.PAPERS_BUCKET.put(key, body, { httpMetadata: { contentType } });
    return true;
  }
  if (!storageMode()) return false;
  const endpoint = (env.B2_ENDPOINT as string).replace(/\/+$/, "");
  const client = new AwsClient({
    accessKeyId: env.B2_ACCESS_KEY_ID as string,
    secretAccessKey: env.B2_SECRET_ACCESS_KEY as string,
    service: "s3",
    region: env.B2_REGION as string,
  });
  const res = await client.fetch(`${endpoint}/${env.B2_BUCKET_NAME}/${key}`, {
    method: "PUT",
    body,
    headers: { "content-type": contentType },
  });
  if (!res.ok) throw new Error(`storage responded ${res.status}`);
  return true;
}

export interface StoredObject {
  body: ReadableStream | null;
  contentType: string | null;
}

/** GET an object under `key`. Returns null when missing or unconfigured. */
export async function storageGet(key: string): Promise<StoredObject | null> {
  const env = getWorkerEnv();
  if (env.PAPERS_BUCKET) {
    const obj = await env.PAPERS_BUCKET.get(key);
    if (!obj) return null;
    return { body: obj.body, contentType: obj.httpMetadata?.contentType ?? "application/pdf" };
  }
  if (!storageMode()) return null;
  const endpoint = (env.B2_ENDPOINT as string).replace(/\/+$/, "");
  const client = new AwsClient({
    accessKeyId: env.B2_ACCESS_KEY_ID as string,
    secretAccessKey: env.B2_SECRET_ACCESS_KEY as string,
    service: "s3",
    region: env.B2_REGION as string,
  });
  const res = await client.fetch(`${endpoint}/${env.B2_BUCKET_NAME}/${key}`);
  if (!res.ok) return null;
  return { body: res.body, contentType: res.headers.get("content-type") };
}
