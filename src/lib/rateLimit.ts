/**
 * Best-effort, per-isolate rate limiter.
 *
 * Workers are ephemeral and stateless: each isolate keeps its own counters, so
 * limits are per-isolate rather than global. This is intentionally kept (the
 * original code did the same) because the limits here guard a small number of
 * expensive upstream calls (VTOP captcha + login), where some jitter is fine.
 * If strict global limits are ever needed, back this with KV or a Durable
 * Object counter.
 */
import { getWorkerEnv } from "../env";

const hits = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const timestamps = (hits.get(key) ?? []).filter((t) => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0]!;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: windowMs - (now - oldest),
    };
  }

  timestamps.push(now);
  hits.set(key, timestamps);

  return {
    allowed: true,
    remaining: maxRequests - timestamps.length,
    retryAfterMs: windowMs,
  };
}

/** 429 with Retry-After. */
export function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    { success: false, error: "Too many requests. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Limit": "0",
        "X-RateLimit-Remaining": "0",
      },
    }
  );
}

/**
 * Client IP for rate limiting. The FIRST X-Forwarded-For entry is whatever the
 * client sent, so trusting it let anyone dodge every limit by rotating a fake
 * header.
 *  - TRUSTED_IP_HEADER (env) names a header the edge sets itself, e.g.
 *    "cf-connecting-ip" behind Cloudflare. Used first when set.
 *  - Otherwise use the LAST X-Forwarded-For entry: the one appended by the
 *    proxy directly in front of us, not by the client. On Cloudflare,
 *    cf-connecting-ip is available and set by the edge.
 */
export function getClientIp(req: Request): string {
  const h = req.headers;
  const trusted = getWorkerEnv().TRUSTED_IP_HEADER;
  if (trusted) {
    const v = h.get(trusted)?.split(",")[0]?.trim();
    if (v) return v;
  }
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}
