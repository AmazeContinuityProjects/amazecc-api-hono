/**
 * AmazeCC API — Cloudflare Workers + Queues.
 *
 *   /api/remote/*    VTOP (and LMS/Vitol/directory) scrapers
 *   /api/services/*  features built atop remote + the database
 *   /api/admin/*     admin surface (HMAC bearer, re-checked per request)
 *   /api/health, /api/status — liveness probes
 */
import { Hono } from "hono";
import { remoteRouter } from "./routes/remote";
import { servicesRouter } from "./routes/services";
import { adminRouter } from "./routes/admin";
import { publicErrorMessage } from "./lib/publicError";

export const app = new Hono();

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
app.route("/api/services", servicesRouter);
app.route("/api/admin", adminRouter);

app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  return c.json({ success: false, error: publicErrorMessage(err) }, 500);
});

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));
