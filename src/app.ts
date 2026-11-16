/**
 * AmazeCC API - Cloudflare Workers.
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
import { cabshareRouter } from "./routes/services/cabshare";
import { socialRouter } from "./routes/services/social";
import { profileRouter } from "./routes/services/profile";
import { guardRequest } from "./lib/guard";
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
      "Content-Type, Authorization, DPoP, X-Requested-With, X-CSRF-Token, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version, X-Club-Id",
    "access-control-expose-headers": "Content-Disposition, Content-Length, Content-Type",
    "access-control-max-age": "86400",
  };
}

app.get("/", (c) => c.redirect("https://docs.amazecc.com/amazecc-api", 302));
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.get("/api/status", (c) => c.json({ text: "API is working" }));

// First-party service guard - runs before routers/proxy.
// Anonymous → 401; section RBAC where it applies.
app.use("/api/*", async (c, next) => {
  const blocked = await guardRequest(c.req.raw);
  if (blocked) return blocked;
  await next();
});

app.route("/api/remote", remoteRouter);
// Legacy alias: /api/login, /api/attendance, ... — same handlers as /api/remote/*.
// Keeps existing clients (AmazeCC web, Kotlin, UniCC failover) working after the cutover.
app.route("/api", remoteRouter);
app.route("/api/services", servicesRouter);
app.route("/api/admin", adminRouter);
app.route("/api/qbank", qbankRouter);
app.route("/api/club-admin", clubAdminRouter);
app.route("/api/cabshare", cabshareRouter);
app.route("/api/social", socialRouter);
app.route("/api/profile", profileRouter);

app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  return c.json({ success: false, error: publicErrorMessage(err) }, 500);
});

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));
