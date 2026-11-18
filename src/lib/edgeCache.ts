/**
 * Run-at-most-every-N-hours gate backed by the Workers Cache API
 * (`caches.default`, free and outside the D1/KV quotas).
 *
 * For idempotent D1 work that is a no-op once done (e.g. owner-key re-keying),
 * so repeat requests from the same user skip D1 entirely.
 *
 * The cache is per Cloudflare colo and best-effort, and does nothing on
 * *.workers.dev (only on hono.amazecc.com). A miss only costs the D1 work
 * that would have run anyway. Keys are SHA-256 hashed so register numbers
 * never appear in cache URLs.
 */
import { sha256Hex } from "./crypto";

export const HOUR = 60 * 60;

function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
  } catch {
    return null;
  }
}

/**
 * Run `work` unless it already succeeded for this key within `ttlSeconds`.
 * The marker is written only after `work` resolves, so failures are retried.
 * Returns true when the work ran.
 */
export async function throttled(
  namespace: string,
  key: string,
  ttlSeconds: number,
  work: () => Promise<void>,
): Promise<boolean> {
  const store = edgeCache();
  const request = new Request(`https://edge-gate.internal/${namespace}/${await sha256Hex(key)}`);
  if (store) {
    try {
      if (await store.match(request)) return false;
    } catch {
      // treat as a miss
    }
  }
  await work();
  if (store) {
    try {
      await store.put(request, new Response("1", {
        headers: { "Cache-Control": `max-age=${Math.max(1, Math.floor(ttlSeconds))}` },
      }));
    } catch {
      // best-effort
    }
  }
  return true;
}
