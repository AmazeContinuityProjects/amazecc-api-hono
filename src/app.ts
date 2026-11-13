/**
 * AmazeCC API - Cloudflare Workers + Queues.
 *
 *   /api/remote/*    VTOP (and LMS/Vitol/directory) scrapers
 *   /api/*           legacy aliases of /api/remote/* (same handlers; cutover paths)
 *   /api/services/*  features built atop remote + the database
 *   /api/admin/*     admin surface (Amaze ID session token, shared D1, per request)
 *   /api/health, /api/status - liveness probes
 */
import { Hono } from "hono";
import { remoteRouter } from "./routes/remote";
import { servicesRouter } from "./routes/services";
import { adminRouter } from "./routes/admin";
import { qbankRouter } from "./routes/qbank";
import { clubAdminRouter } from "./routes/club-admin";
import { publicErrorMessage } from "./lib/publicError";

export const app = new Hono();

// Match the current API's CORS contract byte-for-byte: static clients on
// GitHub Pages call this worker cross-origin, so every response carries the
// wildcard header set (Bearer-token auth only — no credentialed cookies).
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }
  await next();
  for (const [k, v] of Object.entries(corsHeaders())) c.res.headers.set(k, v);
});

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "access-control-allow-headers":
      "Content-Type, Authorization, X-Requested-With, X-CSRF-Token, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version, X-Club-Id",
    "access-control-expose-headers": "Content-Disposition, Content-Length, Content-Type",
    "access-control-max-age": "86400",
  };
}

app.get("/", (c) =>
  c.json({
    name: "amazecc-api",
    status: "ok",
    docs: "/api/remote, /api/services, /api/admin",
  })
);
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/status", (c) => c.json({ text: "API is working" }));

app.route("/api/remote", remoteRouter);
// Legacy alias: /api/login, /api/attendance, ... — same handlers as /api/remote/*.
// Keeps existing clients (AmazeCC web, Kotlin, UniCC failover) working after the cutover.
app.route("/api", remoteRouter);
app.route("/api/services", servicesRouter);
app.route("/api/admin", adminRouter);
app.route("/api/qbank", qbankRouter);
app.route("/api/club-admin", clubAdminRouter);

app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  return c.json({ success: false, error: publicErrorMessage(err) }, 500);
});

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));
