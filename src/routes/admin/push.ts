/**
 * POST /api/admin/push — broadcast a web-push notification to every stored
 * subscription. VAPID signing and aes128gcm content encryption run on
 * WebCrypto (see lib/webpush.ts) — no Node crypto/https needed. Subscriptions
 * that answer 404/410 are pruned.
 */
import { Hono } from "hono";
import { getDbPool } from "../../lib/db";
import { requireSection } from"../../lib/auth";
import { sendWebPush, PushError } from "../../lib/webpush";
import { hasAdminPermission } from "../../lib/auth";

export const pushRoute = new Hono();

pushRoute.post("/push", async (c) => {
  const auth = await requireSection('push')(c.req.raw);
  if (auth instanceof Response) return auth;
  if (!hasAdminPermission(auth, "push")) {
    return Response.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string };
    const { title, body: message } = body;

    if (!title || !message) {
      return Response.json({ error: "Missing title or body" }, { status: 400 });
    }

    const pool = getDbPool();
    const { rows } = await pool.query(`SELECT endpoint, p256dh, auth FROM push_subscriptions`);

    if (rows.length === 0) {
      return Response.json({ success: true, message: "No subscribers found." });
    }

    const payload = JSON.stringify({
      title,
      body: message,
      icon: "/icon.png",
    });

    const results = await Promise.allSettled(
      rows.map(async (row) => {
        const sub = {
          endpoint: row.endpoint as string,
          p256dh: row.p256dh as string,
          auth: row.auth as string,
        };
        try {
          await sendWebPush(sub, payload);
        } catch (err) {
          if (err instanceof PushError && (err.statusCode === 410 || err.statusCode === 404)) {
            await pool
              .query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint])
              .catch((cleanupErr) => console.error("Failed to prune dead subscription:", cleanupErr));
          }
          console.error("Failed to send to endpoint", sub.endpoint, err);
          throw err;
        }
      })
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    return Response.json({
      success: true,
      message: `Broadcast triggered for ${rows.length} users (${sent} delivered).`,
    });
  } catch (error) {
    console.error("Broadcast error:", error);
    return Response.json({ error: "Failed to send broadcast" }, { status: 500 });
  }
});
