/**
 * Reverse proxy to the legacy API host.
 *
 * Hono answers natively what it implements (remote scrapers, services, admin,
 * club-admin, qbank); this forwards EVERYTHING ELSE that matches /api/* to the
 * traditional server (default https://api.amazecc.com, override with the
 * API_UPSTREAM env var). Mounted after every other router, so native always
 * wins and the proxy only sees unmatched paths.
 *
 * This is the parallel implementation: every endpoint the client calls is
 * reachable through hono.amazecc.com today, and Phase 2 migrates groups from
 * proxied to native one by one without a client change.
 *
 * Notes:
 * - No secrets are logged; bodies are opaque byte streams both ways.
 * - api.amazecc.com can be slow on a VTOP login (captcha) - 120s timeout.
 * - 5xx from upstream is returned as-is (the client's failover triggers on
 *   5xx/timeouts by design); a hard network error surfaces as a 500.
 */
import { Hono } from "hono";

const DEFAULT_UPSTREAM = "https://api.amazecc.com";

const STRIP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ray",
  "cf-worker",
  "cf-ew-via",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);
const STRIP_RESPONSE = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "content-encoding",
]);

export const proxyRouter = new Hono<{ Bindings: { API_UPSTREAM?: string } }>();

// Mounted as `app.route("/api", proxyRouter)`, so the /api prefix is stripped
// before matching - the catch-all must match the remainder ("" and "/anything"),
// not "/api/...".
proxyRouter.all("*", async (c) => {
  const upstreamBase = (c.env?.API_UPSTREAM ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const url = new URL(c.req.raw.url);
  const upstreamUrl = `${upstreamBase}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of c.req.raw.headers) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST.has(lk)) continue;
    if (lk.startsWith("cf-")) continue;
    headers.set(k, v);
  }

  let body: BodyInit | undefined;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    body = await c.req.raw.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.error("[proxy] upstream failed:", err);
    return Response.json(
      { success: false, error: "Upstream API unavailable" },
      { status: 502 }
    );
  }

  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (STRIP_RESPONSE.has(lk)) continue;
    if (lk.startsWith("cf-") || lk.startsWith("x-vercel") || lk.startsWith("x-now") || lk.startsWith("x-powered-by")) continue;
    respHeaders.set(k, v);
  }
  // The body was re-buffered by us - length must describe OUR body.
  const buf = await upstream.arrayBuffer();
  respHeaders.set("content-length", String(buf.byteLength));
  respHeaders.delete("content-encoding");

  return new Response(buf, { status: upstream.status, headers: respHeaders });
});
